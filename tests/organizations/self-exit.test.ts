import assert from 'node:assert/strict'
import { after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { User } from '../../src/generated/prisma/client.ts'
import { prisma } from '../../src/server/db.ts'
import { buildReport, reportMembers } from '../../src/server/schedule/reports/report-service.ts'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { previewSelfExit, leaveOrganization } from '../../src/server/organizations/self-exit-service.ts'
import { getExitWork, resolveExitShift, assignExitTask, exitCandidates } from '../../src/server/organizations/self-exit-work.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { listAttention } from '../../src/server/attention/service.ts'
import { listNotificationHistory } from '../../src/server/organizations/notification-service.ts'
import { listSchedule } from '../../src/server/schedule/service.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { calculateWorkTime } from '../../src/shared/work-time.ts'
import { calculateCoverage } from '../../src/server/schedule/planning/coverage.ts'
import { createCodeInvitation, acceptCodeInvitation } from '../../src/server/organizations/invitation-service.ts'
import { readTimesheet, actOnTimesheet, readTimesheetVersion } from '../../src/server/schedule/timesheets/service.ts'
import { timesheetMutationContext } from '../../src/server/schedule/timesheets/mutation-context.ts'
import { monthKeyInZone, zonedDateAndTime } from '../../src/app/schedule/date-utils.ts'
const organizations: string[] = []
const users: string[] = []
const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code

async function fixture() {
  const people: User[] = []
  for (const [firstName, lastName] of [['Анна', 'Смирнова'], ['Михаил', 'Соколов'], ['Ольга', 'Лебедева'], ['Иван', 'Внешний']]) {
    const person = await prisma.user.create({
      data: {
        email: `self-exit-${randomUUID()}@example.test`,
        passwordHash: 'test-only',
        emailVerifiedAt: new Date(),
        firstName,
        lastName
      }
    })
    people.push(person)
    users.push(person.id)
  }
  const org = await createBusinessOrganization(people[0].id, { name: 'Self exit QA', description: null, timezone: 'Europe/Moscow' })
  organizations.push(org.id)
  const owner = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: people[0].id } } })
  const leaving = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: people[1].id } })
  const replacement = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: people[2].id } })
  await prisma.locationMember.createMany({
    data: [leaving, replacement].map(member => ({ organizationId: org.id, locationId: org.locationId, memberId: member.id }))
  })
  const scope = <T>(work: () => T) => locationContext.run({ organizationId: org.id, locationId: org.locationId }, work)
  const shift = async (offset = 3, memberId = leaving.id, locationId = org.locationId) => {
    const start = new Date(Date.now() + offset * 86400000)
    return prisma.workShift.create({
      data: {
        organizationId: org.id,
        locationId,
        memberId,
        createdByMemberId: owner.id,
        scheduledStartAt: start,
        scheduledEndAt: new Date(+start + 8 * 3600000)
      }
    })
  }
  const task = async (memberIds = [leaving.id], visibility = 'TEAM') => {
    const type = await prisma.requestType.create({ data: { organizationId: org.id, name: 'Передать инструкции', dateMode: 'NONE', requiresComment: false } })
    return prisma.organizationRequest.create({
      data: {
        organizationId: org.id,
        locationId: org.locationId,
        createdByMemberId: owner.id,
        requestTypeId: type.id,
        typeNameSnapshot: type.name,
        status: 'APPROVED',
        formSnapshot: { version: 1, visibility, stages: [{ name: 'Личное согласование', memberId: owner.id }] },
        outcome: { kind: 'TASK', status: 'OPEN', text: 'Передать инструкции', assignees: memberIds, deadline: '2026-12-31' },
      }
    })
  }
  const leave = async () => {
    const preview = await previewSelfExit(people[1].id, org.id)
    return leaveOrganization(people[1].id, org.id, preview.employmentPeriodId)
  }
  return { people, org, owner, leaving, replacement, scope, shift, task, leave }
}

after(async () => {
  await prisma.timesheetPeriod.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.organizationRequest.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.workShift.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.documentFolder.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.$disconnect()
})

