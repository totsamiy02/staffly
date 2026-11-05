import assert from 'node:assert/strict'
import { before, after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { createRequestType, updateRequestType } from '../../src/server/requests/type-service.ts'
import { createEvent, updateEvent } from '../../src/server/events/service.ts'
import { eventBody } from '../../src/server/events/schemas.ts'
import { createRequestTypeBody, updateRequestTypeBody } from '../../src/server/requests/schemas.ts'
import { enqueueExport, exportForRequest, getExport, expireReportExports } from '../../src/server/schedule/reports/export-jobs.ts'
import { defaultReportConfig, type ReportInput } from '../../src/app/schedule/reports/reporting.ts'

let owner: string, stranger: string, org: string, point: string, foreignOrg: string
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected
before(async () => {
  const users = await Promise.all(['owner', 'stranger'].map(name => prisma.user.create({ data: { email: 'safety-' + name + '-' + randomUUID() + '@example.test', emailVerifiedAt: new Date() } })))
  ;[owner, stranger] = users.map(user => user.id)
  const organization = await createBusinessOrganization(owner, { name: 'Workspace safety', timezone: 'Europe/Moscow', description: null })
  org = organization.id; point = organization.locationId
  foreignOrg = (await createBusinessOrganization(stranger, { name: 'Other workspace', timezone: 'Europe/Moscow', description: null })).id
})
after(async () => {
  const where = { organizationId: { in: [org, foreignOrg].filter(Boolean) } }
  await prisma.accountNotification.deleteMany({ where })
  await prisma.emailDelivery.deleteMany({ where })
  await prisma.reportExport.deleteMany({ where })
  await prisma.organizationEvent.deleteMany({ where })
  await prisma.requestType.deleteMany({ where })
  await prisma.documentFolder.deleteMany({ where })
  await prisma.organization.deleteMany({ where: { id: { in: [org, foreignOrg].filter(Boolean) } } })
  await prisma.user.deleteMany({ where: { id: { in: [owner, stranger].filter(Boolean) } } })
  await prisma.$disconnect()
})
it('coalesces repeated constructor creation, rejects changed intent and preserves newer versions under a race', async () => {
  const input = createRequestTypeBody.parse({ submissionKey: randomUUID(), name: 'Custom type', dateMode: 'NONE', requiresComment: false, allowsAttachments: false })
  const [first, repeat] = await Promise.all([createRequestType(owner, org, input), createRequestType(owner, org, input)])
  assert.equal(first.id, repeat.id); assert.equal(first.id, input.submissionKey)
  assert.equal(await prisma.requestType.count({ where: { id: first.id } }), 1)
  await assert.rejects(createRequestType(owner, org, { ...input, name: 'Different intent' }), code('REQUEST_TYPE_ALREADY_SUBMITTED'))
  await assert.rejects(createRequestType(stranger, foreignOrg, input), code('REQUEST_TYPE_ALREADY_SUBMITTED'))
  const update = updateRequestTypeBody.parse({ ...input, isActive: true, version: first.version })
  const raced = await Promise.allSettled([updateRequestType(owner, org, first.id, { ...update, name: 'Update A' }), updateRequestType(owner, org, first.id, { ...update, name: 'Update B' })])
  assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = raced.find(item => item.status === 'rejected')
  assert.ok(rejected?.status === 'rejected' && code('REQUEST_TYPE_CHANGED')(rejected.reason))
  await assert.rejects(updateRequestType(owner, org, first.id, update), code('REQUEST_TYPE_CHANGED'))
  assert.equal((await prisma.requestType.findUniqueOrThrow({ where: { id: first.id } })).version, first.version + 1)
})
it('retries an event creation without duplicating the event, change history or recipient notifications', async () => {
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
  const input = eventBody.parse({ submissionKey: randomUUID(), title: 'Single publication', description: 'Retained text', startDate: day, startTime: '12:00', shared: false, locationIds: [point], audienceMode: 'ALL' })
  const [first, repeat] = await Promise.all([createEvent(owner, org, input), createEvent(owner, org, input)])
  assert.equal(first.id, repeat.id); assert.equal(first.id, input.submissionKey)
  assert.equal(await prisma.eventChange.count({ where: { eventId: first.id } }), 1)
  const notifications = await prisma.accountNotification.count({ where: { eventId: first.id, type: 'EVENT_PUBLISHED' } })
  await createEvent(owner, org, input)
  assert.equal(await prisma.accountNotification.count({ where: { eventId: first.id, type: 'EVENT_PUBLISHED' } }), notifications)
  await assert.rejects(createEvent(owner, org, { ...input, title: 'Changed intent' }), code('EVENT_ALREADY_SUBMITTED'))
  await updateEvent(owner, org, first.id, { ...input, revision: first.revision, title: 'Newer version' })
  await assert.rejects(updateEvent(owner, org, first.id, { ...input, revision: first.revision }), error => !!error && typeof error === 'object' && 'status' in error && error.status === 409)
})
it('recovers the same export after a lost response, exposes a stable failure reference and enforces ownership', async () => {
  const input: ReportInput = { from: '2026-01-01', to: '2026-12-31', memberIds: [], locationIds: [point], includeFormer: false, config: defaultReportConfig() }
  const requestKey = randomUUID()
  const [first, repeat] = await Promise.all([enqueueExport(owner, org, input, requestKey), enqueueExport(owner, org, input, requestKey)])
  assert.equal(first.id, repeat.id)
  assert.equal((await exportForRequest(owner, org, requestKey)).public.id, first.id)
  await assert.rejects(enqueueExport(owner, org, { ...input, to: '2026-11-30' }, requestKey), code('EXPORT_REQUEST_CHANGED'))
  await assert.rejects(exportForRequest(stranger, org, requestKey), code('EXPORT_NOT_FOUND'))
  await assert.rejects(getExport(stranger, org, first.id), code('EXPORT_NOT_FOUND'))
  await prisma.reportExport.update({ where: { id: first.id }, data: { status: 'RUNNING', attempts: 3, leaseUntil: new Date(0) } })
  await Promise.all([expireReportExports(), expireReportExports()])
  assert.equal(await prisma.securityEvent.count({ where: { resourceId: first.id, outcome: 'FAILED' } }), 1)
  const failed = (await getExport(owner, org, first.id)).public
  assert.equal(failed.errorId, first.id); assert.equal(failed.status, 'FAILED')
  assert.equal((await enqueueExport(owner, org, input, requestKey)).id, first.id, 'Retrying the same request must not hide its failed result')
  await prisma.reportExport.update({ where: { id: first.id }, data: { expiresAt: new Date(0) } })
  await assert.rejects(exportForRequest(owner, org, requestKey), code('EXPORT_NOT_FOUND'))
})
