import { saveTimeCorrection } from '../../src/server/schedule/time/time-correction-service.ts'
import { cancelShift } from '../../src/server/schedule/service.ts'
import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { createPartialOffer, partialOfferBody } from '../../src/server/schedule/partial-shifts.ts'
import { actOnOffer, listOffers, offerListQuery } from '../../src/server/schedule/offer-service.ts'

const fixtureOrganizations: string[] = []
afterEach(async () => { await prisma.shiftOffer.deleteMany({ where: { organizationId: { in: fixtureOrganizations } } }) })
after(() => prisma.$disconnect())
async function fixture() {
  const users = await Promise.all(['owner', 'first', 'second', 'third'].map(firstName => prisma.user.create({ data: { email: randomUUID() + '@example.test', firstName, emailVerifiedAt: new Date() } })))
  const org = await createBusinessOrganization(users[0].id, { name: 'Partial test', description: null, timezone: 'Europe/Moscow' })
  fixtureOrganizations.push(org.id)
  await prisma.organization.update({ where: { id: org.id }, data: { shiftTransferMode: 'AUTO' } })
  const members = [await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: users[0].id } } })]
  for (const user of users.slice(1)) {
    const member = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } })
    await prisma.locationMember.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: member.id } })
    members.push(member)
  }
  const source = await prisma.workShift.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: members[1].id, createdByMemberId: members[0].id, scheduledStartAt: new Date(Date.now() - 3 * 3600000), scheduledEndAt: new Date(Date.now() + 4 * 3600000) } })
  const body = partialOfferBody.parse({ sourceShiftId: source.id, creationKey: randomUUID(), expectedUpdatedAt: source.updatedAt.toISOString(), firstEndAt: new Date(Date.now() - 3600000).toISOString(), replacementStartAt: new Date(Date.now() + 1800000).toISOString(), firstBreakMinutes: 15, replacementBreakMinutes: 20, reason: 'Сотрудник ушёл домой' })
  const at = <T>(work: () => Promise<T>) => locationContext.run({ organizationId: org.id, locationId: org.locationId }, work)
  const create = (patch = {}, userId = users[0].id) => at(() => createPartialOffer(userId, org.id, { ...body, ...patch }))
  return { org, users, members, source, body, at, create }
}

test('direct replacement preserves first worker, gap and history; retry creates one child', async () => {
  const f = await fixture()
  const input = { direct: true, recipientMemberId: f.members[2].id }
  const result = await f.create(input)
  assert.equal(result.status, 'COMPLETED')
  const first = await prisma.workShift.findUniqueOrThrow({ where: { id: f.source.id } })
  const children = await prisma.workShift.findMany({ where: { replacementOfId: first.id } })
  await assert.rejects(f.at(() => saveTimeCorrection(f.users[0].id, f.org.id, first.id, { mode: 'CUSTOM', expectedUpdatedAt: first.updatedAt.toISOString(), startAt: first.actualStartAt!.toISOString(), endAt: new Date(Date.now() - 60000).toISOString() })), error => (error as {code?:string}).code === 'PARTIAL_SHIFT_BOUNDARY')
  assert.equal(first.memberId, f.members[1].id)
  assert.equal(first.actualEndAt!.toISOString(), f.body.firstEndAt)
  assert.equal(first.actualBreakMinutes, 15)
  assert.equal(children.length, 1)
  assert.equal(children[0].memberId, f.members[2].id)
  assert.equal(children[0].scheduledStartAt.toISOString(), f.body.replacementStartAt)
  assert.equal(children[0].breakMinutes, 20)
  assert(children[0].scheduledStartAt > first.scheduledEndAt)
  assert.equal((await f.create(input)).id, result.id)
  assert.equal(await prisma.workShift.count({ where: { replacementOfId: first.id } }), 1)
  await assert.rejects(prisma.workShift.update({ where: { id: first.id }, data: { actualEndAt: f.source.scheduledEndAt } }))
  await assert.rejects(prisma.workShift.update({ where: { id: children[0].id }, data: { actualStartAt: f.source.scheduledStartAt } }))
  assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: first.id } }), 1)
})

test('open remainder is visible, two concurrent claimants produce one replacement', async () => {
  const f = await fixture()
  const offer = await f.create()
  await assert.rejects(f.at(() => actOnOffer(f.users[1].id, f.org.id, offer.id, 'accept')))
  const available = await f.at(() => listOffers(f.users[2].id, f.org.id, offerListQuery.parse({ tab: 'available' })))
  assert(available.offers.some(row => row.id === offer.id))
  const results = await Promise.allSettled([2, 3].map(index => f.at(() => actOnOffer(f.users[index].id, f.org.id, offer.id, 'accept'))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(await prisma.workShift.count({ where: { replacementOfId: f.source.id } }), 1)
})

test('cancelling search keeps worked interval and creates no assigned remainder', async () => {
  const f = await fixture()
  const offer = await f.create()
  await f.at(() => actOnOffer(f.users[0].id, f.org.id, offer.id, 'cancel'))
  const source = await prisma.workShift.findUniqueOrThrow({ where: { id: f.source.id } })
  assert.equal(source.actualEndAt!.toISOString(), f.body.firstEndAt)
  assert.equal(await prisma.workShift.count({ where: { replacementOfId: source.id } }), 0)
})

test('employee request requires approval; cannot close someone else or assign directly', async () => {
  const f = await fixture()
  await assert.rejects(f.create({}, f.users[2].id))
  await assert.rejects(f.create({ direct: true, recipientMemberId: f.members[2].id }, f.users[1].id))
  const offer = await f.create({}, f.users[1].id)
  assert.equal(offer.mode, 'APPROVAL')
  await f.at(() => actOnOffer(f.users[2].id, f.org.id, offer.id, 'accept'))
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: f.source.id } })).actualEndAt, null)
  const approved = await f.at(() => actOnOffer(f.users[0].id, f.org.id, offer.id, 'approve'))
  assert.equal(approved.partial?.prepared, true)
  assert.equal(await prisma.workShift.count({ where: { replacementOfId: f.source.id } }), 1)
})