it('leaves voluntarily without management permissions, revokes every point and preserves other organizations and work history', async () => {
  const f = await fixture()
  const future = await f.shift()
  const past = await f.shift(-3)
  const current = await f.shift(-0.05)
  const task = await f.task()
  const other = await createBusinessOrganization(f.people[1].id, { name: 'Other QA', description: null, timezone: 'Europe/Moscow' })
  organizations.push(other.id)
  const preview = await previewSelfExit(f.people[1].id, f.org.id)
  assert.equal(preview.shifts, 1)
  assert.equal(preview.tasks, 1)
  const exit = await f.leave()
  assert.ok((await prisma.organizationMember.findUniqueOrThrow({ where: { id: f.leaving.id } })).leftAt)
  assert.equal(await prisma.locationMember.count({ where: { memberId: f.leaving.id, leftAt: null } }), 0)
  await assert.rejects(getMembership(f.people[1].id, f.org.id), errorCode('ORGANIZATION_NOT_FOUND'))
  assert.equal((await getMembership(f.people[1].id, other.id)).owner, true)
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: future.id } })).status, 'UNASSIGNED')
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: past.id } })).status, 'SCHEDULED')
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: current.id } })).status, 'SCHEDULED')
  assert.ok((await prisma.memberEmploymentPeriod.findUniqueOrThrow({ where: { id: preview.employmentPeriodId } })).endedAt)
  assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: task.id } })).selfExitId, exit.id)
  const work = await getExitWork(f.people[0].id, f.org.id, exit.id)
  assert.equal(work.shifts.length, 1)
  assert.equal(work.tasks.length, 1)
  const notifications = await listNotificationHistory(f.people[0].id, f.people[0].email, { organizationId: f.org.id, limit: 20 })
  assert.ok(notifications.notifications.some(notification => notification.href?.includes(`selfExit=${exit.id}`)))
})

it('serializes concurrent exit retries and refuses an old operation after rejoining', async () => {
  const f = await fixture()
  const preview = await previewSelfExit(f.people[1].id, f.org.id)
  const results = await Promise.all([1, 2].map(() => leaveOrganization(f.people[1].id, f.org.id, preview.employmentPeriodId)))
  assert.equal(results[0].id, results[1].id)
  assert.equal(await prisma.accessAudit.count({ where: { organizationId: f.org.id, action: 'MEMBER_LEFT_SELF' } }), 1)
  const invite = await f.scope(() => createCodeInvitation(f.people[0].id, f.org.id))
  await acceptCodeInvitation(f.people[1].id, f.people[1].email, invite.code)
  await assert.rejects(leaveOrganization(f.people[1].id, f.org.id, preview.employmentPeriodId), errorCode('MEMBERSHIP_CHANGED'))
  assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: f.leaving.id } })).leftAt, null)
  assert.notEqual((await previewSelfExit(f.people[1].id, f.org.id)).employmentPeriodId, preview.employmentPeriodId)
})

it('keeps an owner in place and rejects foreign identities and another member employment period', async () => {
  const f = await fixture()
  const owner = await previewSelfExit(f.people[0].id, f.org.id)
  await assert.rejects(leaveOrganization(f.people[0].id, f.org.id, owner.employmentPeriodId), errorCode('OWNER_MUST_TRANSFER'))
  await assert.rejects(previewSelfExit(f.people[3].id, f.org.id), errorCode('ORGANIZATION_NOT_FOUND'))
  await assert.rejects(leaveOrganization(f.people[1].id, f.org.id, owner.employmentPeriodId), errorCode('MEMBERSHIP_CHANGED'))
  assert.equal(await prisma.memberSelfExit.count({ where: { organizationId: f.org.id } }), 0)
})

