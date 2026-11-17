import assert from 'node:assert/strict'
import { after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { readAvailability, saveAvailability } from '../../src/server/schedule/availability/service.ts'
import { replacementCandidates, assignReplacement } from '../../src/server/schedule/availability/replacements.ts'
import { createShift, createShiftBatch, updateShift, type ShiftInput } from '../../src/server/schedule/service.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { listAttention } from '../../src/server/attention/service.ts'
import { listNotificationHistory } from '../../src/server/organizations/notification-service.ts'
import { previewSelfExit, leaveOrganization } from '../../src/server/organizations/self-exit-service.ts'
import { createCodeInvitation, acceptCodeInvitation } from '../../src/server/organizations/invitation-service.ts'
import { type AvailabilityConfig, type AvailabilityWarning } from '../../src/shared/availability.ts'
import type { User } from '../../src/generated/prisma/client.ts'
import type { ApiError } from '../../src/server/api-error.ts'

const organizations: string[] = []
const users: string[] = []
const code = (wanted: string) => (error: unknown) => (error as { code?: string }).code === wanted
async function warning(work: () => Promise<unknown>) {
  try { await work() } catch (error) {
    assert.equal((error as ApiError).code, 'AVAILABILITY_WARNING')
    return (error as ApiError).details as AvailabilityWarning
  }
  throw new Error('Expected a real availability conflict')
}

async function fixture() {
  const people: User[] = []
  for (const name of ['Owner', 'Employee', 'Replacement', 'Foreign']) {
    const user = await prisma.user.create({ data: { email: `availability-${randomUUID()}@example.test`, firstName: name } })
    users.push(user.id)
    people.push(user)
  }
  const org = await createBusinessOrganization(people[0].id, { name: 'Availability QA', description: null, timezone: 'Europe/Moscow' })
  organizations.push(org.id)
  const owner = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: people[0].id } } })
  const employee = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: people[1].id } })
  const replacement = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: people[2].id } })
  await prisma.locationMember.createMany({ data: [employee, replacement].map(person => ({ organizationId: org.id, locationId: org.locationId, memberId: person.id })) })
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
  const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10)
  const input = (date = day, memberId = employee.id) => ({ memberId, startDate: date, endDate: date, startTime: '10:00', endTime: '18:00', breakMinutes: 0, description: null })
  const scope = <T>(work: () => T) => locationContext.run({ organizationId: org.id, locationId: org.locationId }, work)
  const state = (memberId = employee.id, userId = people[0].id) => scope(() => readAvailability(userId, org.id, memberId))
  const save = async (config: AvailabilityConfig, userId = people[0].id, memberId = employee.id) => {
    const before = await state(memberId, userId)
    return scope(() => saveAvailability(userId, org.id, memberId, { operationId: randomUUID(), employmentPeriodId: before.employmentPeriodId, revision: before.revision, config }))
  }
  const off = (date = day): AvailabilityConfig => ({ weeks: [], exceptions: [{ date, rule: { mode: 'OFF' } }] })
  const create = (value: ShiftInput = input()) => scope(() => createShift(people[0].id, org.id, value))
  return { people, org, owner, employee, replacement, day, next, input, scope, state, save, off, create }
}

after(async () => {
  await prisma.shiftOffer.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.scheduleDraft.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.organizationRequest.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.workShift.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.documentFolder.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.$disconnect()
})

it('saves personal rules with author and revision, without granting access to a colleague or foreign organization', async () => {
  const f = await fixture()
  await f.save(f.off(), f.people[1].id)
  const state = await f.state(f.employee.id, f.people[1].id)
  assert.equal(state.revision, 1)
  assert.equal(state.updatedBy, 'Employee')
  assert.equal(state.timezone, 'Europe/Moscow')
  await assert.rejects(f.state(f.replacement.id, f.people[1].id), code('INSUFFICIENT_PERMISSIONS'))
  await assert.rejects(f.state(f.employee.id, f.people[3].id), code('ORGANIZATION_NOT_FOUND'))
})

it('retries one operation without duplicate history and rejects stale or reused operations', async () => {
  const f = await fixture()
  const state = await f.state()
  const input = { operationId: randomUUID(), employmentPeriodId: state.employmentPeriodId, revision: 0, config: f.off() }
  const results = await Promise.all([1, 2].map(() => f.scope(() => saveAvailability(f.people[0].id, f.org.id, f.employee.id, input))))
  assert.equal(results.filter(result => result.repeated).length, 1)
  assert.equal(await prisma.memberAvailabilityEvent.count({ where: { organizationId: f.org.id } }), 1)
  await assert.rejects(f.scope(() => saveAvailability(f.people[0].id, f.org.id, f.employee.id, { ...input, config: f.off(f.next) })), code('OPERATION_CHANGED'))
  await assert.rejects(f.scope(() => saveAvailability(f.people[0].id, f.org.id, f.employee.id, { ...input, operationId: randomUUID() })), code('AVAILABILITY_CHANGED'))
})

