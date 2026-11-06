import { safeError } from '../../src/server/security/safe-error.ts'
import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { ZodError } from 'zod'
import { prisma } from '../../src/server/db.ts'
import { ApiError } from '../../src/server/api-error.ts'
import { recordSecurityEvent, auditSensitiveAccess, securityContext } from '../../src/server/security/journal.ts'
import { securityHistory } from '../../src/server/security/history-service.ts'
import { scheduleDeletion, requestAccountDeletion, confirmAccountDeletion, lifecycleStatus } from '../../src/server/privacy/deletion-service.ts'
import { runDataRetention, retentionPlan, holdDeletion } from '../../src/server/privacy/maintenance.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { requestOrganizationDeletion, confirmOrganizationDeletion } from '../../src/server/organizations/sensitive-action-service.ts'
import { createSession } from '../../src/server/auth.ts'
import profileRoutes from '../../src/server/profile/routes.ts'
import organizationRoutes from '../../src/server/organizations/routes.ts'
import { registerBackupRetention, pruneBackups } from '../../scripts/backup-retention.ts'
import { storage } from '../../src/server/storage/provider.ts'

const ids: string[] = [], orgs: string[] = [], DAY = 86400_000
const isCode = (code: string) => (e: any) => e.code === code
let server: ReturnType<ReturnType<typeof express>['listen']>, base: string
async function account() {
  const user = await prisma.user.create({ data: { email: `privacy-${randomUUID()}@example.test`, firstName: 'Личное имя', phone: '+79991234567', bio: 'private bio', emailVerifiedAt: new Date() } }); ids.push(user.id)
  const session = await prisma.authSession.create({ data: { userId: user.id, refreshTokenHash: randomUUID(), idleExpiresAt: new Date(Date.now() + DAY), absoluteExpiresAt: new Date(Date.now() + DAY) } })
  return { user, auth: { userId: user.id, sessionId: session.id } }
}
async function organization(userId: string) {
  const org = await createBusinessOrganization(userId, { name: 'Privacy fixture', description: null, timezone: 'Europe/Moscow' }); orgs.push(org.id)
  const owner = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId } } })
  return { ...org, owner }
}
async function due(kind: 'ACCOUNT' | 'ORGANIZATION', subjectId: string) {
  const start = new Date(Date.now() - 31 * DAY)
  return prisma.$transaction(tx => scheduleDeletion(tx, kind, subjectId, start))
}
before(async () => {
  const app = express(); app.use(securityContext, express.json())
  app.post('/fixture', async (req, res) => res.json(await createSession(await prisma.user.findUniqueOrThrow({ where: { id: req.body.id } }), req, res)))
  app.use('/api', profileRoutes, organizationRoutes)
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e instanceof ApiError ? e.status : e instanceof ZodError ? 400 : 500).json({ code: e.code }))
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as any).port}`
})
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  // Run the tested tenant purge for complete Restrict-graph teardown.
  for (const id of orgs) {
    if (!await prisma.organization.count({ where: { id } })) continue
    await prisma.organization.update({ where: { id }, data: { deletedAt: new Date() } })
    await prisma.dataDeletion.deleteMany({ where: { kind: 'ORGANIZATION', subjectId: id } }); await due('ORGANIZATION', id)
  }
  const cleanup = await runDataRetention({ enabled: true }); assert.equal(cleanup.failed, 0, JSON.stringify(await retentionPlan()))
  await prisma.dataDeletion.deleteMany({ where: { subjectId: { in: [...ids, ...orgs] } } })
  await prisma.securityEvent.deleteMany({ where: { OR: [{ userId: { in: ids } }, { organizationId: { in: orgs } }] } })
  await prisma.storedFile.deleteMany({ where: { uploadedByUserId: { in: ids }, organizationId: null } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } }); await prisma.$disconnect()
})

it('separates personal/tenant history, limits it to owner, excludes secrets and rolls back with the operation', async () => {
  const a = await account(), employee = await account(), foreign = await account(), org = await organization(a.user.id)
  await prisma.organizationMember.create({ data: { userId: employee.user.id, organizationId: org.id } })
  const malicious = { action: 'LOGIN', userId: a.user.id, email: 'secret-mail', password: 'secret-password', code: 'secret-code', token: 'secret-token', details: { token: 'secret-token' } } as any
  await recordSecurityEvent(prisma, malicious)
  const event = await prisma.securityEvent.findFirstOrThrow({ where: { userId: a.user.id, action: 'LOGIN' } })
  assert.doesNotMatch(JSON.stringify(event), /secret-/)
  await assert.rejects(prisma.$transaction(async tx => { await recordSecurityEvent(tx, { action: 'PASSWORD_CHANGED', userId: a.user.id }); throw new Error('rollback') }))
  assert.equal(await prisma.securityEvent.count({ where: { userId: a.user.id, action: 'PASSWORD_CHANGED' } }), 0)
  await recordSecurityEvent(prisma, { action: 'DOCUMENT_DOWNLOAD', userId: employee.user.id, organizationId: org.id, resourceType: 'DOCUMENT', resourceId: randomUUID() })
  assert.ok((await securityHistory(a.user.id, org.id)).entries.some(e => e.action === 'DOCUMENT_DOWNLOAD'))
  await assert.rejects(securityHistory(employee.user.id, org.id), isCode('INSUFFICIENT_PERMISSIONS'))
  await assert.rejects(securityHistory(foreign.user.id, org.id), isCode('ORGANIZATION_NOT_FOUND'))
  assert.ok((await securityHistory(employee.user.id, undefined)).entries.every(e => e.action !== 'DOCUMENT_DOWNLOAD'))
  const login = await fetch(base + '/fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: employee.user.id }) }); const token = (await login.json()).accessToken
  const response = await fetch(base + `/api/organizations/${org.id}/security-history`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 403)
  const own = await fetch(base + '/api/profile/security-history', { headers: { Authorization: `Bearer ${token}` } }); assert.equal(own.status, 200); assert.match(own.headers.get('cache-control')!, /no-store/)
  assert.doesNotMatch(await own.text(), /refreshToken|ipAddress|password|secret-/)
})
it('correlates sensitive access and denial without recording raw error messages', async () => {
  const a = await account(), resourceId = randomUUID()
  await assert.rejects(auditSensitiveAccess({ action: 'DOCUMENT_DOWNLOAD', userId: a.user.id, resourceType: 'DOCUMENT', resourceId }, async () => { throw new ApiError(403, 'FORBIDDEN', 'secret-token') }))
  const event = await prisma.securityEvent.findFirstOrThrow({ where: { resourceId } })
  assert.equal(event.outcome, 'DENIED'); assert.equal(event.reasonCode, 'ACCESS_DENIED'); assert.doesNotMatch(JSON.stringify(event), /secret-token/)
})
it('protects account deletion by session-bound email proof, persists wrong attempts and blocks active owners', async () => {
  const a = await account(), other = await prisma.authSession.create({ data: { userId: a.user.id, refreshTokenHash: randomUUID(), idleExpiresAt: new Date(Date.now() + DAY), absoluteExpiresAt: new Date(Date.now() + DAY) } })
  let code = ''
  const challenge = await requestAccountDeletion(a.auth, async (_email, value) => { code = value })
  await assert.rejects(confirmAccountDeletion({ ...a.auth, sessionId: other.id }, challenge.challengeId, code), isCode('INVALID_VERIFICATION_CODE'))
  for (let i = 0; i < 5; i++) await assert.rejects(confirmAccountDeletion(a.auth, challenge.challengeId, code === '000000' ? '000001' : '000000'), isCode('INVALID_VERIFICATION_CODE'))
  assert.equal((await prisma.accountDeletionChallenge.findUniqueOrThrow({ where: { userId: a.user.id } })).attempts, 5)
  await assert.rejects(confirmAccountDeletion(a.auth, challenge.challengeId, code), isCode('INVALID_VERIFICATION_CODE'))
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).deletedAt, null)
  const owner = await account(); await organization(owner.user.id)
  await assert.rejects(requestAccountDeletion(owner.auth, async () => {}), isCode('ACCOUNT_OWNS_ORGANIZATIONS'))
  assert.equal((await lifecycleStatus(owner.user.id)).ownedOrganizations, 1)
})
it('soft-deletes immediately, revokes all sessions and memberships, retains organization history and schedules 30 days', async () => {
  const owner = await account(), a = await account(), org = await organization(owner.user.id)
  const member = await prisma.organizationMember.create({ data: { userId: a.user.id, organizationId: org.id } })
  await prisma.locationMember.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: member.id } })
  const start = new Date(Date.now() + DAY)
  const shift = await prisma.workShift.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: member.id, createdByMemberId: org.owner.id, scheduledStartAt: start, scheduledEndAt: new Date(+start + 3600000) } })
  const actual = await prisma.workShift.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: member.id, createdByMemberId: org.owner.id, scheduledStartAt: new Date(+start + 7200000), scheduledEndAt: new Date(+start + 10800000), attendance: 'WORKED', actualStartAt: start } })
  let code = ''; const challenge = await requestAccountDeletion(a.auth, async (_email, value) => { code = value })
  const result = await confirmAccountDeletion(a.auth, challenge.challengeId, code)
  assert.equal(result.cleanupEnabled, false); assert.ok(+result.dueAt >= Date.now() + 30 * DAY - 1000)
  assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).deletedAt)
  assert.equal(await prisma.authSession.count({ where: { userId: a.user.id, revokedAt: null } }), 0)
  assert.ok((await prisma.organizationMember.findUniqueOrThrow({ where: { id: member.id } })).leftAt)
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'CANCELLED')
  assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: actual.id } })).status, 'SCHEDULED')
  assert.equal((await runDataRetention()).enabled, false)
  assert.ok((await retentionPlan()).jobs.some(j => j.subjectId === a.user.id))
})
it('holds a due job, retries object failures and only then pseudonymizes the personal profile', async () => {
  const a = await account(); await prisma.user.update({ where: { id: a.user.id }, data: { deletedAt: new Date() } })
  const file = await prisma.storedFile.create({ data: { uploadedByUserId: a.user.id, objectKey: `privacy/${randomUUID()}.webp`, purpose: 'USER_AVATAR', mimeType: 'image/webp', size: 4, checksumSha256: '0'.repeat(64) } })
  await storage.put(file.objectKey, Buffer.from('file')); await prisma.user.update({ where: { id: a.user.id }, data: { avatarFileId: file.id } })
  const job = await due('ACCOUNT', a.user.id)
  await holdDeletion(job.id, true); await runDataRetention({ enabled: true, removeObject: async () => { throw new Error('should not run') } })
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).email, a.user.email)
  await holdDeletion(job.id, false); await runDataRetention({ enabled: true, removeObject: async () => { throw new Error('private storage credential') } })
  const failure = await prisma.dataDeletion.findUniqueOrThrow({ where: { id: job.id } }); assert.equal(failure.lastErrorCode, 'OBJECT_DELETE_FAILED'); assert.equal(failure.completedAt, null)
  await holdDeletion(job.id, true)
  await runDataRetention({ enabled: true, removeObject: async () => { throw new Error('held retry must not run') } })
  assert.ok(await storage.read(file.objectKey))
  assert.equal((await prisma.storedFile.findUniqueOrThrow({ where: { id: file.id } })).pendingDeletionAt, null)
  await holdDeletion(job.id, false)
  await runDataRetention({ enabled: true })
  const tombstone = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } }); assert.match(tombstone.email, /^deleted-/); assert.equal(tombstone.bio, null); assert.equal(tombstone.phone, null); assert.equal(tombstone.avatarFileId, null)
  assert.ok((await prisma.dataDeletion.findUniqueOrThrow({ where: { id: job.id } })).completedAt)
  await assert.rejects(storage.read(file.objectKey), { code: 'ENOENT' })
})
it('schedules organization deletion and purges the tenant graph/files without deleting another tenant', async () => {
  const a = await account(), b = await account(), org = await organization(a.user.id), foreign = await organization(b.user.id)
  const file = await prisma.storedFile.create({ data: { organizationId: org.id, uploadedByUserId: a.user.id, objectKey: `privacy/${randomUUID()}.txt`, purpose: 'DOCUMENT', mimeType: 'text/plain', size: 4, checksumSha256: '0'.repeat(64) } }); await storage.put(file.objectKey, Buffer.from('file'))
  const document = await prisma.document.create({ data: { organizationId: org.id, storedFileId: file.id, uploadedByMemberId: org.owner.id, displayName: 'Личные сведения', fileName: 'private.txt', visibility: 'ORGANIZATION' } })
  await prisma.documentAcknowledgement.create({ data: { documentId: document.id, memberId: org.owner.id, assignedByMemberId: org.owner.id } })
  const type = await prisma.requestType.create({ data: { organizationId: org.id, name: 'Retention', dateMode: 'NONE' } })
  const request = await prisma.organizationRequest.create({ data: { organizationId: org.id, locationId: org.locationId, createdByMemberId: org.owner.id, requestTypeId: type.id, typeNameSnapshot: type.name } })
  await prisma.requestEvent.create({ data: { requestId: request.id, actorMemberId: org.owner.id, type: 'CREATED' } })
  const { code } = await requestOrganizationDeletion(a.user.id, org.id)
  await confirmOrganizationDeletion(a.user.id, org.id, code)
  const job = await prisma.dataDeletion.findUniqueOrThrow({ where: { kind_subjectId: { kind: 'ORGANIZATION', subjectId: org.id } } }); assert.ok(+job.dueAt - +job.requestedAt >= 30 * DAY)
  await prisma.dataDeletion.delete({ where: { id: job.id } }); await due('ORGANIZATION', org.id)
  const result = await runDataRetention({ enabled: true }); assert.equal(result.failed, 0)
  assert.equal(await prisma.organization.count({ where: { id: org.id } }), 0)
  assert.equal(await prisma.document.count({ where: { organizationId: org.id } }), 0)
  assert.ok(await prisma.organization.count({ where: { id: foreign.id } }))
  await assert.rejects(storage.read(file.objectKey), { code: 'ENOENT' })
  assert.ok(await prisma.securityEvent.count({ where: { organizationId: org.id, action: 'DATA_PURGED' } }))
})
it('keeps provider and Prisma secrets out of diagnostic logs', () => {
  const error = Object.assign(new Error('secret-password secret-code secret-token private@example.test'), { cause: { password: 'secret-password' }, name: 'PrismaClientKnownRequestError', code: 'P2002' })
  assert.deepEqual(safeError(error), { name: 'PrismaClientKnownRequestError', code: 'P2002' })
  assert.doesNotMatch(JSON.stringify(safeError({ name: 'secret-token', code: 'secret-code', message: 'secret-password' })), /secret-/)
})
it('keeps fixed monitoring context and known nested SQL/pool errors while redacting secrets',()=>{
 const error=Object.assign(new Error('private@example.test secret-password SELECT private'),{operation:'MONITOR_SAMPLE',cause:{name:'error',code:'42P01',message:'private relation secret-token'}})
 assert.deepEqual(safeError(error),{name:'Error',code:'42P01',operation:'MONITOR_SAMPLE'})
 assert.deepEqual(safeError(new Error('timeout exceeded when trying to connect')),{name:'Error',code:'POOL_ACQUIRE_TIMEOUT'})
 assert.doesNotMatch(JSON.stringify(safeError(error)),/private|secret-|SELECT/)
 assert.deepEqual(safeError({operation:'secret-token',cause:{code:'secret-password',message:'private@example.test'}}),{name:'Error'})
})
it('bounds nested diagnostic inspection including AggregateError and cyclic causes',()=>{
 assert.deepEqual(safeError(new AggregateError([{code:'ECONNREFUSED',message:'secret-token'}],'secret-password')),{name:'Error',code:'ECONNREFUSED'})
 const cyclic:{cause?:unknown;message:string}={message:'secret-token'};cyclic.cause=cyclic
 assert.deepEqual(safeError(cyclic),{name:'Error'})
})
it('prunes only expired registered backups on explicit apply and refuses changed files and symlinks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'privacy-backups-'))
  try {
    const old = path.join(directory, 'old.dump'), fresh = path.join(directory, 'fresh.dump'), changed = path.join(directory, 'changed.dump'), manual = path.join(directory, 'manual.dump')
    for (const file of [old, fresh, changed, manual]) await writeFile(file, file)
    const past = new Date(Date.now() - 31 * DAY)
    await registerBackupRetention(old, past); await registerBackupRetention(fresh); await registerBackupRetention(changed, past); await writeFile(changed, 'changed')
    await symlink(old, path.join(directory, 'symlink.dump')); await registerBackupRetention(path.join(directory, 'symlink.dump'), past)
    const plan = await pruneBackups(directory); assert.deepEqual(plan.expired, ['old.dump']); assert.equal(plan.apply, false); assert.equal(plan.invalid.length, 2)
    assert.ok(await readFile(old)); await pruneBackups(directory, { apply: true }); await assert.rejects(readFile(old), { code: 'ENOENT' })
    for (const file of [fresh, changed, manual]) assert.ok(await readFile(file))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
