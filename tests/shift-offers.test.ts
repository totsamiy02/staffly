import assert from 'node:assert/strict'
import { before, beforeEach, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/server/db.ts'
import { createOrganization } from '../src/server/organizations/organization-service.ts'
import { locationContext } from '../src/server/organizations/location-context.ts'
import { listNotificationHistory } from '../src/server/organizations/notification-service.ts'
import { createOffer, actOnOffer, listOffers, getOffer, saveOfferModes, offerCandidates, offerBody, offerListQuery } from '../src/server/schedule/offer-service.ts'
import { listSchedule, listMyUpcomingShifts, updateShift, cancelShift, getShift } from '../src/server/schedule/service.ts'
import { myStatistics } from '../src/server/schedule/statistics.ts'
import { statisticsQuery } from '../src/server/schedule/schemas.ts'

let defaultModes: string[]
let orgId: string, point: string, otherPoint: string, position: string
const accounts: Record<string, { id: string; email: string; memberId: string }> = {}
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected
const scope = <T>(fn: () => Promise<T>, locationId = point) => locationContext.run({ organizationId: orgId, locationId }, fn)
const modes = (transferMode: 'DISABLED' | 'AUTO' | 'APPROVAL' = 'AUTO', swapMode: 'DISABLED' | 'AUTO' | 'APPROVAL' = transferMode) => scope(() => saveOfferModes(accounts.owner.id, orgId, { transferMode, swapMode }))
async function shift(label = 'alice', date = '2038-10-12', start = '09:00', end = '17:00', locationId = point) {
  return prisma.workShift.create({ data: { organizationId: orgId, locationId, memberId: accounts[label].memberId, createdByMemberId: accounts.owner.memberId, positionId: position, positionNameSnapshot: 'Бариста', scheduledStartAt: new Date(`${date}T${start}:00+03:00`), scheduledEndAt: new Date(`${date}T${end}:00+03:00`) } })
}
const create = (sourceShiftId: string, patch: Record<string, unknown> = {}, actor = 'alice') => scope(() => createOffer(accounts[actor].id, orgId, offerBody.parse({ sourceShiftId, kind: 'TRANSFER', recipientMemberId: accounts.bob.memberId, ...patch })))
const action = (id: string, value: 'accept' | 'reject' | 'cancel' | 'approve' | 'decline', actor = 'bob') => scope(() => actOnOffer(accounts[actor].id, orgId, id, value))
const list = (tab = 'mine', actor = 'bob') => scope(() => listOffers(accounts[actor].id, orgId, offerListQuery.parse({ tab })))
const current = (id: string) => prisma.workShift.findUniqueOrThrow({ where: { id } })
const offerRow = (id: string) => prisma.shiftOffer.findUniqueOrThrow({ where: { id } })
const notices = (id: string, type?: 'SHIFT_OFFER_CREATED' | 'SHIFT_OFFER_APPROVAL' | 'SHIFT_OFFER_RESULT') => prisma.accountNotification.count({ where: { shiftOfferId: id, type } })
before(async () => {
  for (const label of ['owner', 'admin', 'alice', 'bob', 'charlie', 'wrongPosition', 'other', 'outsider']) {
    const user = await prisma.user.create({ data: { email: `offers-${label.toLowerCase()}-${randomUUID()}@example.test`, firstName: label, passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    accounts[label] = { id: user.id, email: user.email, memberId: '' }
  }
  const org = await createOrganization(accounts.owner.id, { name: 'Shift offer tests', description: null, timezone: 'Europe/Moscow', firstLocation: { name: 'Кофейня', city: 'Москва', address: 'Тест', timezone: 'Europe/Moscow' }, locations: [{ name: 'Другая точка', city: 'Омск', address: 'Тест', timezone: 'Asia/Omsk' }] })
  orgId = org.id; const initial = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } }); defaultModes = [initial.shiftTransferMode, initial.shiftSwapMode]; [point, otherPoint] = org.locations.map(p => p.id)
  accounts.owner.memberId = (await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId: accounts.owner.id } } })).id
  position = (await prisma.organizationPosition.create({ data: { organizationId: orgId, name: 'Бариста' } })).id
  for (const label of ['admin', 'alice', 'bob', 'charlie', 'wrongPosition', 'other']) {
    const member = await prisma.organizationMember.create({ data: { organizationId: orgId, userId: accounts[label].id, role: label === 'admin' ? 'ADMIN' : 'MEMBER' } }); accounts[label].memberId = member.id
    await prisma.locationMember.create({ data: { organizationId: orgId, memberId: member.id, locationId: label === 'other' ? otherPoint : point, role: label === 'admin' ? 'ADMIN' : 'MEMBER' } })
    if (label !== 'wrongPosition') await prisma.memberPosition.create({ data: { memberId: member.id, positionId: position } })
  }
})
beforeEach(async () => {
  await prisma.shiftOffer.deleteMany({ where: { organizationId: orgId } })
  await prisma.workShift.deleteMany({ where: { organizationId: orgId } })
  await prisma.employeeAbsence.deleteMany({ where: { organizationId: orgId } })
  await modes()
})
after(async () => {
  if (orgId) {
    await prisma.shiftOffer.deleteMany({ where: { organizationId: orgId } })
    await prisma.employeeAbsence.deleteMany({ where: { organizationId: orgId } })
    await prisma.workShift.deleteMany({ where: { organizationId: orgId } })
    await prisma.documentFolder.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
  }
  await prisma.user.deleteMany({ where: { id: { in: Object.values(accounts).map(a => a.id) } } }); await prisma.$disconnect()
})

