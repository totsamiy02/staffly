import assert from 'node:assert/strict'
import { after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { memberBulkBody, type MemberBulkInput, type MemberBulkTarget } from '../../src/shared/member-bulk.ts'
import { applyMemberBulk, memberBulkCandidates } from '../../src/server/organizations/member-bulk-service.ts'
import { savePosition, assignPositions } from '../../src/server/schedule/planning/planning.ts'
import { documentMembers, assignAcknowledgements } from '../../src/server/documents/service.ts'

const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected
after(() => prisma.$disconnect())

async function fixture() {
  const owner = await prisma.user.create({ data: { email: `bulk-owner-${randomUUID()}@example.test`, firstName: 'Владелец', emailVerifiedAt: new Date() } })
  const org = await createBusinessOrganization(owner.id, { name: 'Массовые назначения', timezone: 'Europe/Moscow', description: null, locations: [{ name: 'Северная', timezone: 'Europe/Moscow', city: 'Тест', address: 'Тест' }] })
  const [point, north] = org.locations
  const ownerMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } })
  const people = []
  for (const name of ['Анна', 'Михаил', 'Руководитель']) {
    const user = await prisma.user.create({ data: { email: `bulk-${randomUUID()}@example.test`, firstName: name, emailVerifiedAt: new Date() } })
    const member = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } })
    await prisma.locationMember.create({ data: { organizationId: org.id, locationId: point.id, memberId: member.id } })
    people.push({ ...member, user })
  }
  const role = await prisma.accessRole.create({ data: { organizationId: org.id, name: 'Назначение', permissions: ['members.view', 'members.positions', 'members.assign', 'documents.view', 'documents.control', 'documents.assign'] } })
  await prisma.organizationMember.update({ where: { id: people[2].id }, data: { accessConfigured: true } })
  await prisma.accessAssignment.create({ data: { organizationId: org.id, memberId: people[2].id, locationId: point.id, roleId: role.id } })
  const position = await prisma.organizationPosition.create({ data: { organizationId: org.id, name: 'Бариста' } })
  const other = await prisma.organizationPosition.create({ data: { organizationId: org.id, name: 'Кассир' } })
  return { owner, ownerMember, org, point, north, a: people[0], b: people[1], manager: people[2], role, position, other }
}
async function input(f: Awaited<ReturnType<typeof fixture>>, target: MemberBulkTarget, ids: string[], userId = f.owner.id): Promise<MemberBulkInput> {
  const data = await memberBulkCandidates(userId, f.org.id, target)
  return memberBulkBody.parse({ ...target, requestKey: randomUUID(), rows: ids.map(memberId => ({ memberId, action: 'ADD', revision: data.members.find(member => member.id === memberId)?.revision ?? '0'.repeat(64) })) })
}
async function document(f: Awaited<ReturnType<typeof fixture>>, selected?: string[]) {
  const file = await prisma.storedFile.create({ data: { organizationId: f.org.id, uploadedByUserId: f.owner.id, objectKey: `organizations/${f.org.id}/documents/${randomUUID()}.txt`, size: 1, checksumSha256: '0'.repeat(64), purpose: 'DOCUMENT', mimeType: 'text/plain' } })
  const folder = await prisma.documentFolder.create({ data: { organizationId: f.org.id, locationId: f.point.id, name: 'Регламенты', visibility: selected ? 'SELECTED' : 'ORGANIZATION', audienceMemberIds: selected ?? [] } })
  return prisma.document.create({ data: { organizationId: f.org.id, locationId: f.point.id, folderId: folder.id, storedFileId: file.id, uploadedByMemberId: f.ownerMember.id, displayName: 'Регламент', fileName: 'rules.txt', visibility: 'ORGANIZATION', inheritAccess: true } })
}

