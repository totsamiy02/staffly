import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { createRequestType } from '../../src/server/requests/type-service.ts'
import { createRequest, submitRequest } from '../../src/server/requests/request-submission.ts'
import { addRequestAttachment, deleteRequestAttachment, downloadRequestAttachment } from '../../src/server/requests/attachment-service.ts'
import { listRequestFiles } from '../../src/server/documents/request-files.ts'
import { organizationResources } from '../../src/server/resources/quotas.ts'
import { saveLocation } from '../../src/server/organizations/location-service.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { definitionOf } from '../../src/app/requests/workflow.ts'

const users: string[] = [], members: string[] = []
let org: string, point: string, type: string
const code = (value: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === value
const list = (i: number, search = '', page = 1) => listRequestFiles(users[i], org, { page, search })
const pdf = Buffer.from('%PDF-1.4\n%%EOF')
before(async () => {
  for (let i = 0; i < 4; i++) users.push((await prisma.user.create({ data: { email: `request-folder-${randomUUID()}@example.test`, emailVerifiedAt: new Date() } })).id)
  const a = await createBusinessOrganization(users[0], { name: 'Request file folder', description: null, timezone: 'Europe/Moscow' }); org = a.id; point = a.locationId
  members.push((await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org, userId: users[0] } } })).id)
  for (let i = 1; i <= 2; i++) {
    const member = await prisma.organizationMember.create({ data: { organizationId: org, userId: users[i], role: i === 2 ? 'ADMIN' : 'MEMBER' } }); members.push(member.id)
    await prisma.locationMember.create({ data: { organizationId: org, locationId: point, memberId: member.id, role: i === 2 ? 'ADMIN' : 'MEMBER' } })
  }
  type = (await createRequestType(users[0], org, { name: 'Папка файлов', dateMode: 'NONE', requiresComment: false, allowsAttachments: true })).id
})
after(() => prisma.$disconnect())
it('shows original request files automatically, preserves source permissions and does not duplicate storage', async () => {
  const r = await createRequest(users[1], org, { requestTypeId: type, draft: true })
  await addRequestAttachment(users[1], org, r.id, pdf, 'application/pdf', 'расходы.pdf')
  assert.equal((await list(1)).pagination.total, 1)
  assert.equal((await list(0)).pagination.total, 0, 'Other people cannot see a draft')
  await submitRequest(users[1], org, r.id)
  const before = await organizationResources(users[0], org)
  const owner = await list(0), self = await list(1), admin = await list(2)
  for (const result of [owner, self, admin]) { assert.equal(result.pagination.total, 1); assert.equal(result.totalBytes, pdf.length); assert.equal(result.files[0].fileName, 'расходы.pdf'); assert.ok(result.files[0].downloadPath.endsWith(`?locationId=${point}`)) }
  assert.equal((await list(1, 'расходы')).pagination.total, 1)
  assert.equal((await list(1, '%')).pagination.total, 0, 'Search escapes SQL wildcards')
  const file = self.files[0]
  assert.deepEqual((await downloadRequestAttachment(users[1], org, r.id, file.id)).contents, pdf)
  assert.equal((await organizationResources(users[0], org)).storage.usedBytes, before.storage.usedBytes)
  assert.equal(before.storage.breakdown.requestAttachmentsBytes, pdf.length)
  assert.equal(await prisma.document.count({ where: { organizationId: org } }), 0)
  await assert.rejects(list(3), code('ORGANIZATION_NOT_FOUND'))
  // Removing the request attachment removes the folder entry, without a stale copy.
  await deleteRequestAttachment(users[1], org, r.id, file.id)
  assert.equal((await list(0)).pagination.total, 0)
  assert.equal((await list(1)).totalBytes, 0)
})
it('hides private workflow files from unrelated reviewers and obeys attachment permission revocation', async () => {
  const t = await createRequestType(users[0], org, { name: 'Личное обращение', dateMode: 'NONE', requiresComment: false, allowsAttachments: true, definition: definitionOf({ stages: [{ name: 'Владелец', memberId: members[0] }] }) })
  const r = await createRequest(users[1], org, { requestTypeId: t.id, draft: true })
  await addRequestAttachment(users[1], org, r.id, pdf, 'application/pdf', 'private.pdf'); await submitRequest(users[1], org, r.id)
  assert.equal((await list(0, 'private')).pagination.total, 1)
  assert.equal((await list(1, 'private')).pagination.total, 1)
  assert.equal((await list(2, 'private')).pagination.total, 0)
  const publicRequest = await createRequest(users[1], org, { requestTypeId: type, draft: true })
  await addRequestAttachment(users[1], org, publicRequest.id, pdf, 'application/pdf', 'public.pdf'); await submitRequest(users[1], org, publicRequest.id)
  const file = (await list(2, 'public')).files[0]; assert.ok(file)
  const restricted = await prisma.accessRole.create({ data: { organizationId: org, name: 'Документы без вложений', permissions: ['documents.view', 'requests.view', 'requests.own', 'requests.resolve'] } })
  await prisma.organizationMember.update({ where: { id: members[2] }, data: { accessConfigured: true, accessRoleId: restricted.id } })
  assert.equal((await list(2, 'public')).pagination.total, 0)
  await assert.rejects(downloadRequestAttachment(users[2], org, publicRequest.id, file.id), code('INSUFFICIENT_PERMISSIONS'))
  await prisma.accessRole.update({ where: { id: restricted.id }, data: { permissions: ['requests.view', 'requests.attachments'] } })
  await assert.rejects(list(2), code('INSUFFICIENT_PERMISSIONS'))
})
it('bounds pagination and excludes pending or purged files from results and totals', async () => {
  const request = await prisma.organizationRequest.findFirstOrThrow({ where: { organizationId: org } })
  for (let i = 0; i < 24; i++) {
    const file = await prisma.storedFile.create({ data: { organizationId: org, uploadedByUserId: users[0], purpose: 'REQUEST_ATTACHMENT', objectKey: `organizations/${org}/request-folder/${randomUUID()}`, mimeType: 'text/plain', size: i + 1, checksumSha256: '0'.repeat(64) } })
    await prisma.requestAttachment.create({ data: { requestId: request.id, storedFileId: file.id, fileName: `page-${i}.txt` } })
    if (i === 22) await prisma.storedFile.update({ where: { id: file.id }, data: { pendingDeletionAt: new Date() } })
    if (i === 23) await prisma.storedFile.update({ where: { id: file.id }, data: { purgedAt: new Date() } })
  }
  const first = await list(0, 'page-'), last = await list(0, 'page-', 9999)
  assert.equal(first.files.length, 20); assert.equal(first.pagination.total, 22); assert.equal(first.totalBytes, 253)
  assert.equal(last.pagination.page, 2); assert.equal(last.files.length, 2)
  assert.equal(new Set([...first.files, ...last.files].map(file => file.id)).size, 22)
  const usage = await organizationResources(users[0], org)
  assert.equal(usage.storage.breakdown.pendingBytes, 23)
  assert.equal(Object.values(usage.storage.breakdown).reduce((sum, value) => sum + value, 0), usage.storage.usedBytes)
})