it('allows leaving an expired and suspended organization even without a point assignment', async () => {
  const f = await fixture()
  const shift = await f.shift()
  const task = await f.task()
  const offer = await prisma.shiftOffer.create({ data: {
    organizationId: f.org.id, locationId: f.org.locationId, initiatorMemberId: f.leaving.id,
    recipientMemberId: f.replacement.id, sourceShiftId: shift.id, kind: 'TRANSFER', mode: 'AUTO',
    sourceSnapshot: {}, reservations: { create: { shiftId: shift.id } },
  } })
  const shiftType = await prisma.requestType.findFirstOrThrow({ where: { organizationId: f.org.id, systemCode: 'SHIFT_CHANGE' } })
  const proposal = await prisma.organizationRequest.create({ data: {
    organizationId: f.org.id, locationId: f.org.locationId, createdByMemberId: f.leaving.id,
    requestTypeId: shiftType.id, typeNameSnapshot: shiftType.name, systemCodeSnapshot: 'SHIFT_CHANGE',
    relatedShiftId: shift.id, originalStartAt: shift.scheduledStartAt, originalEndAt: shift.scheduledEndAt,
    proposedStartAt: new Date(+shift.scheduledStartAt + 3600000), proposedEndAt: new Date(+shift.scheduledEndAt + 3600000),
  } })
  const past = new Date(Date.now() - 86400000)
  await prisma.organizationSubscription.update({
    where: { organizationId: f.org.id },
    data: { periodStart: new Date(+past - 86400000), periodEnd: past, trialStartedAt: null, trialEndsAt: null }
  })
  await prisma.organizationMember.update({ where: { id: f.leaving.id }, data: { accessConfigured: true } })
  await prisma.locationMember.updateMany({ where: { memberId: f.leaving.id }, data: { leftAt: new Date() } })
  await prisma.organization.update({ where: { id: f.org.id }, data: { serviceState: 'SUSPENDED', serviceReason: 'Synthetic hold' } })
  const result = await f.leave()
  assert.ok(result.id)
  assert.equal((await prisma.shiftOffer.findUniqueOrThrow({ where: { id: offer.id } })).status, 'CANCELLED')
  assert.equal(await prisma.shiftOfferReservation.count({ where: { offerId: offer.id } }), 0)
  assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: proposal.id } })).status, 'INVALID')
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'UNASSIGNED')
  assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: task.id } })).selfExitId, result.id)
  await assert.rejects(prisma.organizationMember.update({ where: { id: f.replacement.id }, data: { workEmail: 'still-blocked@example.test' } }))
  await prisma.organization.update({ where: { id: f.org.id }, data: { serviceState: 'ACTIVE', serviceReason: null } })
  assert.equal(await prisma.accountNotification.count({ where: { organizationId: f.org.id, userId: f.people[0].id, type: 'ORGANIZATION_MEMBER_LEFT' } }), 1)
})

it('does not credit unavailable assignments as planned/estimated/confirmed work or coverage, while keeping them in the calendar', async () => {
  const f = await fixture()
  const shift = await f.shift()
  await f.leave()
  const changed = await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })
  const accounting = calculateWorkTime(changed)
  assert.equal(accounting.state, 'UNASSIGNED')
  assert.equal(accounting.plannedMinutes, 0)
  assert.equal(accounting.estimatedMinutes, 0)
  assert.equal(accounting.confirmedMinutes, null)
  const day = zonedDateAndTime(shift.scheduledStartAt.toISOString(), 'Europe/Moscow').date
  const from = new Date(day + 'T00:00Z')
  const to = new Date(+from + 86400000).toISOString().slice(0, 10)
  const calendar = await f.scope(() => listSchedule(f.people[0].id, f.org.id, day, to))
  assert.equal(calendar.shifts.find(item => item.id === shift.id)?.status, 'UNASSIGNED')
  const positionId = randomUUID()
  const coverage = calculateCoverage(day, to, 'Europe/Moscow', [], [{
    date: day,
    intervals: [{ positionId, startTime: '00:00', endTime: '00:00', endDayOffset: 1, needed: 1 }],
  }], [{ ...changed, positionId }], [{ id: positionId, name: 'Barista' }])
  assert.ok(coverage[0].segments.length > 0)
  assert.ok(coverage[0].segments.every(segment => segment.assigned === 0 && segment.shortage === 1))
  const input = { from: day, to: day, locationIds: [f.org.locationId], memberIds: [], includeFormer: true, config: defaultReportConfig() }
  const report = await buildReport(f.people[0].id, f.org.id, input)
  assert.equal(report.metrics.shifts, 0)
  assert.equal(report.metrics.plannedHours, 0)
  assert.equal(report.rows.shifts.length, 0)
  assert.ok(!(await reportMembers(f.people[0].id, f.org.id, input)).members.some(member => member.id === f.leaving.id))
})