it('adds a position without removing existing positions and repeats one operation exactly once, including after undo', async () => {
  const f = await fixture()
  await assignPositions(f.owner.id, f.org.id, f.a.id, [f.other.id])
  const target = { kind: 'POSITION' as const, targetId: f.position.id }
  const body = await input(f, target, [f.a.id, f.b.id])
  const [first, repeated] = await Promise.all([applyMemberBulk(f.owner.id, f.org.id, body), applyMemberBulk(f.owner.id, f.org.id, body)])
  assert.deepEqual(first, repeated)
  assert.equal(first.rows.filter(row => row.status === 'APPLIED').length, 2)
  assert.equal(await prisma.memberPosition.count({ where: { memberId: f.a.id } }), 2)
  assert.equal(await prisma.accessAudit.count({ where: { organizationId: f.org.id, action: 'MEMBER_BULK_ASSIGNED' } }), 1)
  const audit = await prisma.accessAudit.findFirstOrThrow({ where: { organizationId: f.org.id, action: 'MEMBER_BULK_ASSIGNED' } })
  assert.equal(await prisma.securityEvent.count({ where: { organizationId: f.org.id, action: 'ACCESS_CHANGED', resourceId: audit.id } }), 1)
  await prisma.memberPosition.delete({ where: { memberId_positionId: { memberId: f.a.id, positionId: f.position.id } } })
  assert.deepEqual(await applyMemberBulk(f.owner.id, f.org.id, body), first)
  assert.equal(await prisma.memberPosition.count({ where: { memberId: f.a.id, positionId: f.position.id } }), 0)
  await assert.rejects(applyMemberBulk(f.owner.id, f.org.id, { ...body, rows: [body.rows[0]] }), code('BULK_KEY_CONFLICT'))
})

it('returns individual results for existing, departed and foreign members without leaking foreign identities', async () => {
  const f = await fixture()
  await assignPositions(f.owner.id, f.org.id, f.a.id, [f.position.id])
  const body = await input(f, { kind: 'POSITION', targetId: f.position.id }, [f.a.id, f.b.id, randomUUID()])
  await prisma.organizationMember.update({ where: { id: f.b.id }, data: { leftAt: new Date() } })
  const result = await applyMemberBulk(f.owner.id, f.org.id, body)
  assert.deepEqual(result.rows.map(row => row.status), ['UNCHANGED', 'FAILED', 'FAILED'])
  assert.equal(await prisma.memberPosition.count({ where: { memberId: f.b.id } }), 0)
  assert.ok(!JSON.stringify(result).includes('Михаил'))
})

it('rejects stale consequences and inactive positions without overwriting a concurrent edit', async () => {
  const f = await fixture()
  const body = await input(f, { kind: 'POSITION', targetId: f.position.id }, [f.a.id, f.b.id])
  await assignPositions(f.owner.id, f.org.id, f.a.id, [f.other.id])
  const result = await applyMemberBulk(f.owner.id, f.org.id, body)
  assert.deepEqual(result.rows.map(row => row.status), ['FAILED', 'APPLIED'])
  assert.equal(await prisma.memberPosition.count({ where: { memberId: f.a.id, positionId: f.other.id } }), 1)
  const stale = await input(f, { kind: 'POSITION', targetId: f.position.id }, [f.a.id])
  await savePosition(f.owner.id, f.org.id, f.position.id, { name: f.position.name, isActive: false })
  await assert.rejects(applyMemberBulk(f.owner.id, f.org.id, stale), code('POSITION_NOT_FOUND'))
})

it('checks live rights and each member scope rather than treating bulk access as a new permission', async () => {
  const f = await fixture()
  const target = { kind: 'POSITION' as const, targetId: f.position.id }
  const body = await input(f, target, [f.a.id], f.manager.userId)
  await prisma.accessRole.update({ where: { id: f.role.id }, data: { permissions: ['members.view'] } })
  await assert.rejects(applyMemberBulk(f.manager.userId, f.org.id, body), code('INSUFFICIENT_PERMISSIONS'))
  await assert.rejects(memberBulkCandidates(f.a.userId, f.org.id, target), code('INSUFFICIENT_PERMISSIONS'))
  const foreign = await createBusinessOrganization(f.owner.id, { name: 'Другой контур', timezone: 'Europe/Moscow', description: null })
  const foreignPosition = await prisma.organizationPosition.create({ data: { organizationId: foreign.id, name: 'Чужая должность' } })
  await assert.rejects(memberBulkCandidates(f.owner.id, f.org.id, { kind: 'POSITION', targetId: foreignPosition.id }), code('POSITION_NOT_FOUND'))
  assert.equal(await prisma.memberPosition.count({ where: { memberId: f.a.id } }), 0)
})

