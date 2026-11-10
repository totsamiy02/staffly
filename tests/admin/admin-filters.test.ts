import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma, databasePool } from '../../src/server/db.ts'
import { monitoringOrganizations, monitoringAnalytics } from '../../src/server/admin/monitoring.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { plans } from '../../src/app/subscriptions/plans.ts'
const organizations: string[] = []
after(async () => { await prisma.organization.updateMany({ where: { id: { in: organizations } }, data: { deletedAt: new Date() } }); await prisma.$disconnect() })
async function fixture() {
  const owner = await prisma.user.create({ data: { email: `filter-${randomUUID()}@example.test`, firstName: 'Проверка', emailVerifiedAt: new Date() } })
  const org = await createBusinessOrganization(owner.id, { name: 'Filter ' + randomUUID(), description: null, timezone: 'Europe/Moscow' })
  organizations.push(org.id)
  await prisma.organizationLocation.updateMany({ where: { organizationId: org.id }, data: { archivedAt: new Date() } })
  return { org, owner }
}
test('attention handles an empty result and every plan/resource immediately below, at and above 80 percent', async () => {
  assert.equal((await monitoringOrganizations({ status: 'attention', search: randomUUID() })).total, 0)
  for (const plan of Object.values(plans)) {
    const { org, owner } = await fixture()
    await prisma.organizationSubscription.update({ where: { organizationId: org.id }, data: { plan: plan.id, trialEndsAt: null, periodEnd: new Date(Date.now() + 30 * 86400000) } })
    const memberCount = Math.ceil(plan.members * .8), locationCount = Math.ceil(plan.locations * .8)
    const people = Array.from({ length: memberCount }, () => ({ id: randomUUID(), email: `member-${randomUUID()}@example.test`, firstName: 'Участник' }))
    await prisma.user.createMany({ data: people })
    await prisma.organizationMember.createMany({ data: people.map(user => ({ organizationId: org.id, userId: user.id, joinedAt: new Date(Date.now()-86400000), leftAt: new Date() })) })
    const locations = Array.from({ length: locationCount + 1 }, (_, i) => ({ id: randomUUID(), organizationId: org.id, name: 'Точка ' + i, city: '', address: '', timezone: 'Europe/Moscow', archivedAt: new Date() }))
    await prisma.organizationLocation.createMany({ data: locations })
    for (const resource of ['members', 'locations', 'storageBytes'] as const) {
      const boundary = Math.ceil(plan[resource] * .8)
      for (const count of [boundary - 1, boundary, boundary + 1]) {
        await prisma.organizationMember.updateMany({ where: { organizationId: org.id, userId: { not: owner.id } }, data: { leftAt: new Date() } })
        await prisma.organizationLocation.updateMany({ where: { organizationId: org.id }, data: { archivedAt: new Date() } })
        await databasePool.query('UPDATE organization_resource_budgets SET storage_bytes=0 WHERE organization_id=$1', [org.id])
        if (resource === 'members') await prisma.organizationMember.updateMany({ where: { organizationId: org.id, userId: { in: people.slice(0, count - 1).map(user => user.id) } }, data: { leftAt: null } })
        if (resource === 'locations') await prisma.organizationLocation.updateMany({ where: { id: { in: locations.slice(0, count).map(location => location.id) } }, data: { archivedAt: null } })
        if (resource === 'storageBytes') await databasePool.query('UPDATE organization_resource_budgets SET storage_bytes=$2 WHERE organization_id=$1', [org.id, count])
        const found = await monitoringOrganizations({ status: 'attention', search: org.name, plan: plan.id })
        assert.equal(found.total, count >= boundary ? 1 : 0, `${plan.id}/${resource}/${count}`)
        if (found.items[0]) { assert.equal(found.items[0].subscription.effectivePlan, plan.id); assert.equal(found.items[0].attention, true) }
      }
    }
  }
})
test('attention uses effective plans after trial, grace, expiry and scheduled transitions', async () => {
  const { org } = await fixture(), future = new Date(Date.now() + 30 * 86400000), past = new Date(Date.now() - 30 * 86400000)
  await databasePool.query('UPDATE organization_resource_budgets SET storage_bytes=$2 WHERE organization_id=$1', [org.id, 210 * 1024 * 1024])
  const cases = [
    { data: { plan: 'BUSINESS', periodEnd: future }, effective: 'BUSINESS', attention: false },
    { data: { plan: 'BUSINESS', periodEnd: past, trialEndsAt: future }, effective: 'BUSINESS', attention: false },
    { data: { plan: 'BUSINESS', periodEnd: new Date(Date.now() - 2 * 86400000) }, effective: 'BUSINESS', attention: false },
    { data: { plan: 'BUSINESS', periodEnd: past }, effective: 'FREE', attention: true },
    { data: { plan: 'BUSINESS', periodEnd: future, nextPlan: 'FREE', nextStartsAt: past }, effective: 'FREE', attention: true },
    { data: { plan: 'FREE', nextPlan: 'TEAM', nextStartsAt: past, nextEndsAt: future }, effective: 'TEAM', attention: false },
    { data: { plan: 'FREE', nextPlan: 'BUSINESS', nextStartsAt: future, nextEndsAt: new Date(Date.now()+60*86400000) }, effective: 'FREE', attention: true },
  ]
  for (const item of cases) {
    await prisma.organizationSubscription.update({ where: { organizationId: org.id }, data: { trialEndsAt: null, periodStart: new Date(Date.now()-60*86400000), periodEnd: null, nextPlan: null, nextStartsAt: null, nextEndsAt: null, ...item.data } })
    const all = await monitoringOrganizations({ search: org.name, plan: item.effective })
    assert.equal(all.total, 1); assert.equal(all.items[0].subscription.effectivePlan, item.effective)
    assert.equal((await monitoringOrganizations({ search: org.name, status: 'attention' })).total, item.attention ? 1 : 0)
  }
  const analytics = await monitoringAnalytics({ days: 30 })
  assert(analytics.lifetimeStartedAt); assert(analytics.cohorts.every(row => 'state' in row && 'total' in row))
})