it('reassigns through the normal absence, overlap and workload checks and rejects stale edits atomically', async () => {
  const f = await fixture()
  const original = await f.shift()
  const exit = await f.leave()
  const shift = await prisma.workShift.findUniqueOrThrow({ where: { id: original.id } })
  const conflict = await prisma.workShift.create({
    data: {
      organizationId: f.org.id,
      locationId: f.org.locationId,
      memberId: f.replacement.id,
      createdByMemberId: f.owner.id,
      scheduledStartAt: shift.scheduledStartAt,
      scheduledEndAt: shift.scheduledEndAt
    }
  })
  const input = {
    updatedAt: shift.updatedAt.toISOString(),
    memberId: f.replacement.id,
    acknowledgeWorkload: false,
    reason: ''
  }
  await assert.rejects(resolveExitShift(f.people[0].id, f.org.id, exit.id, shift.id, input), errorCode('SHIFT_OVERLAP'))
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'UNASSIGNED')
  await prisma.workShift.delete({ where: { id: conflict.id } })
  const absence = await prisma.employeeAbsence.create({
    data: {
      organizationId: f.org.id,
      memberId: f.replacement.id,
      type: 'VACATION',
      startDate: new Date(shift.scheduledStartAt.toISOString().slice(0, 10)),
      endDate: new Date(shift.scheduledEndAt.toISOString().slice(0, 10)),
    }
  })
  await assert.rejects(resolveExitShift(f.people[0].id, f.org.id, exit.id, shift.id, input), errorCode('VACATION_CONFLICT'))
  const candidates = await exitCandidates(f.people[0].id, f.org.id, exit.id, shift.id, 'shift', '', 1)
  assert.ok(candidates.candidates.find(candidate => candidate.id === f.replacement.id)?.reason)
  await prisma.employeeAbsence.delete({ where: { id: absence.id } })
  await prisma.organizationLocation.update({ where: { id: f.org.locationId }, data: { monthlyWorkMinutes: 60 } })
  await assert.rejects(resolveExitShift(f.people[0].id, f.org.id, exit.id, shift.id, input), errorCode('WORKLOAD_WARNING'))
  await resolveExitShift(f.people[0].id, f.org.id, exit.id, shift.id, { ...input, acknowledgeWorkload: true })
  const assigned = await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })
  assert.equal(assigned.status, 'SCHEDULED')
  assert.equal(assigned.selfExitId, null)
  assert.equal(assigned.memberId, f.replacement.id)
  assert.equal((await getExitWork(f.people[0].id, f.org.id, exit.id)).shifts.length, 0)
  await assert.rejects(resolveExitShift(f.people[0].id, f.org.id, exit.id, shift.id, input), errorCode('ASSIGNMENT_CHANGED'))
  assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: shift.id } }), 1)
})

it('assigns an open task once, preserves its deadline and records the new assignee', async () => {
  const f = await fixture()
  const task = await f.task()
  const exit = await f.leave()
  const work = await getExitWork(f.people[0].id, f.org.id, exit.id)
  await assert.rejects(assignExitTask(f.people[0].id, f.org.id, exit.id, task.id, { memberId: f.leaving.id, updatedAt: work.tasks[0].updatedAt }), errorCode('ASSIGNEE_UNAVAILABLE'))
  await assignExitTask(f.people[0].id, f.org.id, exit.id, task.id, { memberId: f.replacement.id, updatedAt: work.tasks[0].updatedAt })
  const changed = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: task.id } })
  assert.deepEqual((changed.outcome as { assignees: string[] }).assignees, [f.replacement.id])
  assert.equal((changed.outcome as { deadline: string }).deadline, '2026-12-31')
  assert.equal(changed.status, 'APPROVED')
  assert.equal(changed.selfExitId, null)
  assert.equal((await getExitWork(f.people[0].id, f.org.id, exit.id)).tasks.length, 0)
})