it('adds a location without removing other placements, assigning roles, or changing positions', async () => {
  const f = await fixture()
  await assignPositions(f.owner.id, f.org.id, f.a.id, [f.other.id])
  const target = { kind: 'LOCATION' as const, targetId: f.north.id }
  const body = await input(f, target, [f.a.id])
  const before = await prisma.organizationMember.findUniqueOrThrow({ where: { id: f.a.id } })
  assert.equal((await applyMemberBulk(f.owner.id, f.org.id, body)).rows[0].status, 'APPLIED')
  assert.equal(await prisma.locationMember.count({ where: { memberId: f.a.id, leftAt: null } }), 2)
  assert.equal(await prisma.memberPosition.count({ where: { memberId: f.a.id, positionId: f.other.id } }), 1)
  assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: f.a.id } })).accessRoleId, before.accessRoleId)
  assert.equal(await prisma.accessAssignment.count({ where: { memberId: f.a.id } }), 0)
  await prisma.locationMember.update({ where: { locationId_memberId: { locationId: f.north.id, memberId: f.a.id } }, data: { leftAt: new Date() } })
  await applyMemberBulk(f.owner.id, f.org.id, body)
  assert.equal(await prisma.locationMember.count({ where: { memberId: f.a.id, locationId: f.north.id, leftAt: null } }), 0)
})

it('enforces location quota, archived locations and the owner-only administrator restriction', async () => {
  const f = await fixture()
  const target = { kind: 'LOCATION' as const, targetId: f.north.id }
  const body = await input(f, target, [f.a.id])
  await prisma.organizationSubscription.update({ where: { organizationId: f.org.id }, data: { plan: 'FREE', trialEndsAt: null } })
  await assert.rejects(applyMemberBulk(f.owner.id, f.org.id, body), code('SUBSCRIPTION_LIMIT_REACHED'))
  assert.equal(await prisma.locationMember.count({ where: { memberId: f.a.id, locationId: f.north.id } }), 0)
  await prisma.organizationLocation.update({ where: { id: f.north.id }, data: { archivedAt: new Date() } })
  await assert.rejects(memberBulkCandidates(f.owner.id, f.org.id, target), code('LOCATION_NOT_FOUND'))
})

it('preserves acknowledgement history and creates one notification per new recipient across retries', async () => {
  const f = await fixture()
  const doc = await document(f)
  const target = { kind: 'DOCUMENT' as const, targetId: doc.id }
  const body = { ...await input(f, target, [f.a.id, f.b.id]), deadline: '2026-12-31', comment: 'Проверить регламент' }
  const first = await applyMemberBulk(f.owner.id, f.org.id, body)
  assert.deepEqual(await applyMemberBulk(f.owner.id, f.org.id, body), first)
  assert.equal(await prisma.documentAcknowledgement.count({ where: { documentId: doc.id } }), 2)
  assert.equal(await prisma.accountNotification.count({ where: { documentId: doc.id, type: 'DOCUMENT_ASSIGNED' } }), 2)
  const ack = await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId_memberId: { documentId: doc.id, memberId: f.a.id } } })
  assert.equal(ack.deadline?.toISOString().slice(0, 10), body.deadline)
  assert.equal(ack.comment, body.comment)
  assert.equal(ack.assignedByMemberId, f.ownerMember.id)
  const candidates = await memberBulkCandidates(f.owner.id, f.org.id, target)
  const cancel = memberBulkBody.parse({ ...target, requestKey: randomUUID(), rows: [{ memberId: f.a.id, action: 'CANCEL', revision: candidates.members.find(member => member.id === f.a.id)!.cancelRevision }] })
  assert.equal((await applyMemberBulk(f.owner.id, f.org.id, cancel)).rows[0].status, 'APPLIED')
  const cancelled = await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { id: ack.id } })
  assert.ok(cancelled.cancelledAt)
  assert.equal(cancelled.assignedAt.toISOString(), ack.assignedAt.toISOString())
  const again = await input(f, target, [f.a.id])
  assert.equal((await applyMemberBulk(f.owner.id, f.org.id, again)).rows[0].status, 'FAILED')
  assert.equal(await prisma.accountNotification.count({ where: { documentId: doc.id, userId: f.a.userId, type: 'DOCUMENT_ASSIGNED' } }), 1)
})