it('lists accessible files across points and scopes each source download to its original point', async () => {
  const second = await saveLocation(users[0], org, null, { name: 'Вторая точка', city: 'Москва', address: 'Проверка, 2', timezone: 'Europe/Moscow', teamNames: [] })
  const request = await locationContext.run({ organizationId: org, locationId: second.id }, async () => {
    const r = await createRequest(users[0], org, { requestTypeId: type, draft: true })
    await addRequestAttachment(users[0], org, r.id, pdf, 'application/pdf', 'another-point.pdf')
    await submitRequest(users[0], org, r.id); return r
  })
  const result = await locationContext.run({ organizationId: org, locationId: point }, () => list(0, 'another-point'))
  assert.equal(result.pagination.total, 1)
  assert.ok(result.files[0].downloadPath.endsWith(`locationId=${second.id}`))
  assert.ok(result.files[0].requestHref.endsWith(`location=${second.id}`))
  assert.equal((await list(1, 'another-point')).pagination.total, 0)
  await assert.rejects(locationContext.run({ organizationId: org, locationId: point }, () => downloadRequestAttachment(users[0], org, request.id, result.files[0].id)), code('REQUEST_NOT_FOUND'))
  const download = await locationContext.run({ organizationId: org, locationId: second.id }, () => downloadRequestAttachment(users[0], org, request.id, result.files[0].id))
  assert.deepEqual(download.contents, pdf)
})