test('bad ranges, stale revision and overlapping replacement roll back without changing first worker', async () => {
  const f = await fixture()
  await assert.rejects(f.create({ replacementStartAt: f.source.scheduledStartAt.toISOString() }))
  await assert.rejects(f.create({ expectedUpdatedAt: new Date(0).toISOString() }))
  await prisma.workShift.create({ data: { organizationId: f.org.id, locationId: f.org.locationId, memberId: f.members[2].id, createdByMemberId: f.members[0].id, scheduledStartAt: new Date(f.body.replacementStartAt), scheduledEndAt: f.source.scheduledEndAt } })
  await assert.rejects(f.create({ recipientMemberId: f.members[2].id, direct: true }))
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: f.source.id } })).actualEndAt, null)
  assert.equal(await prisma.shiftOffer.count({ where: { organizationId: f.org.id } }), 0)
})

test('search can be published again after cancellation without closing the first worker twice', async () => {
  const f = await fixture()
  const offer = await f.create()
  await f.at(() => actOnOffer(f.users[0].id, f.org.id, offer.id, 'cancel'))
  const first = await prisma.workShift.findUniqueOrThrow({ where: { id: f.source.id } })
  const repeated = await f.create({ creationKey: randomUUID(), expectedUpdatedAt: first.updatedAt.toISOString() })
  assert.equal(repeated.source.endAt, f.source.scheduledEndAt.toISOString())
  await f.at(() => actOnOffer(f.users[2].id, f.org.id, repeated.id, 'accept'))
  assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: first.id } }), 1)
  assert.equal(await prisma.workShift.count({ where: { replacementOfId: first.id } }), 1)
})

test('revoked membership at acceptance cannot create work for the replacement', async () => {
  const f = await fixture()
  const offer = await f.create({ recipientMemberId: f.members[2].id })
  await prisma.organizationMember.update({ where: { id: f.members[2].id }, data: { leftAt: new Date() } })
  await assert.rejects(f.at(() => actOnOffer(f.users[2].id, f.org.id, offer.id, 'accept')))
  assert.equal(await prisma.workShift.count({ where: { replacementOfId: f.source.id } }), 0)
})

test('direct assignment enforces monthly workload and rolls back first-worker time on warning', async () => {
  const f = await fixture()
  await prisma.organizationLocation.update({ where: { id: f.org.locationId }, data: { monthlyWorkMinutes: 1 } })
  const assignment = { direct: true, recipientMemberId: f.members[2].id }
  await assert.rejects(f.create(assignment), error => (error as { code?: string }).code === 'WORKLOAD_WARNING')
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: f.source.id } })).actualEndAt, null)
  assert.equal((await f.create({ ...assignment, acknowledgeWorkload: true })).status, 'COMPLETED')
})


test('reading an assignment does not invalidate the remaining interval', async () => {
  const f = await fixture()
  const offer = await f.create({ recipientMemberId: f.members[2].id })
  await prisma.workShift.update({ where: { id: f.source.id }, data: { assignmentReadAt: new Date() } })
  assert.equal((await f.at(() => actOnOffer(f.users[2].id, f.org.id, offer.id, 'accept'))).status, 'COMPLETED')
})


test('a started replacement cannot be cancelled away; its remainder can pass to a third worker', async () => {
  const f = await fixture()
  await f.create({ direct: true, recipientMemberId: f.members[2].id, replacementStartAt: new Date(Date.now() - 1800000).toISOString() })
  const child = await prisma.workShift.findFirstOrThrow({ where: { replacementOfId: f.source.id } })
  await assert.rejects(f.at(() => cancelShift(f.users[0].id, f.org.id, child.id, 'Передача остатка')), error => (error as {code?:string}).code === 'PARTIAL_WORK_RECORDED')
  await f.create({ sourceShiftId: child.id, expectedUpdatedAt: child.updatedAt.toISOString(), creationKey: randomUUID(),
    firstEndAt: new Date(Date.now() - 600000).toISOString(), replacementStartAt: new Date().toISOString(),
    firstBreakMinutes: 0, replacementBreakMinutes: 0, direct: true, recipientMemberId: f.members[3].id })
  assert.equal(await prisma.workShift.count({ where: { replacementOfId: child.id } }), 1)
  assert((await prisma.workShift.findUniqueOrThrow({ where: { id: child.id } })).actualEndAt)
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: f.source.id } })).actualEndAt!.toISOString(), f.body.firstEndAt)
})