it('requires the owner to restore a previous administrator placement, even after the organization role changed', async () => {
  const f = await fixture()
  await prisma.accessAssignment.create({ data: { organizationId: f.org.id, memberId: f.manager.id, locationId: f.north.id, roleId: f.role.id } })
  await prisma.locationMember.create({ data: { organizationId: f.org.id, locationId: f.north.id, memberId: f.a.id, role: 'ADMIN', leftAt: new Date() } })
  const target = { kind: 'LOCATION' as const, targetId: f.north.id }
  const candidates = await memberBulkCandidates(f.manager.userId, f.org.id, target)
  assert.equal(candidates.members.find(member => member.id === f.a.id)!.status, 'BLOCKED')
  const denied = await input(f, target, [f.a.id], f.manager.userId)
  assert.equal((await applyMemberBulk(f.manager.userId, f.org.id, denied)).rows[0].status, 'FAILED')
  assert.ok((await prisma.locationMember.findUniqueOrThrow({ where: { locationId_memberId: { locationId: f.north.id, memberId: f.a.id } } })).leftAt)
  const allowed = await input(f, target, [f.a.id])
  assert.equal((await applyMemberBulk(f.owner.id, f.org.id, allowed)).rows[0].status, 'APPLIED')
})

it('serializes competing additions at the position limit without granting a twenty-first position', async () => {
  const f = await fixture()
  const positions = await prisma.organizationPosition.createManyAndReturn({ data: Array.from({ length: 19 }, (_, index) => ({ organizationId: f.org.id, name: `Должность ${index}` })) })
  await assignPositions(f.owner.id, f.org.id, f.a.id, positions.map(position => position.id))
  const first = await input(f, { kind: 'POSITION', targetId: f.position.id }, [f.a.id])
  const second = await input(f, { kind: 'POSITION', targetId: f.other.id }, [f.a.id])
  const results = await Promise.all([applyMemberBulk(f.owner.id, f.org.id, first), applyMemberBulk(f.owner.id, f.org.id, second)])
  assert.deepEqual(results.map(result => result.rows[0].status).sort(), ['APPLIED', 'FAILED'])
  assert.equal(await prisma.memberPosition.count({ where: { memberId: f.a.id } }), 20)
})

it('does not grant document access and rechecks parent folders between preview and assignment', async () => {
  const f = await fixture()
  const doc = await document(f, [f.a.id])
  const target = { kind: 'DOCUMENT' as const, targetId: doc.id }
  const candidates = await memberBulkCandidates(f.owner.id, f.org.id, target)
  assert.equal(candidates.members.find(member => member.id === f.b.id)!.status, 'BLOCKED')
  const body = await input(f, target, [f.a.id, f.b.id])
  await prisma.documentFolder.update({ where: { id: doc.folderId! }, data: { audienceMemberIds: [f.b.id] } })
  const result = await applyMemberBulk(f.owner.id, f.org.id, body)
  assert.ok(result.rows.every(row => row.status === 'FAILED'))
  assert.equal(await prisma.documentAcknowledgement.count({ where: { documentId: doc.id } }), 0)
})

