import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { getVacationBalance, setupVacationBalance, changeVacationBalance, listVacationBalances, balanceListQuery, vacationBalanceHistory } from '../../src/server/requests/vacation-balances.ts'
import { changeAbsence } from '../../src/server/schedule/absence-service.ts'
import { createRequest, resolveRequest, amendVacation, listRequestTypes } from '../../src/server/requests/service.ts'
import { saveAccessRole, saveMemberAccess } from '../../src/server/organizations/access/access-service.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { normalizePermissions } from '../../src/app/access/catalog.ts'
import { addVacationDays, vacationMonthDate } from '../../src/shared/vacation-balance.ts'
let org: string, point: string, owner: string, employee: string, member: string, admin: string, adminMember: string
const code = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected
const setup = () => ({ submissionKey: randomUUID(), employmentStartDate: '2025-01-01', reason: 'По данным кадровой службы' })
before(async () => {
  const makeUser = async () => (await prisma.user.create({ data: { email: `vacation-${randomUUID()}@example.test`, passwordHash: 'test', emailVerifiedAt: new Date() } })).id
  owner = await makeUser()
  employee = await makeUser()
  admin = await makeUser()
  const organization = await createBusinessOrganization(owner, { name: 'Остатки отпусков', description: null, timezone: 'Europe/Moscow' })
  org = organization.id
  point = (await getMembership(owner, org)).locationId
  for (const [userId, role] of [[employee, 'MEMBER'], [admin, 'ADMIN']] as const) {
    const record = await prisma.organizationMember.create({ data: { organizationId: org, userId, role } })
    await prisma.locationMember.create({ data: { organizationId: org, locationId: point, memberId: record.id, role } })
    if (userId === employee) member = record.id
    else adminMember = record.id
  }
})
after(async () => {
  if (org) {
    await prisma.accountNotification.deleteMany({ where: { organizationId: org } })
    await prisma.employeeAbsence.deleteMany({ where: { organizationId: org } })
    await prisma.organizationRequest.deleteMany({ where: { organizationId: org } })
    await prisma.documentFolder.deleteMany({ where: { organizationId: org } })
    await prisma.organization.delete({ where: { id: org } })
  }
  await prisma.$disconnect()
})
describe('vacation balance permissions, lifecycle and workflow integration', () => {
  it('has no fabricated balance; employees cannot initialize or read a colleague balance', async () => {
    assert.equal((await getVacationBalance(employee, org)).balance.remaining, null)
    await assert.rejects(setupVacationBalance(employee, org, member, setup()), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(getVacationBalance(employee, org, adminMember), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(listVacationBalances(employee, org, balanceListQuery.parse({})), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(vacationBalanceHistory(employee, org, adminMember), code('INSUFFICIENT_PERMISSIONS'))
  })
  it('uses the organization annual norm and exact service months; setup retry is idempotent', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const input = { ...setup(), employmentStartDate: vacationMonthDate(today, -12) }
    const first = await setupVacationBalance(owner, org, member, input)
    assert.equal(first.balance.annualDays, 28)
    assert.equal(first.balance.accrued, 28)
    assert.equal(first.balance.remaining, 28)
    assert.equal((await setupVacationBalance(owner, org, member, input)).balance.accountId, first.balance.accountId)
    assert.equal(await prisma.vacationBalanceEvent.count({ where: { accountId: first.balance.accountId! } }), 1)
    await assert.rejects(setupVacationBalance(owner, org, member, { ...input, reason: 'Другой текст' }), code('VACATION_OPERATION_CHANGED'))
    await assert.rejects(setupVacationBalance(owner, org, member, setup()), code('VACATION_ACCOUNT_EXISTS'))
  })
  it('serializes concurrent corrections, preserves one winner and safely retries a lost response', async () => {
    const before = (await getVacationBalance(owner, org, member)).balance
    const input = {
      kind: 'ADJUSTMENT' as const,
      revision: before.revision,
      amount: 2,
      reason: 'Дополнительные дни по договору',
      submissionKey: randomUUID()
    }
    const results = await Promise.allSettled([
      changeVacationBalance(owner, org, member, input),
      changeVacationBalance(owner, org, member, { ...input, amount: 5, submissionKey: randomUUID() }),
    ])
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    const rejected = results.find(item => item.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejected.reason.code, 'VACATION_BALANCE_CHANGED')
    const winner = results[0].status === 'fulfilled' ? input : { ...input, amount: 5 }
    const after = (await getVacationBalance(employee, org)).balance
    assert.equal(after.remaining, before.remaining! + winner.amount)
    if (results[0].status === 'fulfilled') assert.equal((await changeVacationBalance(owner, org, member, input)).balance.remaining, after.remaining)
    const history = await vacationBalanceHistory(employee, org, member)
    const correction = history.items.find(item => item.type === 'ADJUSTMENT')!
    assert.equal(correction.before, before.remaining)
    assert.equal(correction.after, after.remaining)
    assert.ok(correction.actor)
    assert.equal(correction.reason, input.reason)
  })
  it('keeps fractional correction history at the same precision as the resulting balance', async () => {
    const before = (await getVacationBalance(owner, org, member)).balance
    const baseline = await changeVacationBalance(owner, org, member, {
      kind: 'ADJUSTMENT', revision: before.revision,
      amount: Math.round((30.23 - before.remaining!) * 100) / 100,
      submissionKey: randomUUID(), reason: 'Уточнение дробного остатка',
    })
    const changed = await changeVacationBalance(owner, org, member, {
      kind: 'ADJUSTMENT', revision: baseline.balance.revision, amount: 0.1,
      submissionKey: randomUUID(), reason: 'Дополнительная десятая дня',
    })
    const history = await vacationBalanceHistory(owner, org, member)
    assert.equal(changed.balance.remaining, 30.33)
    assert.equal(history.items.find(item => item.reason === 'Дополнительная десятая дня')?.after, 30.33)
  })
  it('keeps approved reservation and pending requests separate; amendment preview replaces the original vacation once', async () => {
    const type = (await listRequestTypes(owner, org)).find(item => item.systemCode === 'VACATION')!
    const first = await createRequest(employee, org, { requestTypeId: type.id, startDate: '2030-11-18', endDate: '2030-11-24' })
    await resolveRequest(owner, org, first.id, 'APPROVED', null)
    const pending = await createRequest(employee, org, { requestTypeId: type.id, startDate: '2030-12-02', endDate: '2030-12-04' })
    let balance = (await getVacationBalance(employee, org)).balance
    assert.equal(balance.reserved, 7)
    assert.equal(balance.pending, 3)
    assert.equal(balance.available, balance.remaining! - 7)
    const amendment = await amendVacation(employee, org, first.id, '2030-11-25', '2030-12-01', 'Перенос дат по просьбе сотрудника')
    const preview = await getVacationBalance(employee, org, member, { startDate: '2030-11-25', endDate: '2030-12-01', requestId: amendment.id })
    assert.equal(preview.availableAfterApproval, balance.available)
    await resolveRequest(owner, org, amendment.id, 'APPROVED', null)
    balance = (await getVacationBalance(employee, org)).balance
    assert.equal(balance.reserved, 7)
    const absence = await prisma.employeeAbsence.findUniqueOrThrow({ where: { sourceRequestId: first.id } })
    await changeAbsence(owner, org, absence.id, {
      updatedAt: absence.updatedAt.toISOString(),
      reason: 'Отпуск отменён по согласованию',
      employeeConsent: true,
      recallAllowed: true
    })
    assert.equal((await getVacationBalance(employee, org)).balance.reserved, 0)
    assert.ok(pending.id)
  })
  it('authorizes leave service changes separately, requires a reason and recalculates after cancellation', async () => {
    const balance = (await getVacationBalance(employee, org)).balance
    const absence = await prisma.employeeAbsence.create({
      data: {
        organizationId: org,
        memberId: member,
        type: 'DAY_OFF',
        startDate: new Date(balance.employmentStartDate!),
        endDate: new Date(addVacationDays(balance.employmentStartDate!, 19))
      }
    })
    const input = {
      updatedAt: absence.updatedAt.toISOString(),
      startDate: absence.startDate.toISOString().slice(0, 10),
      endDate: absence.endDate.toISOString().slice(0, 10),
      vacationService: 'EXCLUDED' as const
    }
    await assert.rejects(changeAbsence(employee, org, absence.id, input), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(changeAbsence(owner, org, absence.id, input), code('VACATION_SERVICE_REASON'))
    const updated = await changeAbsence(owner, org, absence.id, { ...input, changeReason: 'Отсутствие не входит в отпускной стаж' })
    assert.equal((await getVacationBalance(employee, org)).balance.excludedDays, 20)
    await changeAbsence(owner, org, absence.id, { updatedAt: updated.updatedAt.toISOString(), reason: 'Уточнение кадровых данных' })
    assert.equal((await getVacationBalance(employee, org)).balance.excludedDays, 0)
  })
  it('applies annual norm changes prospectively and keeps credited months unchanged', async () => {
    const before = (await getVacationBalance(owner, org, member)).balance
    const response = await changeVacationBalance(owner, org, member, {
      kind: 'POLICY',
      annualDays: 35,
      revision: before.revision,
      submissionKey: randomUUID(),
      reason: 'Изменение условий договора'
    })
    assert.equal(response.balance.accrued, before.accrued)
    assert.equal(response.balance.annualDays, before.annualDays)
    const entry = await prisma.vacationBalanceEvent.findFirstOrThrow({ where: { accountId: before.accountId!, kind: 'POLICY' } })
    assert.equal(entry.effectiveDate.toISOString().slice(0, 10), addVacationDays(before.asOf, 1))
  })
  it('corrects a mistaken hire date with a revision and preserves the previous date in history', async () => {
    const before = (await getVacationBalance(owner, org, member)).balance
    const earlierDate = vacationMonthDate(before.employmentStartDate!, -1)
    const response = await changeVacationBalance(owner, org, member, {
      kind: 'EMPLOYMENT',
      employmentStartDate: earlierDate,
      revision: before.revision,
      submissionKey: randomUUID(),
      reason: 'Исправлена дата по трудовому договору',
    })
    assert.equal(response.balance.employmentStartDate, earlierDate)
    assert.equal(response.balance.serviceMonths, before.serviceMonths + 1)
    const event = await prisma.vacationBalanceEvent.findFirstOrThrow({ where: { accountId: before.accountId!, kind: 'EMPLOYMENT' } })
    assert.equal((event.snapshot as { employmentStartDateBefore: string }).employmentStartDateBefore, before.employmentStartDate)
    await changeVacationBalance(owner, org, member, {
      kind: 'EMPLOYMENT',
      employmentStartDate: before.employmentStartDate!,
      revision: response.balance.revision,
      submissionKey: randomUUID(),
      reason: 'Восстановлена исходная дата для следующего сценария',
    })
  })
  it('does not expose or configure an employee from another organization', async () => {
    const other = await createBusinessOrganization(owner, { name: 'Изолированная организация', description: null, timezone: 'Europe/Moscow' })
    try {
      const foreignMember = (await getMembership(owner, other.id)).id
      await assert.rejects(getVacationBalance(owner, org, foreignMember), code('MEMBER_NOT_FOUND'))
      await assert.rejects(setupVacationBalance(owner, org, foreignMember, setup()), code('MEMBER_NOT_FOUND'))
      await assert.rejects(vacationBalanceHistory(owner, org, foreignMember), code('MEMBER_NOT_FOUND'))
    } finally {
      await prisma.documentFolder.deleteMany({ where: { organizationId: other.id } })
      await prisma.organization.delete({ where: { id: other.id } })
    }
  })
  it('enforces point scope and does not let a location manager change a member in another point', async () => {
    const otherPoint = await prisma.organizationLocation.create({
      data: {
        organizationId: org,
        name: 'Другая точка',
        timezone: 'Europe/Moscow',
        city: 'Москва',
        address: 'Другой адрес'
      }
    })
    const user = await prisma.user.create({ data: { email: `foreign-${randomUUID()}@example.test`, passwordHash: 'test' } })
    const other = await prisma.organizationMember.create({ data: { organizationId: org, userId: user.id } })
    await prisma.locationMember.create({ data: { organizationId: org, locationId: otherPoint.id, memberId: other.id } })
    const role = await saveAccessRole(owner, org, null, {
      name: 'Остатки своей точки',
      description: '',
      permissions: normalizePermissions(['vacations.balances.manage'])
    })
    await saveMemberAccess(owner, org, adminMember, { organizationRoleId: null, assignments: [{ locationId: point, roleId: role.id }] })
    await locationContext.run({ organizationId: org, locationId: point }, async () => {
      // Managing team balances also permits reading one's own team row; it
      // must not require an unrelated permission to submit personal requests.
      assert.equal((await getVacationBalance(admin, org, adminMember)).balance.configured, false)
      await assert.rejects(getVacationBalance(admin, org, other.id), code('MEMBER_NOT_FOUND'))
      await assert.rejects(setupVacationBalance(admin, org, other.id, setup()), code('MEMBER_NOT_FOUND'))
      const rows = await listVacationBalances(admin, org, balanceListQuery.parse({}))
      assert.ok(rows.members.every(item => item.memberId !== other.id))
    })
  })
  it('keeps existing vacation requests usable on lower plans while guarding direct balance APIs', async () => {
    await prisma.organizationSubscription.update({ where: { organizationId: org }, data: { plan: 'FREE', trialEndsAt: null, periodEnd: null } })
    await assert.rejects(getVacationBalance(owner, org, member), code('SUBSCRIPTION_FEATURE_REQUIRED'))
    await assert.rejects(listVacationBalances(owner, org, balanceListQuery.parse({})), code('SUBSCRIPTION_FEATURE_REQUIRED'))
    await assert.rejects(changeVacationBalance(owner, org, member, { kind: 'ADJUSTMENT', revision: 1, amount: 1, submissionKey: randomUUID(), reason: 'Попытка без тарифа' }), code('SUBSCRIPTION_FEATURE_REQUIRED'))
    assert.ok((await listRequestTypes(employee, org)).some(item => item.systemCode === 'VACATION'))
    await prisma.organizationSubscription.update({ where: { organizationId: org }, data: { plan: 'BUSINESS', periodEnd: new Date('2099-01-01') } })
  })
  it('starts a separate balance on rehire and retains the prior account history', async () => {
    const previous = (await getVacationBalance(owner, org, member)).balance
    await prisma.organizationMember.update({ where: { id: member }, data: { leftAt: new Date() } })
    await prisma.organizationMember.update({ where: { id: member }, data: { leftAt: null } })
    assert.equal((await getVacationBalance(owner, org, member)).balance.configured, false)
    await assert.rejects(setupVacationBalance(owner, org, member, setup()), code('VACATION_REHIRE_DATE'))
    const result = await setupVacationBalance(owner, org, member, { ...setup(), employmentStartDate: previous.asOf })
    assert.equal(result.balance.accrued, 0)
    assert.notEqual(result.balance.accountId, previous.accountId)
    assert.equal(await prisma.vacationAccount.count({ where: { organizationId: org, memberId: member } }), 2)
    assert.ok((await prisma.vacationBalanceEvent.findMany({ where: { accountId: previous.accountId!, kind: 'ADJUSTMENT' } })).length)
  })
})