describe('shift transfer and swap lifecycle', { concurrency: false }, () => {
  it('starts disabled, rejects employee/admin setting changes and disabled operations', async () => {
    assert.deepEqual(defaultModes, ['DISABLED', 'DISABLED'])
    await modes('DISABLED'); const s = await shift()
    await assert.rejects(create(s.id), code('OFFERS_DISABLED'))
    await assert.rejects(scope(() => saveOfferModes(accounts.admin.id, orgId, { transferMode: 'AUTO', swapMode: 'AUTO' })), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(scope(() => saveOfferModes(accounts.alice.id, orgId, { transferMode: 'AUTO', swapMode: 'AUTO' })), code('INSUFFICIENT_PERMISSIONS'))
    assert.equal(offerBody.safeParse({ sourceShiftId: s.id, kind: 'SWAP' }).success, false)
  })
  it('transfers an addressed shift and refreshes owner lists, hours, history and notices once', async () => {
    const s = await shift(); const o = await create(s.id)
    assert.equal((await current(s.id)).memberId, accounts.alice.memberId)
    assert.equal((await list()).counts.mine, 1)
    const assigned = await scope(() => listSchedule(accounts.alice.id, orgId, '2038-10-01', '2038-11-01'))
    assert.equal(assigned.shifts[0].activeOffer?.id, o.id)
    await action(o.id, 'accept'); await action(o.id, 'accept')
    assert.equal((await current(s.id)).memberId, accounts.bob.memberId)
    assert.equal((await current(s.id)).positionId, position)
    assert.equal((await current(s.id)).actualStartAt, null)
    assert.equal(await prisma.workShift.count({ where: { organizationId: orgId } }), 1)
    assert.equal((await scope(() => listMyUpcomingShifts(accounts.alice.id, orgId))).shifts.length, 0)
    assert.equal((await scope(() => listMyUpcomingShifts(accounts.bob.id, orgId))).shifts[0].id, s.id)
    const params = statisticsQuery.parse({ from: '2038-10-01', to: '2038-11-01' })
    assert.equal((await scope(() => myStatistics(accounts.alice.id, orgId, params))).period?.plannedMinutes ?? 0, 0)
    assert.equal((await scope(() => myStatistics(accounts.bob.id, orgId, params))).period?.plannedMinutes, 480)
    const detail = await scope(() => getShift(accounts.owner.id, orgId, s.id))
    assert.equal(detail.adjustments.length, 1); assert.equal(detail.adjustments[0].kind, 'TRANSFER')
    const metadata = detail.adjustments[0].assignmentChange as Record<string, string>
    assert.equal(metadata.initiatorMemberId, accounts.alice.memberId); assert.equal(metadata.acceptedByMemberId, accounts.bob.memberId)
    assert.equal(await notices(o.id, 'SHIFT_OFFER_CREATED'), 1); assert.equal(await notices(o.id, 'SHIFT_OFFER_RESULT'), 2)
    assert.equal(await prisma.shiftOfferReservation.count(), 0)
    const history = await scope(() => listNotificationHistory(accounts.bob.id, accounts.bob.email, { organizationId: orgId, locationId: point, category: 'SHIFT', limit: 50 }))
    assert.ok(history.notifications.some(n => n.shiftOfferId === o.id && n.href?.includes(`offer=${o.id}`) && n.href.includes(`location=${point}`)))
  })
  it('offers to qualified point staff only and lets exactly one concurrent claimant accept', async () => {
    const s = await shift(); const o = await create(s.id, { recipientMemberId: null })
    const delivered = await prisma.accountNotification.findMany({ where: { shiftOfferId: o.id }, select: { userId: true } })
    assert.ok(delivered.some(n => n.userId === accounts.bob.id)); assert.ok(!delivered.some(n => [accounts.alice.id, accounts.wrongPosition.id, accounts.other.id].includes(n.userId)))
    assert.equal((await list('available', 'bob')).offers.length, 1)
    assert.equal((await list('available', 'wrongPosition')).offers.length, 0)
    const results = await Promise.allSettled([action(o.id, 'accept', 'bob'), action(o.id, 'accept', 'charlie')])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.ok([accounts.bob.memberId, accounts.charlie.memberId].includes((await current(s.id)).memberId))
    assert.equal((await list('available', 'bob')).offers.length, 0); assert.equal((await list('available', 'charlie')).offers.length, 0)
    assert.equal(await notices(o.id, 'SHIFT_OFFER_RESULT'), 2)
  })
  it('swaps overlapping shifts atomically with two existing IDs and two audit rows', async () => {
    const a = await shift(), b = await shift('bob', '2038-10-12', '12:00', '20:00')
    const o = await create(a.id, { kind: 'SWAP', targetShiftId: b.id })
    assert.equal(await prisma.shiftOfferReservation.count({ where: { offerId: o.id } }), 2)
    await action(o.id, 'accept')
    assert.equal((await current(a.id)).memberId, accounts.bob.memberId); assert.equal((await current(b.id)).memberId, accounts.alice.memberId)
    assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: { in: [a.id, b.id] }, kind: 'SWAP' } }), 2)
    assert.equal(await prisma.workShift.count({ where: { organizationId: orgId } }), 2)
    assert.equal((await current(a.id)).scheduledStartAt.toISOString(), a.scheduledStartAt.toISOString())
  })
  it('waits for point approval and rejects self-approval and other-point administrators', async () => {
    await modes('APPROVAL'); const s = await shift(); const o = await create(s.id)
    await assert.rejects(action(o.id, 'decline', 'admin'), code('OFFER_NOT_ACCEPTED'))
    await action(o.id, 'accept'); assert.equal((await offerRow(o.id)).status, 'AWAITING_APPROVAL')
    assert.equal((await current(s.id)).memberId, accounts.alice.memberId)
    assert.equal(await notices(o.id, 'SHIFT_OFFER_APPROVAL'), 2)
    await assert.rejects(action(o.id, 'approve', 'alice'), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(action(o.id, 'approve', 'bob'), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(action(o.id, 'approve', 'other'), code('OFFER_NOT_FOUND'))
    assert.equal((await list('approval', 'admin')).counts.approval, 1)
    await action(o.id, 'approve', 'admin'); await action(o.id, 'approve', 'admin')
    assert.equal((await current(s.id)).memberId, accounts.bob.memberId)
    const audit = await prisma.workShiftAdjustment.findFirstOrThrow({ where: { shiftId: s.id } })
    assert.equal((audit.assignmentChange as Record<string, string>).reviewedByMemberId, accounts.admin.memberId)
    assert.equal((audit.assignmentChange as Record<string, string>).reviewedByMemberName, 'admin')
    assert.equal((audit.assignmentChange as Record<string, string>).initiatorMemberName, 'alice')
    assert.equal((audit.assignmentChange as Record<string, string>).acceptedByMemberName, 'bob')
    assert.equal(await notices(o.id, 'SHIFT_OFFER_RESULT'), 2)
  })
  it('approves a mutual swap and records the independent owner', async () => {
    await modes('AUTO', 'APPROVAL'); const a = await shift(), b = await shift('bob', '2038-10-13')
    const o = await create(a.id, { kind: 'SWAP', targetShiftId: b.id }); await action(o.id, 'accept')
    assert.equal((await current(a.id)).memberId, accounts.alice.memberId)
    await action(o.id, 'approve', 'owner')
    assert.equal((await current(a.id)).memberId, accounts.bob.memberId); assert.equal((await current(b.id)).memberId, accounts.alice.memberId)
  })
  it('releases both reservations on refusal and initiator cancellation', async () => {
    const a = await shift(), b = await shift('bob', '2038-10-13')
    const o = await create(a.id, { kind: 'SWAP', targetShiftId: b.id })
    await assert.rejects(create(b.id, { recipientMemberId: accounts.charlie.memberId }, 'bob'), code('SHIFT_RESERVED'))
    await action(o.id, 'reject'); assert.equal((await offerRow(o.id)).status, 'REJECTED')
    assert.equal(await prisma.shiftOfferReservation.count({ where: { offerId: o.id } }), 0)
    const next = await create(a.id, { kind: 'SWAP', targetShiftId: b.id }); await action(next.id, 'cancel', 'alice'); await action(next.id, 'cancel', 'alice')
    assert.equal((await offerRow(next.id)).status, 'CANCELLED')
    assert.equal((await current(a.id)).memberId, accounts.alice.memberId)
  })
  it('closes an administrator refusal without changing the assignment', async () => {
    await modes('APPROVAL'); const s = await shift(); const o = await create(s.id); await action(o.id, 'accept'); await action(o.id, 'decline', 'admin')
    assert.equal((await offerRow(o.id)).status, 'REJECTED'); assert.equal((await current(s.id)).memberId, accounts.alice.memberId)
    assert.equal(await prisma.shiftOfferReservation.count(), 0)
  })
  it('changes modes consistently, invalidates unfinished offers and never completes old modes', async () => {
    const s = await shift(); const o = await create(s.id); await modes('APPROVAL')
    assert.equal((await offerRow(o.id)).status, 'INVALID'); await assert.rejects(action(o.id, 'accept'), code('OFFER_CLOSED'))
    const next = await create(s.id); await action(next.id, 'accept'); await modes('DISABLED')
    assert.equal((await offerRow(next.id)).status, 'INVALID'); assert.equal((await current(s.id)).memberId, accounts.alice.memberId)
  })
  it('rejects offering another employee shift, wrong positions, another point and outsiders', async () => {
    const s = await shift(), other = await shift('other', '2038-10-13', '09:00', '17:00', otherPoint)
    await assert.rejects(create(s.id, {}, 'bob'), code('SHIFT_NOT_FOUND'))
    await assert.rejects(create(s.id, { recipientMemberId: accounts.wrongPosition.memberId }), code('POSITION_NOT_ASSIGNED'))
    await assert.rejects(create(s.id, { recipientMemberId: accounts.other.memberId }), code('MEMBER_NOT_IN_LOCATION'))
    await assert.rejects(create(s.id, { kind: 'SWAP', recipientMemberId: accounts.other.memberId, targetShiftId: other.id }), code('INVALID_SWAP_SHIFT'))
    await assert.rejects(scope(() => listOffers(accounts.outsider.id, orgId, offerListQuery.parse({}))), code('ORGANIZATION_NOT_FOUND'))
  })
  it('rejects shift overlaps and approved absences at creation and rechecks after acceptance', async () => {
    const s = await shift(); await shift('bob', '2038-10-12', '16:00', '20:00')
    await assert.rejects(create(s.id), code('SHIFT_OVERLAP'))
    await prisma.workShift.deleteMany({ where: { memberId: accounts.bob.memberId } })
    const absence = await prisma.employeeAbsence.create({ data: { organizationId: orgId, memberId: accounts.bob.memberId, type: 'DAY_OFF', startDate: new Date('2038-10-12'), endDate: new Date('2038-10-12') } })
    await assert.rejects(create(s.id), code('EMPLOYEE_ABSENT')); await prisma.employeeAbsence.delete({ where: { id: absence.id } })
    await modes('APPROVAL'); const o = await create(s.id); await action(o.id, 'accept')
    await shift('bob', '2038-10-12', '16:00', '20:00')
    await assert.rejects(action(o.id, 'approve', 'admin'), code('SHIFT_OVERLAP'))
    assert.equal((await offerRow(o.id)).status, 'INVALID'); assert.equal((await current(s.id)).memberId, accounts.alice.memberId)
  })
  it('checks both swap qualifications and both participants absences', async () => {
    const a = await shift(), b = await shift('bob', '2038-10-13')
    await prisma.employeeAbsence.create({ data: { organizationId: orgId, memberId: accounts.alice.memberId, type: 'VACATION', startDate: new Date('2038-10-13'), endDate: new Date('2038-10-13') } })
    await assert.rejects(create(a.id, { kind: 'SWAP', targetShiftId: b.id }), code('EMPLOYEE_ABSENT'))
  })
  it('rejects started, cancelled and actual-time shifts without moving actual hours', async () => {
    const past = await shift('alice', '2020-01-01'); await assert.rejects(create(past.id), code('SHIFT_STARTED'))
    const s = await shift(); await prisma.workShift.update({ where: { id: s.id }, data: { actualStartAt: new Date('2020-01-01T09:00:00Z'), actualEndAt: new Date('2020-01-01T17:00:00Z'), actualBreakMinutes: 0 } }); await assert.rejects(create(s.id), code('SHIFT_HAS_ACTUAL'))
    await prisma.workShift.update({ where: { id: s.id }, data: { actualStartAt: null, actualEndAt: null, actualBreakMinutes: null, status: 'CANCELLED', cancelledAt: new Date(), cancelledByMemberId: accounts.owner.memberId, cancellationReason: 'Тестовая отмена' } }); await assert.rejects(create(s.id), code('SHIFT_CANCELLED'))
  })
  it('invalidates administrative edits immediately, including position/description and both sides', async () => {
    const a = await shift(), b = await shift('bob', '2038-10-13')
    const o = await create(a.id, { kind: 'SWAP', targetShiftId: b.id })
    await scope(() => updateShift(accounts.owner.id, orgId, b.id, { memberId: accounts.bob.memberId, startDate: '2038-10-13', endDate: '2038-10-13', startTime: '09:00', endTime: '17:00', breakMinutes: 0, description: 'Новые условия', positionId: position }))
    assert.equal((await offerRow(o.id)).status, 'INVALID'); assert.equal(await prisma.shiftOfferReservation.count(), 0)
    const next = await create(a.id); await scope(() => cancelShift(accounts.owner.id, orgId, a.id, 'Тестовая отмена'))
    assert.equal((await offerRow(next.id)).status, 'INVALID'); assert.equal(await notices(next.id, 'SHIFT_OFFER_RESULT'), 2)
  })
  it('does not invalidate on notification read but detects expired and timezone-changed snapshots', async () => {
    const s = await shift(); const o = await create(s.id)
    await prisma.workShift.update({ where: { id: s.id }, data: { assignmentReadAt: new Date() } })
    assert.equal((await offerRow(o.id)).status, 'PENDING')
    await prisma.organizationLocation.update({ where: { id: point }, data: { timezone: 'Europe/Samara' } })
    try { await assert.rejects(action(o.id, 'accept'), code('SHIFT_CHANGED')); assert.equal((await offerRow(o.id)).status, 'INVALID') }
    finally { await prisma.organizationLocation.update({ where: { id: point }, data: { timezone: 'Europe/Moscow' } }) }
    const next = await create(s.id)
    // Simulate elapsed time with Date.now and Date constructor in this isolated test.
    const RealDate = Date
    class FutureDate extends RealDate { constructor(...args: [] | [string | number]) { super(args.length ? args[0] : RealDate.parse('2038-10-12T10:00:00+03:00')) } static now() { return RealDate.parse('2038-10-12T10:00:00+03:00') } }
    globalThis.Date = FutureDate as DateConstructor
    try { await list(); assert.equal((await offerRow(next.id)).status, 'EXPIRED') } finally { globalThis.Date = RealDate }
  })
  it('rechecks active membership and qualification on final confirmation', async () => {
    const s = await shift(); const o = await create(s.id)
    await prisma.memberPosition.delete({ where: { memberId_positionId: { memberId: accounts.bob.memberId, positionId: position } } })
    try { await assert.rejects(action(o.id, 'accept'), code('POSITION_NOT_ASSIGNED')); assert.equal((await current(s.id)).memberId, accounts.alice.memberId) }
    finally { await prisma.memberPosition.create({ data: { memberId: accounts.bob.memberId, positionId: position } }) }
    const next = await create(s.id)
    await prisma.locationMember.update({ where: { locationId_memberId: { locationId: point, memberId: accounts.bob.memberId } }, data: { leftAt: new Date() } })
    try { await assert.rejects(action(next.id, 'accept'), code('MEMBER_NOT_IN_LOCATION')) }
    finally { await prisma.locationMember.update({ where: { locationId_memberId: { locationId: point, memberId: accounts.bob.memberId } }, data: { leftAt: null } }) }
  })
  it('serializes concurrent offer creation for either side of an exchange', async () => {
    const a = await shift(), b = await shift('bob', '2038-10-13')
    const results = await Promise.allSettled([create(a.id, { kind: 'SWAP', targetShiftId: b.id }), create(b.id, { recipientMemberId: accounts.charlie.memberId }, 'bob')])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(await prisma.shiftOffer.count({ where: { organizationId: orgId } }), 1)
  })
  it('rolls back both assignments, audit and notifications if the second swap write fails', async () => {
    const a = await shift(), b = await shift('bob', '2038-10-13'), o = await create(a.id, { kind: 'SWAP', targetShiftId: b.id })
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_test_swap() RETURNS trigger AS $$ BEGIN IF NEW.id = '${b.id}'::uuid AND NEW.member_id <> OLD.member_id THEN RAISE EXCEPTION 'test swap failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_test_swap_trigger BEFORE UPDATE ON work_shifts FOR EACH ROW EXECUTE FUNCTION reject_test_swap()')
    try { await assert.rejects(action(o.id, 'accept')); assert.equal((await current(a.id)).memberId, accounts.alice.memberId); assert.equal((await current(b.id)).memberId, accounts.bob.memberId); assert.equal((await offerRow(o.id)).status, 'PENDING'); assert.equal(await notices(o.id, 'SHIFT_OFFER_RESULT'), 0); assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: a.id } }), 0); assert.equal(await prisma.shiftOfferReservation.count({ where: { offerId: o.id } }), 2) }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_test_swap_trigger ON work_shifts'); await prisma.$executeRawUnsafe('DROP FUNCTION reject_test_swap()') }
    await action(o.id, 'accept'); assert.equal((await current(b.id)).memberId, accounts.alice.memberId)
  })
  it('does not overwrite a concurrent administrator edit', async () => {
    const s = await shift(); const o = await create(s.id)
    const result = await Promise.allSettled([action(o.id, 'accept'), scope(() => updateShift(accounts.owner.id, orgId, s.id, { memberId: accounts.alice.memberId, startDate: '2038-10-12', endDate: '2038-10-12', startTime: '10:00', endTime: '18:00', breakMinutes: 0, description: null, positionId: position }))])
    assert.ok(result.some(r => r.status === 'fulfilled'))
    const final = await current(s.id), proposal = await offerRow(o.id)
    assert.ok(final.memberId === accounts.bob.memberId && proposal.status === 'COMPLETED' || final.memberId === accounts.alice.memberId && proposal.status === 'INVALID')
  })
  it('keeps candidate filters convenient while inaccessible offers and point approval remain guarded', async () => {
    const s = await shift(); const o = await create(s.id)
    const choices = await scope(() => offerCandidates(accounts.alice.id, orgId, s.id))
    assert.ok(choices.candidates.find(c => c.id === accounts.wrongPosition.memberId)?.transferReason)
    assert.ok(!choices.candidates.some(c => c.id === accounts.other.memberId))
    await assert.rejects(scope(() => getOffer(accounts.charlie.id, orgId, o.id)), code('OFFER_NOT_FOUND'))
    await assert.rejects(list('approval', 'bob'), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(scope(() => getOffer(accounts.bob.id, orgId, o.id), otherPoint), code('OFFER_NOT_FOUND'))
    await assert.rejects(action(o.id, 'reject', 'charlie'), code('OFFER_NOT_FOUND'))
    await action(o.id, 'cancel', 'alice')
    const open = await create(s.id, { recipientMemberId: null })
    const managerView = await scope(() => getOffer(accounts.owner.id, orgId, open.id))
    assert.equal(managerView.canAccept, false)
    assert.match(managerView.acceptanceReason!, /должность/)
  })
})