it('rolls back a complete batch until a current agreement with a reason is explicitly supplied', async () => {
  const f = await fixture()
  await f.save(f.off())
  const batch = [f.input(), f.input(f.next)]
  const found = await warning(() => f.scope(() => createShiftBatch(f.people[0].id, f.org.id, batch)))
  assert.equal(found.availabilityConflicts.length, 1)
  assert.equal(await prisma.workShift.count({ where: { organizationId: f.org.id } }), 0)
  const agreement = { availabilityConfirmation: found.availabilityConfirmation, availabilityReason: 'Сотрудник подтвердил разовый выход' }
  const result = await f.scope(() => createShiftBatch(f.people[0].id, f.org.id, batch, false, undefined, agreement))
  assert.equal(result.shifts.length, 2)
  const accepted = await prisma.workShift.findMany({ where: { organizationId: f.org.id } })
  assert.equal(accepted.filter(shift => shift.availabilityOverride !== null).length, 1)
  assert.equal(await prisma.accessAudit.count({ where: { organizationId: f.org.id, action: 'SHIFT_AVAILABILITY_OVERRIDE' } }), 1)
})

it('does not reuse an agreement after changing the rules, dates or participants', async () => {
  const f = await fixture()
  await f.save(f.off())
  const found = await warning(() => f.create())
  await f.save({ weeks: [], exceptions: [{ date: f.day, rule: { mode: 'TIME', start: '16:00', end: '23:00', overnight: false } }] })
  const stale = await warning(() => f.create({ ...f.input(), availabilityConfirmation: found.availabilityConfirmation, availabilityReason: 'Предыдущая договорённость' }))
  assert.notEqual(stale.availabilityConfirmation, found.availabilityConfirmation)
  assert.equal(await prisma.workShift.count({ where: { organizationId: f.org.id } }), 0)
})

it('keeps absence and overlap checks in force after a personal availability agreement', async () => {
  const f = await fixture()
  await f.save(f.off())
  const found = await warning(() => f.create())
  await prisma.employeeAbsence.create({ data: { organizationId: f.org.id, memberId: f.employee.id, type: 'VACATION', startDate: new Date(f.day), endDate: new Date(f.day) } })
  await assert.rejects(f.create({ ...f.input(), availabilityConfirmation: found.availabilityConfirmation, availabilityReason: 'Разовое согласие сотрудника' }), code('VACATION_CONFLICT'))
  assert.equal(await prisma.workShift.count({ where: { organizationId: f.org.id } }), 0)
  assert.equal(await prisma.accessAudit.count({ where: { organizationId: f.org.id, action: 'SHIFT_AVAILABILITY_OVERRIDE' } }), 0)
})

it('retains existing shifts and creates a scoped manager notification and attention card', async () => {
  const f = await fixture()
  const shift = await f.create()
  await f.save(f.off(), f.people[1].id)
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'SCHEDULED')
  assert.equal((await f.state()).conflicts.length, 1)
  const history = await listNotificationHistory(f.people[0].id, f.people[0].email, { organizationId: f.org.id, limit: 20 })
  assert.ok(history.notifications.some(item => item.href?.includes(`availability=${f.employee.id}`)))
  const attention = await f.scope(() => listAttention(f.people[0].id, f.org.id, { scope: 'control', filter: 'all', pointId: 'all', page: 1, pageSize: 30 }))
  assert.equal(attention.items.filter(item => item.kind === 'AVAILABILITY').length, 1)
})

it('sorts suitable replacement candidates first, rechecks the selection and records one transfer', async () => {
  const f = await fixture()
  const shift = await f.create()
  await f.save(f.off(), f.people[1].id)
  const candidates = await f.scope(() => replacementCandidates(f.people[0].id, f.org.id, shift.id, '', 1))
  assert.ok(candidates.candidates.find(person => person.id === f.replacement.id && !person.reason))
  assert.ok(!candidates.candidates.some(person => person.id === f.employee.id))
  const input = { memberId: f.replacement.id, updatedAt: candidates.shift.updatedAt, acknowledgeWorkload: false }
  await f.scope(() => assignReplacement(f.people[0].id, f.org.id, shift.id, input))
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).memberId, f.replacement.id)
  assert.equal((await f.state()).conflicts.length, 0)
  await assert.rejects(f.scope(() => assignReplacement(f.people[0].id, f.org.id, shift.id, input)), code('SHIFT_CHANGED'))
  assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: shift.id } }), 1)
})