it('cannot cancel an acknowledgement confirmed after preview, and keeps successful rows independent', async () => {
  const f = await fixture()
  const doc = await document(f)
  const target = { kind: 'DOCUMENT' as const, targetId: doc.id }
  await applyMemberBulk(f.owner.id, f.org.id, await input(f, target, [f.a.id]))
  const candidates = await memberBulkCandidates(f.owner.id, f.org.id, target)
  const add = await input(f, target, [f.b.id])
  const body = memberBulkBody.parse({ ...add, rows: [...add.rows, { memberId: f.a.id, action: 'CANCEL', revision: candidates.members.find(member => member.id === f.a.id)!.cancelRevision }] })
  await prisma.documentAcknowledgement.update({ where: { documentId_memberId: { documentId: doc.id, memberId: f.a.id } }, data: { acknowledgedAt: new Date() } })
  const result = await applyMemberBulk(f.owner.id, f.org.id, body)
  assert.deepEqual(result.rows.map(row => row.status), ['APPLIED', 'FAILED'])
  assert.equal((await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId_memberId: { documentId: doc.id, memberId: f.a.id } } })).cancelledAt, null)
})

it('validates the batch contract instead of silently accepting duplicated or destructive rows', () => {
  const row = { memberId: randomUUID(), action: 'ADD', revision: '0'.repeat(64) }
  const body = { kind: 'POSITION', targetId: randomUUID(), requestKey: randomUUID(), rows: [row] }
  assert.ok(memberBulkBody.safeParse(body).success)
  assert.ok(!memberBulkBody.safeParse({ ...body, rows: [row, row] }).success)
  assert.ok(!memberBulkBody.safeParse({ ...body, rows: [{ ...row, action: 'CANCEL' }] }).success)
  assert.ok(!memberBulkBody.safeParse({ ...body, kind: 'DOCUMENT', deadline: '2026-02-30' }).success)
  assert.ok(!memberBulkBody.safeParse({ ...body, role: 'OWNER' }).success)
})

it('keeps personnel details private for a document-only manager and searches names across separate fields', async () => {
  const f = await fixture()
  await prisma.user.update({ where: { id: f.a.userId }, data: { lastName: 'Соколова' } })
  await assignPositions(f.owner.id, f.org.id, f.a.id, [f.position.id])
  const doc = await document(f)
  await prisma.accessRole.update({ where: { id: f.role.id }, data: { permissions: ['documents.view', 'documents.assign', 'documents.control'] } })
  const target = { kind: 'DOCUMENT' as const, targetId: doc.id }
  const candidates = await memberBulkCandidates(f.manager.userId, f.org.id, target, 'Соколова Анна')
  assert.deepEqual(candidates.members.map(member => member.id), [f.a.id])
  assert.equal(candidates.members[0].secondary, '')
  assert.equal(candidates.members[0].status, 'AVAILABLE')
})

it('does not classify an owner as a staff recipient through the physical MEMBER placement', async () => {
  const f = await fixture()
  const doc = await document(f)
  const memberRole = await prisma.accessRole.findFirstOrThrow({ where: { organizationId: f.org.id, systemCode: 'MEMBER' } })
  const candidates = await memberBulkCandidates(f.owner.id, f.org.id, { kind: 'DOCUMENT', targetId: doc.id })
  assert.ok(!candidates.members.find(member => member.id === f.ownerMember.id)!.roleIds.includes(memberRole.id))
  assert.ok(!(await documentMembers(f.owner.id, f.org.id, true)).find(member => member.id === f.ownerMember.id)!.accessRoleIds.includes(memberRole.id))
  await assignAcknowledgements(f.owner.id, f.org.id, doc.id, { recipients: 'roles', accessRoleIds: [memberRole.id], roles: [], memberIds: [], deadline: null, comment: null })
  assert.equal(await prisma.documentAcknowledgement.count({ where: { documentId: doc.id, memberId: f.ownerMember.id } }), 0)
  assert.equal(await prisma.documentAcknowledgement.count({ where: { documentId: doc.id, memberId: { in: [f.a.id, f.b.id] } } }), 2)
})