it('does not treat a task with another available assignee as abandoned or duplicate it in attention', async () => {
  const f = await fixture()
  await f.task([f.leaving.id, f.replacement.id])
  const exit = await f.leave()
  assert.equal((await getExitWork(f.people[0].id, f.org.id, exit.id)).tasks.length, 0)
  const queue = await listAttention(f.people[0].id, f.org.id, { scope: 'control', filter: 'all', pointId: 'all', page: 1, pageSize: 30 })
  assert.equal(queue.items.filter(item => item.kind === 'DEPARTURE').length, 0)
  assert.equal(queue.items.filter(item => item.kind === 'TASK').length, 1)
})

it('groups abandoned tasks and shifts into one actionable attention card', async () => {
  const f = await fixture()
  await f.shift()
  await f.task()
  const exit = await f.leave()
  const queue = await listAttention(f.people[0].id, f.org.id, { scope: 'control', filter: 'all', pointId: 'all', page: 1, pageSize: 30 })
  assert.equal(queue.items.filter(item => item.kind === 'DEPARTURE').length, 1)
  assert.equal(queue.items.filter(item => item.kind === 'TASK').length, 0)
  assert.ok(queue.items[0].href.includes(exit.id))
})

it('keeps private tasks hidden from a point manager and does not allow ordinary colleagues to resolve assignments', async () => {
  const f = await fixture()
  const shift = await f.shift()
  await f.task([f.leaving.id], 'PRIVATE')
  const exit = await f.leave()
  const role = await prisma.accessRole.create({
    data: {
      organizationId: f.org.id,
      name: 'Schedule only',
      permissions: ['schedule.view', 'schedule.edit', 'members.view']
    }
  })
  await prisma.organizationMember.update({ where: { id: f.replacement.id }, data: { accessConfigured: true, accessRoleId: role.id } })
  const work = await getExitWork(f.people[2].id, f.org.id, exit.id)
  assert.equal(work.tasks.length, 0)
  assert.equal(work.shifts.length, 1)
  await assert.rejects(getExitWork(f.people[3].id, f.org.id, exit.id), errorCode('ORGANIZATION_NOT_FOUND'))
  await prisma.organizationMember.update({ where: { id: f.replacement.id }, data: { accessRoleId: null } })
  await assert.rejects(exitCandidates(f.people[2].id, f.org.id, exit.id, shift.id, 'shift', '', 1), errorCode('ASSIGNMENT_NOT_FOUND'))
})

it('keeps closed timesheets and their source history intact when leaving with future assignments', async () => {
  const f = await fixture()
  await f.shift(45)
  const pastStart = new Date('2025-10-02T06:00:00Z')
  const shift = await prisma.workShift.create({
    data: {
      organizationId: f.org.id,
      locationId: f.org.locationId,
      memberId: f.leaving.id,
      createdByMemberId: f.owner.id,
      scheduledStartAt: pastStart,
      scheduledEndAt: new Date(+pastStart + 8 * 3600000),
      actualStartAt: pastStart,
      actualEndAt: new Date(+pastStart + 8 * 3600000),
      attendance: 'WORKED',
    }
  })
  await prisma.organizationMember.update({ where: { id: f.leaving.id }, data: { joinedAt: new Date('2020-01-01') } })
  await prisma.locationMember.update({
    where: { locationId_memberId: { locationId: f.org.locationId, memberId: f.leaving.id } },
    data: { joinedAt: new Date('2020-01-01') }
  })
  const month = monthKeyInZone(shift.scheduledStartAt, 'Europe/Moscow')
  const scope = <T>(work: () => T) => timesheetMutationContext.run({ userId: f.people[0].id, reason: 'Synthetic setup' }, () => f.scope(work))
  const before = await scope(() => readTimesheet(f.people[0].id, f.org.id, month))
  await scope(() => actOnTimesheet(f.people[0].id, f.org.id, month, { action: 'CLOSE', revision: before.period?.revision ?? 0, snapshotToken: before.snapshotToken }))
  const frozen = await scope(() => readTimesheetVersion(f.people[0].id, f.org.id, month, 1))
  await f.leave()
  assert.deepEqual(await scope(() => readTimesheetVersion(f.people[0].id, f.org.id, month, 1)), frozen)
  const after = await scope(() => readTimesheet(f.people[0].id, f.org.id, month))
  assert.equal(after.period?.status, 'CLOSED')
  await assert.rejects(prisma.workShift.update({ where: { id: shift.id }, data: { description: 'Forbidden edit' } }))
})