it('preserves rules after a downgrade while disabling the paid feature consistently', async () => {
  const f = await fixture()
  await f.save(f.off())
  await prisma.organizationSubscription.update({ where: { organizationId: f.org.id }, data: { plan: 'FREE', periodStart: null, periodEnd: null, trialEndsAt: null } })
  await assert.rejects(f.state(), code('SUBSCRIPTION_FEATURE_REQUIRED'))
  await f.create()
  assert.equal(await prisma.memberAvailability.count({ where: { organizationId: f.org.id } }), 1)
})

it('starts a new availability account on rehire and forbids updates to the completed employment period', async () => {
  const f = await fixture()
  await f.save(f.off())
  const old = await f.state()
  const preview = await previewSelfExit(f.people[1].id, f.org.id)
  await leaveOrganization(f.people[1].id, f.org.id, preview.employmentPeriodId)
  const account = await prisma.memberAvailability.findFirstOrThrow({ where: { memberId: f.employee.id } })
  await assert.rejects(prisma.memberAvailability.update({ where: { id: account.id }, data: { revision: { increment: 1 } } }))
  const invite = await f.scope(() => createCodeInvitation(f.people[0].id, f.org.id))
  await acceptCodeInvitation(f.people[1].id, f.people[1].email, invite.code)
  const current = await f.state()
  assert.notEqual(current.employmentPeriodId, old.employmentPeriodId)
  assert.equal(current.revision, 0)
  assert.deepEqual(current.config, { weeks: [], exceptions: [] })
  await assert.rejects(f.scope(() => saveAvailability(f.people[0].id, f.org.id, f.employee.id, { operationId: randomUUID(), employmentPeriodId: old.employmentPeriodId, revision: old.revision, config: f.off() })), code('MEMBERSHIP_CHANGED'))
})

it('does not let a manager of one point edit restrictions affecting another managed team', async () => {
  const f = await fixture()
  const other = await prisma.organizationLocation.create({ data: { organizationId: f.org.id, name: 'Other point', city: '', address: '', timezone: 'Asia/Yekaterinburg' } })
  await prisma.locationMember.create({ data: { organizationId: f.org.id, locationId: other.id, memberId: f.employee.id } })
  const role = await prisma.accessRole.create({ data: { organizationId: f.org.id, name: 'Point manager', permissions: ['members.view', 'schedule.view', 'schedule.edit', 'availability.view', 'availability.manage'] } })
  await prisma.organizationMember.update({ where: { id: f.replacement.id }, data: { accessConfigured: true } })
  await prisma.accessAssignment.create({ data: { organizationId: f.org.id, locationId: f.org.locationId, memberId: f.replacement.id, roleId: role.id } })
  const state = await f.state(f.employee.id, f.people[2].id)
  assert.equal(state.canManage, false)
  await assert.rejects(f.save(f.off(), f.people[2].id), code('INSUFFICIENT_PERMISSIONS'))
})

it('uses the organization timezone rather than the selected point when creating shared rules', async () => {
  const f = await fixture()
  await prisma.organizationLocation.update({ where: { id: f.org.locationId }, data: { timezone: 'Asia/Vladivostok' } })
  assert.equal((await f.state()).timezone, 'Europe/Moscow')
  await f.save(f.off())
  assert.equal((await f.state()).timezone, 'Europe/Moscow')
  assert.equal((await prisma.memberAvailability.findFirstOrThrow({ where: { memberId: f.employee.id } })).timezone, 'Europe/Moscow')
})

it('rejects a replacement that becomes unavailable after the candidate preview without changing the shift or history', async () => {
  const f = await fixture()
  const shift = await f.create()
  const candidates = await f.scope(() => replacementCandidates(f.people[0].id, f.org.id, shift.id, '', 1))
  await f.save(f.off(), f.people[2].id, f.replacement.id)
  await assert.rejects(f.scope(() => assignReplacement(f.people[0].id, f.org.id, shift.id, {
    memberId: f.replacement.id, updatedAt: candidates.shift.updatedAt, acknowledgeWorkload: false,
  })), code('MEMBER_UNAVAILABLE'))
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).memberId, f.employee.id)
  assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: shift.id } }), 0)
})

it('rechecks override rights after preview and never treats schedule.create as permission to override', async () => {
  const f = await fixture()
  await f.save(f.off())
  const role = await prisma.accessRole.create({ data: {
    organizationId: f.org.id, name: 'Scheduler',
    permissions: ['members.view', 'schedule.view', 'schedule.create', 'availability.view', 'availability.override'],
  } })
  await prisma.organizationMember.update({ where: { id: f.replacement.id }, data: { accessConfigured: true } })
  await prisma.accessAssignment.create({ data: { organizationId: f.org.id, locationId: f.org.locationId, memberId: f.replacement.id, roleId: role.id } })
  const create = (agreement = {}) => f.scope(() => createShift(f.people[2].id, f.org.id, { ...f.input(), ...agreement }))
  const preview = await warning(() => create())
  assert.equal(preview.canOverrideAvailability, true)
  await prisma.accessRole.update({ where: { id: role.id }, data: { permissions: ['members.view', 'schedule.view', 'schedule.create', 'availability.view'] } })
  await assert.rejects(create({ availabilityConfirmation: preview.availabilityConfirmation, availabilityReason: 'Разовый выход согласован сотрудником' }), code('INSUFFICIENT_PERMISSIONS'))
  assert.equal(await prisma.workShift.count({ where: { organizationId: f.org.id } }), 0)
})

