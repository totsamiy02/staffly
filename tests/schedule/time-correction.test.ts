import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createOrganization } from '../../src/server/organizations/organization-service.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { getTimeCorrection, saveTimeCorrection, timeCorrectionBody } from '../../src/server/schedule/time/time-correction-service.ts'
import { getShift } from '../../src/server/schedule/service.ts'
import { memberStatistics } from '../../src/server/schedule/time/statistics.ts'
import { resolveTimeCorrection } from '../../src/app/schedule/time/time-correction.ts'
import { localDateTimeIso } from '../../src/app/schedule/date-utils.ts'

let owner: string, employee: string, member: string, org: string, point: string, otherPoint: string, otherOrg: string, otherOrgPoint: string
const users: string[] = [], organizations: string[] = []
let sequence = 0
const scope = <T>(run: () => T, locationId = point, organizationId = org) => locationContext.run({ organizationId, locationId }, run)
async function newShift(active = false) {
  const base = Date.now() - (++sequence * 3 + 3) * 86400000
  return prisma.workShift.create({ data: { organizationId: org, locationId: point, memberId: member, createdByMemberId: member, scheduledStartAt: new Date(active ? Date.now() - 3600000 : base), scheduledEndAt: new Date(active ? Date.now() + 8 * 3600000 : base + 9 * 3600000) } })
}
const read = (id: string) => scope(() => getTimeCorrection(owner, org, id))
async function save(id: string, input: { mode: 'LATE' | 'EARLY' | 'NO_SHOW' | 'CUSTOM' | 'RESTORE'; startAt?: string; endAt?: string; comment?: string }, expectedUpdatedAt?: string) {
  const version = expectedUpdatedAt ?? (await read(id)).shift.updatedAt.toISOString()
  return scope(() => saveTimeCorrection(owner, org, id, { ...input, expectedUpdatedAt: version }))
}
describe('quick work-time correction', () => {
  before(async () => {
    for (const name of ['Owner', 'Employee']) { const user = await prisma.user.create({ data: { email: `time-${randomUUID()}@example.test`, passwordHash: 'test-only', firstName: name } }); users.push(user.id) }
    ;[owner, employee] = users
    const organization = await createOrganization(owner, { name: 'Time correction test', description: null, timezone: 'Europe/Moscow' })
    org = organization.id; point = organization.locationId; organizations.push(org)
    member = (await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org, userId: owner } } })).id
    const worker = await prisma.organizationMember.create({ data: { organizationId: org, userId: employee, role: 'MEMBER' } })
    await prisma.locationMember.create({ data: { organizationId: org, locationId: point, memberId: worker.id, role: 'MEMBER' } })
    otherPoint = (await prisma.organizationLocation.create({ data: { organizationId: org, name: 'Other', city: '', address: '', timezone: 'Asia/Yakutsk' } })).id
    const second = await createOrganization(owner, { name: 'Another organization', description: null, timezone: 'Europe/Moscow' }); otherOrg = second.id; otherOrgPoint = second.locationId; organizations.push(otherOrg)
  })
  after(async () => {
    const organizationId = { in: organizations }
    await prisma.workShiftAdjustment.deleteMany({ where: { shift: { organizationId } } })
    await prisma.workShift.deleteMany({ where: { organizationId } })
    await prisma.accountNotification.deleteMany({ where: { organizationId } })
    await prisma.documentFolder.updateMany({ where: { organizationId }, data: { parentId: null } })
    await prisma.documentFolder.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
    await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.$disconnect()
  })
  it('records arrival during an ongoing shift without claiming an actual departure', async () => {
    const shift = await newShift(true), arrival = new Date(+shift.scheduledStartAt + 20 * 60000).toISOString()
    const result = await save(shift.id, { mode: 'LATE', startAt: arrival })
    assert.equal(result.actualStartAt?.toISOString(), arrival); assert.equal(result.actualEndAt, null); assert.equal(result.attendance, 'UNCONFIRMED'); assert.equal(result.effectiveMinutes, 520)
    const stored = await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })
    assert.equal(+stored.scheduledStartAt, +shift.scheduledStartAt); assert.equal(+stored.scheduledEndAt, +shift.scheduledEndAt)
    const audit = await prisma.workShiftAdjustment.findFirstOrThrow({ where: { shiftId: shift.id } })
    assert.equal(audit.changedByMemberId, member); assert.equal(audit.reason, 'Опоздание'); assert.equal(audit.kind, 'TIME_CORRECTION')
  })
  it('preserves a previous early departure when correcting arrival again', async () => {
    const shift = await newShift()
    const departure = new Date(+shift.scheduledEndAt - 30 * 60000).toISOString()
    await save(shift.id, { mode: 'EARLY', endAt: departure })
    const result = await save(shift.id, { mode: 'LATE', startAt: new Date(+shift.scheduledStartAt + 20 * 60000).toISOString(), comment: 'Предупредил руководителя' })
    assert.equal(result.actualEndAt?.toISOString(), departure); assert.equal(result.effectiveMinutes, 490); assert.equal(result.attendance, 'PARTIAL')
    assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: shift.id } }), 2)
  })
  it('counts a no-show as zero and restores the plan without losing audit', async () => {
    const shift = await newShift()
    await save(shift.id, { mode: 'NO_SHOW' })
    const stats = await scope(() => memberStatistics(owner, org, member, { memberState: 'all', sort: 'name', direction: 'asc', page: 1, limit: 50 }))
    assert.equal(stats.history.find(item => item.id === shift.id)?.minutes, 0)
    const restored = await save(shift.id, { mode: 'RESTORE' })
    assert.equal(restored.attendance, 'UNCONFIRMED'); assert.equal(restored.actualStartAt, null); assert.equal(restored.actualEndAt, null); assert.equal(restored.effectiveMinutes, 540)
    const detail = await scope(() => getShift(owner, org, shift.id))
    assert.equal(detail.adjustments.length, 2); assert.equal(detail.adjustments[0].assignmentChange, null)
    assert.ok('timeCorrection' in detail.adjustments[0])
  })
  it('accepts a custom overnight interval in the point timezone', async () => {
    const shift = await newShift()
    const date = new Date(+shift.scheduledStartAt - 86400000).toISOString().slice(0, 10)
    const next = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)
    const result = await save(shift.id, { mode: 'CUSTOM', startAt: localDateTimeIso(date, '22:00', 'Asia/Yakutsk'), endAt: localDateTimeIso(next, '06:00', 'Asia/Yakutsk') })
    assert.equal(result.effectiveMinutes, 480); assert.equal(result.actualStartAt?.getUTCHours(), 13)
  })
  it('rejects future times, inverted ranges and future/cancelled shifts without adding audit', async () => {
    const shift = await newShift()
    for (const input of [{ mode: 'LATE' as const, startAt: new Date(Date.now() + 3600000).toISOString() }, { mode: 'EARLY' as const, endAt: shift.scheduledStartAt.toISOString() }, { mode: 'CUSTOM' as const, startAt: shift.scheduledEndAt.toISOString(), endAt: shift.scheduledStartAt.toISOString() }]) await assert.rejects(save(shift.id, input))
    assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: shift.id } }), 0)
    await prisma.workShift.update({ where: { id: shift.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Test cancellation', cancelledByMemberId: member } })
    await assert.rejects(save(shift.id, { mode: 'NO_SHOW' }), /после начала действующей/)
    await prisma.workShift.update({ where: { id: shift.id }, data: { status: 'SCHEDULED', cancelledAt: null, cancellationReason: null, cancelledByMemberId: null, scheduledStartAt: new Date(Date.now() + 86400000), scheduledEndAt: new Date(Date.now() + 2 * 86400000) } })
    await assert.rejects(save(shift.id, { mode: 'NO_SHOW' }), /после начала действующей/)
  })
  it('rejects a stale version rather than overwriting another correction', async () => {
    const shift = await newShift(), version = (await read(shift.id)).shift.updatedAt.toISOString()
    await save(shift.id, { mode: 'NO_SHOW' }, version)
    await assert.rejects(save(shift.id, { mode: 'RESTORE' }, version), /уже изменилась/)
    assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: shift.id } }), 1)
  })
  it('enforces organization, point and live permission boundaries on reads and writes', async () => {
    const shift = await newShift(), version = (await read(shift.id)).shift.updatedAt.toISOString()
    await assert.rejects(scope(() => getTimeCorrection(employee, org, shift.id)), /Недостаточно прав/)
    await assert.rejects(scope(() => saveTimeCorrection(employee, org, shift.id, { mode: 'NO_SHOW', expectedUpdatedAt: version })), /Недостаточно прав/)
    await assert.rejects(scope(() => getTimeCorrection(owner, org, shift.id), otherPoint), /Смена не найдена/)
    await assert.rejects(scope(() => saveTimeCorrection(owner, org, shift.id, { mode: 'NO_SHOW', expectedUpdatedAt: version }), otherPoint), /Смена не найдена/)
    await assert.rejects(scope(() => getTimeCorrection(owner, otherOrg, shift.id), otherOrgPoint, otherOrg), /Смена не найдена/)
  })
  it('saves only one of two concurrent corrections and returns a reviewable conflict', async () => {
    const shift = await newShift(), version = (await read(shift.id)).shift.updatedAt.toISOString()
    const results = await Promise.allSettled([save(shift.id, { mode: 'NO_SHOW' }, version), save(shift.id, { mode: 'RESTORE' }, version)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejected.reason.code, 'SHIFT_CHANGED')
    assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: shift.id } }), 1)
  })
  it('rechecks permissions after the correction form has been opened', async () => {
    const shift = await newShift()
    const role = await prisma.accessRole.create({ data: { organizationId: org, name: 'Temporary correction', permissions: ['schedule.view', 'schedule.actual'] } })
    const worker = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org, userId: employee } } })
    await prisma.organizationMember.update({ where: { id: worker.id }, data: { accessRoleId: role.id, accessConfigured: true } })
    const opened = await scope(() => getTimeCorrection(employee, org, shift.id))
    await prisma.accessRole.update({ where: { id: role.id }, data: { permissions: ['schedule.view'] } })
    await assert.rejects(scope(() => saveTimeCorrection(employee, org, shift.id, { mode: 'NO_SHOW', expectedUpdatedAt: opened.shift.updatedAt.toISOString() })), /Недостаточно прав/)
    assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: shift.id } }), 0)
  })
  it('validates the request schema and makes ongoing previews explicit', () => {
    assert.equal(timeCorrectionBody.safeParse({ mode: 'NO_SHOW' }).success, false)
    assert.equal(timeCorrectionBody.safeParse({ mode: 'CUSTOM', expectedUpdatedAt: new Date().toISOString(), comment: 'a'.repeat(401) }).success, false)
    const shift = { status: 'SCHEDULED' as const, scheduledStartAt: '2026-10-01T20:00:00Z', scheduledEndAt: '2026-10-02T05:00:00Z', actualStartAt: null, actualEndAt: null, actualBreakMinutes: null }
    const result = resolveTimeCorrection(shift, { mode: 'LATE', startAt: '2026-10-01T20:20:00Z' }, Date.parse('2026-10-01T21:00:00Z'))
    assert.equal(result.minutes, 520); assert.equal(result.provisional, true)
  })
})