it('keeps future actual marks and refuses cross-organization or cross-member exit references in PostgreSQL', async () => {
  const f = await fixture()
  const accounted = await f.shift(5)
  await prisma.workShift.update({ where: { id: accounted.id }, data: { actualStartAt: accounted.scheduledStartAt } })
  const vacancy = await f.shift(3)
  const exit = await f.leave()
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: accounted.id } })).status, 'SCHEDULED')
  await assert.rejects(prisma.workShift.update({ where: { id: vacancy.id }, data: { actualStartAt: vacancy.scheduledStartAt } }))
  await assert.rejects(prisma.workShift.update({ where: { id: vacancy.id }, data: { memberId: f.replacement.id } }))
  const other = await fixture()
  const foreign = await other.shift()
  await assert.rejects(prisma.workShift.update({ where: { id: foreign.id }, data: { status: 'UNASSIGNED', selfExitId: exit.id } }))
  const foreignTask = await other.task()
  await assert.rejects(prisma.organizationRequest.update({ where: { id: foreignTask.id }, data: { selfExitId: exit.id } }))
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: vacancy.id } })).memberId, f.leaving.id)
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: foreign.id } })).status, 'SCHEDULED')
})

it('notifies a schedule manager without personnel rights and hides the case after losing schedule rights', async () => {
  const f = await fixture()
  const role = await prisma.accessRole.create({ data: {
    organizationId: f.org.id, name: 'Schedule manager', permissions: ['schedule.view', 'schedule.edit'],
  } })
  await prisma.organizationMember.update({ where: { id: f.replacement.id }, data: { accessConfigured: true, accessRoleId: role.id } })
  const outsider = await prisma.organizationMember.create({ data: { organizationId: f.org.id, userId: f.people[3].id } })
  await f.shift()
  const exit = await f.leave()
  const candidates = await exitCandidates(f.people[2].id, f.org.id, exit.id, (await getExitWork(f.people[2].id, f.org.id, exit.id)).shifts[0].id, 'shift', '', 1)
  assert.ok(!candidates.candidates.some(candidate => candidate.id === outsider.id))
  const history = await listNotificationHistory(f.people[2].id, f.people[2].email, { organizationId: f.org.id, limit: 20 })
  assert.ok(history.notifications.some(notification => notification.href?.includes(`selfExit=${exit.id}`)))
  await prisma.organizationMember.update({ where: { id: f.replacement.id }, data: { accessRoleId: null } })
  const hidden = await listNotificationHistory(f.people[2].id, f.people[2].email, { organizationId: f.org.id, limit: 20 })
  assert.ok(!hidden.notifications.some(notification => notification.href?.includes(`selfExit=${exit.id}`)))
})

it('treats restoring a vacancy to a rehired member as a new assignment and clears the old acknowledgement', async () => {
  const f = await fixture()
  const shift = await f.shift()
  await prisma.workShift.update({ where: { id: shift.id }, data: { assignmentReadAt: new Date() } })
  const exit = await f.leave()
  const invite = await f.scope(() => createCodeInvitation(f.people[0].id, f.org.id))
  await acceptCodeInvitation(f.people[1].id, f.people[1].email, invite.code)
  const work = await getExitWork(f.people[0].id, f.org.id, exit.id)
  await resolveExitShift(f.people[0].id, f.org.id, exit.id, shift.id, {
    memberId: f.leaving.id, updatedAt: work.shifts[0].updatedAt, acknowledgeWorkload: false, reason: '',
  })
  const changed = await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })
  assert.equal(changed.status, 'SCHEDULED')
  assert.equal(changed.assignmentReadAt, null)
  assert.equal(changed.selfExitId, null)
  assert.equal(await prisma.accountNotification.count({ where: { shiftId: shift.id, userId: f.people[1].id, type: 'SHIFT_ASSIGNED' } }), 1)
})