it('checks availability before an offer is accepted and before an entire draft is applied', async () => {
  const f = await fixture()
  const { createOffer, actOnOffer, offerBody, saveOfferModes } = await import('../../src/server/schedule/offer-service.ts')
  const team = await import('../../src/server/schedule/planning/team-planning-service.ts')
  const schema = await import('../../src/server/schedule/planning/team-planning-schemas.ts')
  const shift = await f.create()
  await f.scope(() => saveOfferModes(f.people[0].id, f.org.id, { transferMode: 'AUTO', swapMode: 'AUTO' }))
  const offer = await f.scope(() => createOffer(f.people[1].id, f.org.id, offerBody.parse({ sourceShiftId: shift.id, kind: 'TRANSFER', recipientMemberId: f.replacement.id })))
  await f.save(f.off(), f.people[2].id, f.replacement.id)
  await assert.rejects(f.scope(() => actOnOffer(f.people[2].id, f.org.id, offer.id, 'accept')), code('MEMBER_UNAVAILABLE'))
  assert.equal((await prisma.shiftOffer.findUniqueOrThrow({ where: { id: offer.id } })).status, 'INVALID')
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).memberId, f.employee.id)
  await f.scope(() => team.saveTeamSettings(f.people[0].id, f.org.id, { coverageEnabled: false, discussionEnabled: true, discussionHours: 24 }))
  const draft = await f.scope(() => team.createDraft(f.people[0].id, f.org.id, schema.draftCreateBody.parse({ title: 'Availability draft', fromDate: f.next, toDate: f.next })))
  await f.save(f.off(f.next))
  await f.scope(() => team.changeDraftProposals(f.people[0].id, f.org.id, draft.id, schema.draftProposalBody.parse({ revision: draft.revision, kind: 'CREATE', shifts: [f.input(f.next)] })))
  const detail = () => f.scope(() => team.getDraft(f.people[0].id, f.org.id, draft.id))
  const act = async (action: string, patch = {}) => f.scope(async () => team.actOnDraft(f.people[0].id, f.org.id, draft.id, schema.draftActionBody.parse({ revision: (await detail()).revision, action, ...patch })))
  await act('PUBLISH', { deadline: new Date(Date.now() + 86400000).toISOString() })
  await act('CLOSE', { confirm: true, explanation: 'Проверено перед применением' })
  const found = await warning(() => act('APPLY'))
  assert.equal(await prisma.workShift.count({ where: { organizationId: f.org.id } }), 1)
  await act('APPLY', { availabilityConfirmation: found.availabilityConfirmation, availabilityReason: 'Сотрудник подтвердил выход после обсуждения' })
  assert.equal(await prisma.workShift.count({ where: { organizationId: f.org.id } }), 2)
})

it('records a new agreement for an existing conflicting shift without changing its employee or time', async () => {
  const f = await fixture()
  const shift = await f.create()
  await f.save(f.off())
  const found = await warning(() => f.scope(() => updateShift(f.people[0].id, f.org.id, shift.id, {
    ...f.input(), startTime: '10:01',
  })))
  // A token from a different interval cannot authorize this unchanged shift.
  const current = await warning(() => f.scope(() => updateShift(f.people[0].id, f.org.id, shift.id, {
    ...f.input(), availabilityConfirmation: found.availabilityConfirmation, availabilityReason: 'Договорились оставить исходное время',
  })))
  const saved = await f.scope(() => updateShift(f.people[0].id, f.org.id, shift.id, {
    ...f.input(), availabilityConfirmation: current.availabilityConfirmation, availabilityReason: 'Договорились оставить исходное время',
  }))
  assert.equal(saved.memberId, f.employee.id)
  assert.equal(new Date(saved.scheduledStartAt).toISOString(), new Date(shift.scheduledStartAt).toISOString())
  assert.equal(new Date(saved.scheduledEndAt).toISOString(), new Date(shift.scheduledEndAt).toISOString())
  assert.equal(saved.availabilityOverride?.reason, 'Договорились оставить исходное время')
  assert.equal((await f.state()).conflicts.length, 0)
  assert.equal(await prisma.accessAudit.count({ where: { organizationId: f.org.id, action: 'SHIFT_AVAILABILITY_OVERRIDE' } }), 1)
})
