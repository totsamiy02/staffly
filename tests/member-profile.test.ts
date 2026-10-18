import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/server/db.ts'
import { createOrganization } from '../src/server/organizations/organization-service.ts'
import { memberProfile, type MemberProfileOptions } from '../src/server/organizations/member-profile-service.ts'
import { locationContext } from '../src/server/organizations/location-context.ts'

const options: MemberProfileOptions = { month: '2026-09', page: 1, section: 'overview', kind: 'personal', requestState: 'all' }
const userIds: string[] = [], orgIds: string[] = []
let visibleDoc: string, hiddenDoc: string
let org: string, otherOrg: string, point: string, secondPoint: string, owner: string, employee: string, restricted: string, member: string, restrictedMember: string, otherMember: string
function scoped<T>(organizationId: string, locationId: string, run: () => T) { return locationContext.run({ organizationId, locationId }, run) }
function profile(userId: string, memberId: string, input: Partial<MemberProfileOptions> = {}, organizationId = org, locationId = point) { return scoped(organizationId, locationId, () => memberProfile(userId, organizationId, memberId, { ...options, ...input })) }
async function newUser(name: string) { const user = await prisma.user.create({ data: { email: `profile-${randomUUID()}@example.test`, passwordHash: 'test-only', firstName: name, phone: '+79990000000' } }); userIds.push(user.id); return user.id }
describe('organization member profiles', () => {
  before(async () => {
    owner = await newUser('Owner'); employee = await newUser('Employee'); restricted = await newUser('Restricted')
    const first = await createOrganization(owner, { name: 'Profile test', description: null, timezone: 'Europe/Moscow' }); org = first.id; point = first.locationId; orgIds.push(org)
    const other = await createOrganization(owner, { name: 'Other profile organization', description: null, timezone: 'Europe/Moscow' }); otherOrg = other.id; orgIds.push(otherOrg)
    const second = await prisma.organizationLocation.create({ data: { organizationId: org, name: 'Second', city: '', address: '', timezone: 'Europe/Moscow' } }); secondPoint = second.id
    member = (await prisma.organizationMember.create({ data: { organizationId: org, userId: employee, personnelNumber: 'ONE' } })).id
    otherMember = (await prisma.organizationMember.create({ data: { organizationId: otherOrg, userId: employee, personnelNumber: 'TWO' } })).id
    restrictedMember = (await prisma.organizationMember.create({ data: { organizationId: org, userId: restricted, accessConfigured: true, accessRoleId: (await prisma.accessRole.create({ data: { organizationId: org, name: 'Profile directory only', permissions: ['members.view'] } })).id } })).id
    await prisma.locationMember.createMany({ data: [{ organizationId: org, locationId: point, memberId: member }, { organizationId: org, locationId: point, memberId: restrictedMember }, { organizationId: otherOrg, locationId: other.locationId, memberId: otherMember }] })
    const ownerMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org, userId: owner } } })
    const shift = await prisma.workShift.create({ data: { organizationId: org, locationId: point, memberId: member, createdByMemberId: ownerMember.id, scheduledStartAt: new Date('2026-09-10T06:00:00Z'), scheduledEndAt: new Date('2026-09-10T14:00:00Z'), actualStartAt: new Date('2026-09-10T06:25:00Z'), actualEndAt: new Date('2026-09-10T14:00:00Z'), attendance: 'PARTIAL', breakMinutes: 0 } })
    await prisma.workShiftAdjustment.create({ data: { shiftId: shift.id, changedByMemberId: ownerMember.id, previousStartAt: shift.scheduledStartAt, previousEndAt: shift.scheduledEndAt, previousBreakMinutes: 0, newStartAt: shift.actualStartAt!, newEndAt: shift.actualEndAt!, newBreakMinutes: 0, reason: 'Test correction' } })
    await prisma.workShift.createMany({ data: [{ organizationId: org, locationId: point, memberId: member, createdByMemberId: ownerMember.id, scheduledStartAt: new Date('2026-09-11T06:00:00Z'), scheduledEndAt: new Date('2026-09-11T14:00:00Z'), attendance: 'NO_SHOW', breakMinutes: 0 }, { organizationId: org, locationId: secondPoint, memberId: member, createdByMemberId: ownerMember.id, scheduledStartAt: new Date('2026-09-12T06:00:00Z'), scheduledEndAt: new Date('2026-09-12T14:00:00Z'), breakMinutes: 0 }] })
    const hidden = await prisma.documentFolder.create({ data: { organizationId: org, locationId: point, name: 'Restricted parent', visibility: 'SELECTED', audienceMemberIds: [ownerMember.id] } })
    async function document(folderId: string | null) {
      const stored = await prisma.storedFile.create({ data: { organizationId: org, uploadedByUserId: owner, objectKey: `organizations/${org}/documents/${randomUUID()}.txt`, mimeType: 'text/plain', size: 4, checksumSha256: '0'.repeat(64), purpose: 'DOCUMENT' } })
      return prisma.document.create({ data: { organizationId: org, locationId: point, storedFileId: stored.id, uploadedByMemberId: ownerMember.id, displayName: 'Test document', fileName: 'test.txt', visibility: 'PRIVATE_MEMBER', targetMemberId: member, folderId } })
    }
    visibleDoc = (await document(null)).id
    hiddenDoc = (await document(hidden.id)).id
    for (let i = 0; i < 16; i++) await document(null)
    await prisma.documentAcknowledgement.createMany({ data: [visibleDoc, hiddenDoc].map(documentId => ({ documentId, memberId: member, assignedByMemberId: ownerMember.id })) })
    const requestType = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org, systemCode: 'DAY_OFF' } })
    await prisma.organizationRequest.createMany({ data: ['DRAFT', 'PENDING', 'APPROVED'].map(status => ({ organizationId: org, locationId: point, requestTypeId: requestType.id, typeNameSnapshot: requestType.name, systemCodeSnapshot: 'DAY_OFF' as const, createdByMemberId: member, status: status as 'DRAFT' | 'PENDING' | 'APPROVED', startDate: new Date('2026-09-15'), endDate: new Date('2026-09-15') })) })
  })
  after(async () => {
    await prisma.workShiftAdjustment.deleteMany({ where: { shift: { organizationId: { in: orgIds } } } })
    await prisma.workShift.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.documentAcknowledgement.deleteMany({ where: { document: { organizationId: { in: orgIds } } } })
    await prisma.document.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.documentFolder.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.organizationRequest.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  })
  it('keeps one user’s organization profiles separate without exposing retired metadata', async () => {
    const a = await profile(owner, member), otherPoint = await prisma.organizationLocation.findFirstOrThrow({ where: { organizationId: otherOrg } })
    const b = await profile(owner, otherMember, {}, otherOrg, otherPoint.id)
    assert.equal('personnelNumber' in a.member, false); assert.equal('personnelNumber' in b.member, false)
    assert.notEqual(a.member.id, b.member.id)
    await assert.rejects(profile(owner, otherMember), /Сотрудник не найден/)
  })
  it('shows own profile without granting access to another employee', async () => {
    await prisma.organizationMember.update({ where: { id: restrictedMember }, data: { accessRoleId: (await prisma.accessRole.create({ data: { organizationId: org, name: 'No directory', permissions: [] } })).id } })
    assert.equal((await profile(restricted, restrictedMember)).own, true)
    await assert.rejects(profile(restricted, member), /Недостаточно прав/)
  })
  it('redacts unavailable sections and private fields for a directory-only role', async () => {
    const role = await prisma.accessRole.findFirstOrThrow({ where: { organizationId: org, name: 'Profile directory only' } })
    await prisma.organizationMember.update({ where: { id: restrictedMember }, data: { accessRoleId: role.id } })
    const result = await profile(restricted, member)
    assert.equal(result.member.email, ''); assert.equal(result.member.phone, null); assert.equal('personnelNumber' in result.member, false)
    assert.equal(result.capabilities.time, false); assert.equal(result.capabilities.documents, false); assert.equal(result.capabilities.requests, false)
    assert.equal('overview' in result && result.overview.corrections, null)
    for (const section of ['time', 'documents', 'requests'] as const) await assert.rejects(profile(restricted, member, { section }), /недоступн/)
  })
  it('counts corrected time and no-shows using existing accounting, scoped to the selected point and month', async () => {
    const result = await profile(owner, member)
    assert.ok('overview' in result)
    assert.equal(result.overview.period?.workedMinutes, 455); assert.equal(result.overview.period?.workedShifts, 1); assert.equal(result.overview.corrections, 1)
    const time = await profile(owner, member, { section: 'time' }); assert.ok('time' in time); assert.equal(time.time.history.length, 2)
    const empty = await profile(owner, member, { month: '2026-08' }); assert.ok('overview' in empty); assert.equal(empty.overview.period?.workedMinutes, 0)
  })
  it('keeps folder restrictions and paginates personal documents without marking them opened', async () => {
    const first = await profile(employee, member, { section: 'documents' }); assert.ok('documents' in first)
    assert.equal(first.documents.pagination.total, 17); assert.equal(first.documents.documents.length, 15)
    assert.ok(!first.documents.documents.some(document => document.id === hiddenDoc))
    const second = await profile(employee, member, { section: 'documents', page: 2 }); assert.ok('documents' in second); assert.equal(second.documents.documents.length, 2)
    const acknowledgements = await profile(employee, member, { section: 'documents', kind: 'acknowledgements' }); assert.ok('documents' in acknowledgements)
    assert.equal(acknowledgements.documents.pagination.total, 1); assert.equal(acknowledgements.documents.documents[0].id, visibleDoc)
    const ack = await prisma.documentAcknowledgement.findFirstOrThrow({ where: { documentId: visibleDoc, memberId: member } }); assert.equal(ack.openedAt, null)
  })
  it('includes own drafts but never another employee’s drafts in profile requests', async () => {
    const self = await profile(employee, member, { section: 'requests' }); assert.ok('requests' in self); assert.equal(self.requests.pagination.total, 3)
    const manager = await profile(owner, member, { section: 'requests' }); assert.ok('requests' in manager); assert.equal(manager.requests.pagination.total, 2)
    assert.ok(!manager.requests.requests.some(request => request.status === 'DRAFT'))
    const pending = await profile(owner, member, { section: 'requests', requestState: 'pending' }); assert.ok('requests' in pending); assert.equal(pending.requests.pagination.total, 1)
  })
  it('rechecks point permissions when switching the profile location', async () => {
    const role = await prisma.accessRole.findFirstOrThrow({ where: { organizationId: org, name: 'Profile directory only' } })
    await prisma.organizationMember.update({ where: { id: restrictedMember }, data: { accessRoleId: null } })
    await prisma.accessAssignment.create({ data: { organizationId: org, memberId: restrictedMember, locationId: point, roleId: role.id } })
    await assert.rejects(profile(restricted, member, {}, org, secondPoint), /Недостаточно прав/)
    assert.equal((await profile(restricted, member)).member.id, member)
  })
  it('denies profiles after losing organization membership', async () => {
    await prisma.organizationMember.update({ where: { id: restrictedMember }, data: { leftAt: new Date() } })
    await assert.rejects(profile(restricted, member), /Организация не найдена/)
  })
})
