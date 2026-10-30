import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { requireCapacity } from '../../src/server/subscriptions/access.ts'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { ZodError } from 'zod'
import { SignJWT } from 'jose'
import { prisma } from '../../src/server/db.ts'
import { createOrganization } from '../../src/server/organizations/organization-service.ts'
import { saveLocation, assignLocationMember, transferMember } from '../../src/server/organizations/location-service.ts'
import { createCodeInvitation, acceptCodeInvitation } from '../../src/server/organizations/invitation-service.ts'
import { saveAccessRole, listAccessRoles, saveMemberAccess } from '../../src/server/organizations/access/access-service.ts'
import { buildReport } from '../../src/server/schedule/reports/report-service.ts'
import { commentOnDraft, getDemand, getDraft, respondToDraft } from '../../src/server/schedule/planning/team-planning-service.ts'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'
import { effectiveSubscription, nextMonth, plans } from '../../src/app/subscriptions/plans.ts'
import { validateDemoCard } from '../../src/app/subscriptions/demo-card.ts'
import { activateTestPurchase, cancelScheduledChange, createCheckout, selectFreePlan, startBusinessTrial, subscriptionDetails } from '../../src/server/subscriptions/service.ts'
import subscriptionRouter, { subscriptionWritePolicy } from '../../src/server/subscriptions/routes.ts'
import { requireAuth } from '../../src/server/auth.ts'
import { listNotificationHistory, updateAllNotifications } from '../../src/server/organizations/notification-service.ts'
import { syncSubscriptionNotices } from '../../src/server/subscriptions/notifications.ts'
import { takeFreshNotifications } from '../../src/app/organizations/floating-notifications.ts'
import { stageStoredFile } from '../../src/server/storage/image-service.ts'
const suffix = randomUUID(), people: Array<{ id: string; email: string }> = []
const code = (value: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === value
const location = { name: 'Вторая точка', city: 'Москва', address: 'Тестовая улица, 1', timezone: 'Europe/Moscow' as const, teamNames: [] }
const org = async (initialPlan: 'FREE' | 'TRIAL' = 'FREE') => createOrganization(people[0].id, { name: 'Subscription fixture', description: null, timezone: 'Europe/Moscow', initialPlan })
const pay = async (id: string, plan: 'TEAM' | 'BUSINESS') => { const order = await createCheckout(people[0].id, id, plan); return activateTestPurchase(people[0].id, id, order.id, people[0].email) }
before(async () => { for (let i = 0; i < 9; i++) people.push(await prisma.user.create({ data: { email: `subscription-${suffix}-${i}@example.test`, passwordHash: 'fixture-only', emailVerifiedAt: new Date() } })) })
after(() => prisma.$disconnect())
it('uses the agreed quotas and calendar months and derives trial, grace and expiry without worker timing', () => {
  assert.equal(plans.TEAM.storageBytes, 2 * 1024 ** 3); assert.equal(plans.BUSINESS.storageBytes, 10 * 1024 ** 3)
  assert.deepEqual(Object.values(plans).map(plan => plan.members), [5, 25, 100])
  assert.equal(nextMonth(new Date('2028-01-31T12:34:00Z')).toISOString(), '2028-02-29T12:34:00.000Z')
  const record = { plan: 'BUSINESS', periodStart: new Date('2026-01-01Z'), periodEnd: new Date('2026-01-15Z'), trialEndsAt: new Date('2026-01-15Z'), nextPlan: null, nextStartsAt: null, nextEndsAt: null }
  assert.equal(effectiveSubscription(record, new Date('2026-01-10Z')).phase, 'trial')
  assert.equal(effectiveSubscription(record, new Date('2026-01-16Z')).phase, 'grace')
  assert.equal(effectiveSubscription(record, new Date('2026-01-23Z')).readOnly, true)
  assert.equal(effectiveSubscription(record, new Date('2026-01-23Z')).effectivePlan, 'FREE')
  assert.equal(effectiveSubscription({ ...record, nextPlan: 'TEAM', nextStartsAt: new Date('2026-01-15Z'), nextEndsAt: new Date('2026-02-15Z') }, new Date('2026-01-23Z')).effectivePlan, 'TEAM')
})
it('validates synthetic cards, expiry, CVC, holder, email and consent locally', () => {
  const fields = { number: '4242 4242 4242 4242', expiry: '12 / 29', cvc: '123', holder: 'TEST USER', email: 'demo@example.test', confirm: true }
  assert.deepEqual(validateDemoCard(fields, new Date('2026-10-30')), {})
  for (const patch of [{ number: '4242424242424241' }, { number: '4111111111111111' }, { expiry: '12 / 25' }, { expiry: '13 / 29' }, { cvc: 'ab1' }, { email: 'bad' }, { holder: 'Ярослав' }, { confirm: false }]) assert.ok(Object.keys(validateDemoCard({ ...fields, ...patch }, new Date('2026-10-30'))).length)
})
it('creates an explicit Free organization and a separate trial without granting other tenants a paid plan', async () => {
  const a = await org(), b = await org('TRIAL')
  assert.equal((await subscriptionDetails(people[0].id, a.id)).subscription.effectivePlan, 'FREE')
  assert.equal((await subscriptionDetails(people[0].id, b.id)).subscription.phase, 'trial')
  const first = await createCheckout(people[0].id, a.id, 'TEAM')
  assert.equal(first.amountMinor, 99000)
  const second = await createCheckout(people[0].id, a.id, 'TEAM'); assert.equal(second.id, first.id)
  await assert.rejects(activateTestPurchase(people[0].id, b.id, first.id, people[0].email), code('SUBSCRIPTION_ORDER_NOT_FOUND'))
  const results = await Promise.all([activateTestPurchase(people[0].id, a.id, first.id, people[0].email), activateTestPurchase(people[0].id, a.id, first.id, people[0].email)])
  assert.equal(results[0].subscription.validUntil, results[1].subscription.validUntil)
  assert.equal(await prisma.subscriptionPurchase.count({ where: { organizationId: a.id, status: 'SUCCEEDED' } }), 1)
  assert.equal((await subscriptionDetails(people[0].id, a.id)).subscription.effectivePlan, 'TEAM')
  assert.equal((await subscriptionDetails(people[0].id, b.id)).subscription.phase, 'trial')
  assert.equal(Number((await prisma.organizationResourceBudget.findUniqueOrThrow({ where: { organizationId: a.id } })).storageLimitBytes), plans.TEAM.storageBytes)
})
it('enforces ownership and ordinary permissions before a paid-feature offer', async () => {
  const a = await org()
  await prisma.organizationMember.create({ data: { organizationId: a.id, userId: people[1].id } })
  await assert.rejects(createCheckout(people[1].id, a.id, 'BUSINESS'), code('OWNER_REQUIRED'))
  await assert.rejects(createCheckout(people[8].id, a.id, 'BUSINESS'), code('ORGANIZATION_NOT_FOUND'))
  const input = { from: '2026-10-01', to: '2026-10-31', locationIds: [a.locationId], memberIds: [], includeFormer: false, config: defaultReportConfig() }
  await assert.rejects(buildReport(people[1].id, a.id, input), code('INSUFFICIENT_PERMISSIONS'))
  await assert.rejects(buildReport(people[0].id, a.id, input), code('SUBSCRIPTION_FEATURE_REQUIRED'))
  await assert.rejects(saveAccessRole(people[0].id, a.id, null, { name: 'Своя роль', description: '', permissions: [] }), code('SUBSCRIPTION_FEATURE_REQUIRED'))
  const standard = (await listAccessRoles(people[0].id, a.id)).roles.find(role => role.systemCode === 'ADMIN')!
  await saveAccessRole(people[0].id, a.id, standard.id, { name: standard.name, description: '', permissions: standard.permissions as any, revision: standard.revision })
  await pay(a.id, 'TEAM'); assert.equal((await buildReport(people[0].id, a.id, input)).config.sheets.length, 4)
  await assert.rejects(getDemand(people[0].id, a.id), code('SUBSCRIPTION_FEATURE_REQUIRED'))
  await pay(a.id, 'BUSINESS'); await getDemand(people[0].id, a.id)
  await saveAccessRole(people[0].id, a.id, null, { name: 'Своя роль', description: '', permissions: [] })
})
it('serializes concurrent invitation acceptance at the last seat and does not consume a rejected invitation', async () => {
  const a = await org()
  for (const person of people.slice(1, 4)) await prisma.organizationMember.create({ data: { organizationId: a.id, userId: person.id } })
  const invitations = await Promise.all([createCodeInvitation(people[0].id, a.id), createCodeInvitation(people[0].id, a.id)])
  const result = await Promise.allSettled(invitations.map((invite, i) => acceptCodeInvitation(people[4 + i].id, people[4 + i].email, invite.code)))
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = result.find(item => item.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && code('SUBSCRIPTION_LIMIT_REACHED')(rejected.reason))
  assert.equal(await prisma.organizationMember.count({ where: { organizationId: a.id, leftAt: null } }), 5)
  assert.equal(await prisma.organizationInvite.count({ where: { organizationId: a.id, acceptedAt: null } }), 1)
})
it('enforces location limits, rejects over-cap downgrades and keeps pending changes until their boundary', async () => {
  const a = await org()
  await assert.rejects(saveLocation(people[0].id, a.id, null, location), code('SUBSCRIPTION_LIMIT_REACHED'))
  await pay(a.id, 'TEAM')
  await saveLocation(people[0].id, a.id, null, location); await saveLocation(people[0].id, a.id, null, location)
  await assert.rejects(saveLocation(people[0].id, a.id, null, location), code('SUBSCRIPTION_LIMIT_REACHED'))
  await assert.rejects(selectFreePlan(people[0].id, a.id, false), code('SUBSCRIPTION_DOWNGRADE_LIMIT'))
  const b = await org(); await pay(b.id, 'TEAM')
  const scheduled = await selectFreePlan(people[0].id, b.id, false)
  assert.equal(scheduled.effectivePlan, 'TEAM'); assert.equal(scheduled.scheduled?.plan, 'FREE')
  await cancelScheduledChange(people[0].id, b.id); assert.equal((await subscriptionDetails(people[0].id, b.id)).subscription.scheduled, null)
  const original = (await subscriptionDetails(people[0].id, b.id)).subscription.validUntil!
  const renewal = await pay(b.id, 'TEAM'); assert.ok(renewal.subscription.validUntil! > original)
  const c = await org(); await pay(c.id, 'BUSINESS'); await pay(c.id, 'TEAM')
  await assert.rejects(selectFreePlan(people[0].id, c.id, false), code('SUBSCRIPTION_CHANGE_PAID'))
  assert.equal((await subscriptionDetails(people[0].id, c.id)).subscription.scheduled?.plan, 'TEAM')
})
it('blocks discussion writes after a downgrade and checks participant permissions first', async () => {
  const a = await org()
  const member = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: a.id, userId: people[0].id } })
  const draft = await prisma.scheduleDraft.create({ data: { organizationId: a.id, locationId: a.locationId, authorMemberId: member.id, title: 'Existing discussion', fromDate: new Date('2026-10-01Z'), toDate: new Date('2026-10-31Z'), timezone: 'Europe/Moscow', status: 'OPEN', publishedAt: new Date(), deadline: new Date(Date.now() + 86400000) } })
  await assert.rejects(respondToDraft(people[0].id, a.id, draft.id, { revision: 1, response: 'NO_OBJECTIONS' }), code('NOT_A_PARTICIPANT'))
  await prisma.draftRecipient.create({ data: { organizationId: a.id, draftId: draft.id, memberId: member.id, requiredRevision: 1 } })
  await assert.rejects(respondToDraft(people[0].id, a.id, draft.id, { revision: 1, response: 'NO_OBJECTIONS' }), code('SUBSCRIPTION_FEATURE_REQUIRED'))
  await assert.rejects(commentOnDraft(people[0].id, a.id, draft.id, { revision: 1, text: 'Тестовое замечание' }), code('SUBSCRIPTION_FEATURE_REQUIRED'))
  assert.equal(await prisma.draftComment.count({ where: { draftId: draft.id } }), 0)
  const participant = await prisma.organizationMember.create({ data: { organizationId: a.id, userId: people[1].id } })
  await prisma.locationMember.create({ data: { organizationId: a.id, locationId: a.locationId, memberId: participant.id } })
  await prisma.draftRecipient.create({ data: { organizationId: a.id, draftId: draft.id, memberId: participant.id, requiredRevision: 1 } })
  await assert.rejects(getDraft(people[1].id, a.id, draft.id), code('SUBSCRIPTION_FEATURE_REQUIRED'))
  await pay(a.id, 'BUSINESS')
  assert.equal((await getDraft(people[1].id, a.id, draft.id)).canManage, false)
})
it('binds quotes to revision and expiry and enforces expired storage quotas even before worker cleanup', async () => {
  const a = await org(), order = await createCheckout(people[0].id, a.id, 'TEAM')
  await prisma.subscriptionPurchase.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 1) } })
  await assert.rejects(activateTestPurchase(people[0].id, a.id, order.id, people[0].email), code('SUBSCRIPTION_ORDER_EXPIRED'))
  const team = await createCheckout(people[0].id, a.id, 'TEAM'), business = await createCheckout(people[0].id, a.id, 'BUSINESS')
  await activateTestPurchase(people[0].id, a.id, business.id, people[0].email)
  await assert.rejects(activateTestPurchase(people[0].id, a.id, team.id, people[0].email), code('SUBSCRIPTION_ORDER_EXPIRED'))
  await prisma.organizationSubscription.update({ where: { organizationId: a.id }, data: { periodStart: new Date(Date.now() - 40 * 86400000), periodEnd: new Date(Date.now() - 8 * 86400000) } })
  assert.equal((await subscriptionDetails(people[0].id, a.id)).subscription.readOnly, true)
  await prisma.organizationResourceBudget.update({ where: { organizationId: a.id }, data: { storageBytes: BigInt(plans.FREE.storageBytes) } })
  await assert.rejects(stageStoredFile({ objectKey: `organizations/${a.id}/documents/${randomUUID()}.txt`, purpose: 'DOCUMENT', uploadedByUserId: people[0].id, organizationId: a.id, size: 1, mimeType: 'text/plain', checksumSha256: '0'.repeat(64) }, Buffer.alloc(1)), code('ORGANIZATION_STORAGE_QUOTA'))
})
it('accepts only the safe test-activation body and leaves billing and reads accessible after expiry', async () => {
  const a = await org(), order = await createCheckout(people[0].id, a.id, 'TEAM')
  const session = await prisma.authSession.create({ data: { userId: people[0].id, refreshTokenHash: randomUUID(), idleExpiresAt: new Date(Date.now() + 60000), absoluteExpiresAt: new Date(Date.now() + 60000) } })
  const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(people[0].id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET!))
  const app = express(); app.use(express.json()); app.use('/api/organizations/:organizationId', requireAuth, subscriptionWritePolicy)
  app.use('/api', subscriptionRouter); app.post('/api/organizations/:organizationId/example', (_q, s) => s.json({ changed: true }))
  app.use((e: any, _q: any, s: any, _n: any) => s.status(e instanceof ZodError ? 400 : e.status ?? 500).json({ code: e.code }))
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/organizations/${a.id}`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body = { email: people[0].email, confirm: true, mode: 'test' }
  try {
    assert.equal((await fetch(`${base}/subscription/purchases/${order.id}/test-activation`, { method: 'POST', headers, body: JSON.stringify({ ...body, cardNumber: '4242424242424242', cvc: '123' }) })).status, 400)
    assert.equal((await fetch(`${base}/subscription/purchases/${order.id}/test-activation`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200)
    await prisma.organizationSubscription.update({ where: { organizationId: a.id }, data: { periodStart: new Date(Date.now() - 40 * 86400000), periodEnd: new Date(Date.now() - 8 * 86400000) } })
    assert.equal((await fetch(`${base}/example`, { method: 'POST', headers, body: '{}' })).status, 403)
    assert.equal((await fetch(`${base}/subscription`, { headers })).status, 200)
    assert.equal((await fetch(`${base}/subscription/checkout`, { method: 'POST', headers, body: JSON.stringify({ plan: 'BUSINESS' }) })).status, 201)
    const stored = await prisma.subscriptionPurchase.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(stored.email, people[0].email); assert.ok(!('cardNumber' in stored)); assert.ok(!('cvc' in stored))
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

it('starts each organization on Free and grants a manual trial once, including concurrent requests', async () => {
  const a = await createOrganization(people[0].id, { name: 'Manual trial', description: null, timezone: 'Europe/Moscow' }), b = await org()
  const before = (await subscriptionDetails(people[0].id, a.id)).subscription
  assert.equal(before.phase, 'free'); assert.equal(before.trialAvailable, true)
  await prisma.organizationMember.create({ data: { organizationId: a.id, userId: people[1].id } })
  await assert.rejects(startBusinessTrial(people[1].id, a.id), code('OWNER_REQUIRED'))
  const result = await Promise.allSettled([startBusinessTrial(people[0].id, a.id), startBusinessTrial(people[0].id, a.id)])
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1)
  assert.ok(result.some(item => item.status === 'rejected' && code('SUBSCRIPTION_TRIAL_USED')(item.reason)))
  const trial = (await subscriptionDetails(people[0].id, a.id)).subscription
  assert.equal(trial.phase, 'trial'); assert.equal(trial.trialAvailable, false)
  assert.equal((await subscriptionDetails(people[0].id, b.id)).subscription.phase, 'free')
  await selectFreePlan(people[0].id, a.id, true)
  await assert.rejects(startBusinessTrial(people[0].id, a.id), code('SUBSCRIPTION_TRIAL_USED'))
  await pay(b.id, 'TEAM')
  await assert.rejects(startBusinessTrial(people[0].id, b.id), code('SUBSCRIPTION_TRIAL_UNAVAILABLE'))
})
it('delivers subscription notices only to the current owner and keeps dismissed notices dismissed', async () => {
  const a = await org()
  await prisma.organizationMember.create({ data: { organizationId: a.id, userId: people[1].id } })
  await startBusinessTrial(people[0].id, a.id)
  const history = () => listNotificationHistory(people[0].id, people[0].email, { organizationId: a.id, limit: 50 })
  const first = (await history()).notifications.filter(item => item.type === 'SUBSCRIPTION_STATUS')
  assert.equal(first.length, 1); assert.equal(first[0].href, `/app/organizations/${a.id}/settings?section=subscription`)
  assert.deepEqual(takeFreshNotifications(first as any, new Set()), [])
  assert.equal((await listNotificationHistory(people[1].id, people[1].email, { organizationId: a.id, limit: 50 })).notifications.length, 0)
  await updateAllNotifications(people[0].id, people[0].email, { organizationId: a.id }, first[0].id)
  await syncSubscriptionNotices(people[0].id, a.id, undefined, true)
  assert.equal((await history()).notifications.length, 0)
  assert.equal(await prisma.accountNotification.count({ where: { organizationId: a.id, type: 'SUBSCRIPTION_STATUS' } }), 1)
  // A notification accidentally addressed to an employee is still blocked by SQL policy.
  await prisma.accountNotification.create({ data: { userId: people[1].id, organizationId: a.id, type: 'SUBSCRIPTION_STATUS', title: 'Private billing', message: 'Owner only', emailAttemptedAt: new Date() } })
  assert.equal((await listNotificationHistory(people[1].id, people[1].email, { organizationId: a.id, limit: 50 })).notifications.length, 0)
  await prisma.$transaction([prisma.organizationMember.updateMany({ where: { organizationId: a.id, userId: people[0].id }, data: { role: 'MEMBER' } }), prisma.organizationMember.updateMany({ where: { organizationId: a.id, userId: people[1].id }, data: { role: 'OWNER' } })])
  await syncSubscriptionNotices(people[1].id, a.id, undefined, true)
  assert.equal((await history()).notifications.length, 0)
  assert.ok((await listNotificationHistory(people[1].id, people[1].email, { organizationId: a.id, limit: 50 })).notifications.some(item => item.type === 'SUBSCRIPTION_STATUS'))
})
it('creates one expiry reminder per phase even when several workers run', async () => {
  const a = await org(); await startBusinessTrial(people[0].id, a.id)
  await prisma.organizationSubscription.update({ where: { organizationId: a.id }, data: { periodStart: new Date(Date.now() - 40 * 86400000), periodEnd: new Date(Date.now() - 8 * 86400000), trialEndsAt: new Date(Date.now() - 8 * 86400000) } })
  await Promise.all([syncSubscriptionNotices(people[0].id, a.id), syncSubscriptionNotices(people[0].id, a.id)])
  const history = await listNotificationHistory(people[0].id, people[0].email, { organizationId: a.id, limit: 50, unread: true })
  assert.equal(history.notifications.length, 1); assert.equal(history.notifications[0].title, 'Подписка завершилась')
})

it('blocks new staffing, transfers, invitations and access on legacy extra locations while preserving existing members', async () => {
  const a = await org(); await pay(a.id, 'BUSINESS')
  const second = await saveLocation(people[0].id, a.id, null, location)
  const member = await prisma.organizationMember.create({ data: { organizationId: a.id, userId: people[1].id } })
  await assignLocationMember(people[0].id, a.id, a.locationId, member.id)
  const before = await locationContext.run({ organizationId: a.id, locationId: second.id }, () => createCodeInvitation(people[0].id, a.id))
  await prisma.organizationSubscription.update({ where: { organizationId: a.id }, data: { plan: 'FREE', periodEnd: null, trialEndsAt: null } })
  await assert.rejects(assignLocationMember(people[1].id, a.id, second.id, member.id), code('INSUFFICIENT_PERMISSIONS'))
  await assert.rejects(assignLocationMember(people[0].id, a.id, second.id, member.id), code('SUBSCRIPTION_LIMIT_REACHED'))
  await assignLocationMember(people[0].id, a.id, a.locationId, member.id)
  await assert.rejects(transferMember(people[0].id, a.id, { memberId: member.id, fromLocationId: a.locationId, toLocationId: second.id, temporary: false }), code('SUBSCRIPTION_LIMIT_REACHED'))
  await assert.rejects(locationContext.run({ organizationId: a.id, locationId: second.id }, () => createCodeInvitation(people[0].id, a.id)), code('SUBSCRIPTION_LIMIT_REACHED'))
  await assert.rejects(acceptCodeInvitation(people[1].id, people[1].email, before.code), code('SUBSCRIPTION_LIMIT_REACHED'))
  const standard = (await listAccessRoles(people[0].id, a.id)).roles.find(role => role.systemCode === 'MEMBER')!
  await assert.rejects(saveMemberAccess(people[0].id, a.id, member.id, { organizationRoleId: null, assignments: [{ locationId: second.id, roleId: standard.id }] }), code('SUBSCRIPTION_LIMIT_REACHED'))
  assert.equal(await prisma.locationMember.count({ where: { organizationId: a.id, memberId: member.id, locationId: second.id, leftAt: null } }), 0)
  await pay(a.id, 'TEAM')
  await assignLocationMember(people[0].id, a.id, second.id, member.id)
  await prisma.organizationSubscription.update({ where: { organizationId: a.id }, data: { plan: 'FREE', periodEnd: null } })
  await assignLocationMember(people[0].id, a.id, second.id, member.id)
  assert.equal(await prisma.locationMember.count({ where: { organizationId: a.id, memberId: member.id, leftAt: null } }), 2)
})
it('enforces each tier member and location caps on the server, including Business maximum', async () => {
  for (const plan of ['FREE', 'TEAM', 'BUSINESS'] as const) {
    const a = await org()
    await prisma.organizationSubscription.update({ where: { organizationId: a.id }, data: { plan, periodEnd: plan === 'FREE' ? null : new Date(Date.now() + 86400000) } })
    const capacity = plans[plan]
    for (let i = 1; i < capacity.members; i++) {
      const user = await prisma.user.create({ data: { email: `tier-${suffix}-${plan.toLowerCase()}-${i}@example.test`, emailVerifiedAt: new Date() } })
      await prisma.organizationMember.create({ data: { organizationId: a.id, userId: user.id } })
    }
    await prisma.$transaction(tx => requireCapacity(tx, a.id, 'members', 0))
    await assert.rejects(prisma.$transaction(tx => requireCapacity(tx, a.id, 'members')), code('SUBSCRIPTION_LIMIT_REACHED'))
    for (let i = 1; i < capacity.locations; i++) await saveLocation(people[0].id, a.id, null, { ...location, name: `Point ${i}` })
    await assert.rejects(saveLocation(people[0].id, a.id, null, location), code('SUBSCRIPTION_LIMIT_REACHED'))
  }
})

it('does not let an existing member accept another point invitation after subscription expiry', async () => {
  const a = await org(); await pay(a.id, 'BUSINESS')
  const second = await saveLocation(people[0].id, a.id, null, location)
  const target = await prisma.organizationMember.create({ data: { organizationId: a.id, userId: people[1].id } })
  await assignLocationMember(people[0].id, a.id, a.locationId, target.id)
  const invite = await locationContext.run({ organizationId: a.id, locationId: second.id }, () => createCodeInvitation(people[0].id, a.id))
  await prisma.organizationSubscription.update({ where: { organizationId: a.id }, data: { periodStart: new Date(Date.now()-40*86400000), periodEnd: new Date(Date.now()-10*86400000) } })
  await assert.rejects(acceptCodeInvitation(people[1].id, people[1].email, invite.code), code('SUBSCRIPTION_EXPIRED'))
  assert.equal(await prisma.locationMember.count({ where: { memberId: target.id, locationId: second.id } }), 0)
  assert.equal(await prisma.organizationInvite.count({ where: { organizationId: a.id, acceptedAt: null } }), 1)
})
