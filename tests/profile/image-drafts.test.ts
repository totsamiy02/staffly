import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import express from 'express'
import sharp from 'sharp'
import { SignJWT } from 'jose'
import { prisma } from '../../src/server/db.ts'
import { ApiError } from '../../src/server/api-error.ts'
import profileRoutes from '../../src/server/profile/routes.ts'
import mediaRoutes from '../../src/server/storage/routes.ts'
import { deletePendingFile, stageProfileImage } from '../../src/server/storage/image-service.ts'
import { updateOrganization } from '../../src/server/organizations/organization-service.ts'
import { createBusinessOrganization as createOrganization } from '../support/business-organization.ts'

let userId: string, foreignId: string, token: string, orgId: string, base: string, photo: Buffer
const app = express().use(express.json()).use('/api', mediaRoutes, profileRoutes)
app.use((error: unknown, _q: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error instanceof ApiError ? error.status : 500).json({ code: error instanceof ApiError ? error.code : 'INTERNAL' }))
const server = app.listen(0, '127.0.0.1')
const fields = { firstName: 'Anna', lastName: 'Example', middleName: null, phone: null, bio: null }
const patch = (body: object) => fetch(base + '/profile', { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
before(async () => {
  if (!server.listening) await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  userId = (await prisma.user.create({ data: { email: `image-${randomUUID()}@example.test`, emailVerifiedAt: new Date() } })).id
  foreignId = (await prisma.user.create({ data: { email: `foreign-image-${randomUUID()}@example.test`, emailVerifiedAt: new Date() } })).id
  orgId = (await createOrganization(userId, { name: 'Image drafts', description: null, timezone: 'Europe/Moscow' })).id
  const session = await prisma.authSession.create({ data: { userId, refreshTokenHash: randomUUID(), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
  token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET))
  photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#3366aa' } }).png().toBuffer()
})
after(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  try {
    await prisma.user.update({ where: { id: userId }, data: { avatarFileId: null } })
    await prisma.organization.update({ where: { id: orgId }, data: { logoFileId: null } })
    const files = await prisma.storedFile.findMany({ where: { uploadedByUserId: { in: [userId, foreignId] } }, select: { id: true } })
    await prisma.storedFile.updateMany({ where: { id: { in: files.map(f => f.id) } }, data: { pendingDeletionAt: new Date() } })
    for (const file of files) await deletePendingFile(file.id)
    await prisma.documentFolder.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.user.deleteMany({ where: { id: { in: [userId, foreignId] } } })
  } finally { await prisma.$disconnect() }
})

it('stages a private photo without changing the profile and binds it only with a valid profile save', async () => {
  const stagedResponse = await fetch(base + '/profile/avatar/stage', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: new Uint8Array(photo) })
  assert.equal(stagedResponse.status, 201)
  const { uploadId } = await stagedResponse.json() as { uploadId: string }
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).avatarFileId, null)
  assert.ok((await prisma.storedFile.findUniqueOrThrow({ where: { id: uploadId } })).pendingDeletionAt)
  const preview = await fetch(base + '/media/v2/' + uploadId, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(preview.status, 404)
  assert.equal((await patch({ ...fields, firstName: '1invalid', avatarUploadId: uploadId })).status, 400)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).avatarFileId, null)
  const saved = await patch({ ...fields, avatarUploadId: uploadId })
  assert.equal(saved.status, 200)
  const { user } = await saved.json() as { user: { avatarUrl: string } }
  assert.ok(user.avatarUrl.endsWith(uploadId))
  assert.equal((await prisma.storedFile.findUniqueOrThrow({ where: { id: uploadId } })).pendingDeletionAt, null)
  assert.equal((await fetch(base + '/media/v2/' + uploadId, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
})

it('rejects foreign/reused uploads atomically and makes photo deletion part of the profile save', async () => {
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const foreign = await stageProfileImage(foreignId, photo)
  assert.equal((await patch({ ...fields, firstName: 'Changed', avatarUploadId: foreign.id })).status, 409)
  assert.equal((await patch({ ...fields, firstName: 'Changed', avatarUploadId: before.avatarFileId })).status, 409)
  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  assert.equal(unchanged.firstName, before.firstName); assert.equal(unchanged.avatarFileId, before.avatarFileId)
  assert.equal((await patch({ ...fields, avatarUploadId: null })).status, 200)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).avatarFileId, null)
  assert.ok((await prisma.storedFile.findUniqueOrThrow({ where: { id: before.avatarFileId! } })).pendingDeletionAt)
})

it('binds organization logo and fields together, preserves the storage reservation, and rejects another tenant file', async () => {
  const staged = await stageProfileImage(userId, photo, orgId)
  const data = { name: 'Saved image organization', description: null, timezone: 'Europe/Moscow', contactEmail: null, phone: null, website: null, address: null }
  assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).logoFileId, null)
  await updateOrganization(userId, orgId, { ...data, logoUploadId: staged.id })
  assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).logoFileId, staged.id)
  assert.equal((await prisma.organizationResourceBudget.findUniqueOrThrow({ where: { organizationId: orgId } })).storageBytes, BigInt(staged.size))
  const personal = await stageProfileImage(userId, photo)
  await assert.rejects(updateOrganization(userId, orgId, { ...data, name: 'Must rollback', logoUploadId: personal.id }), { code: 'IMAGE_UPLOAD_UNAVAILABLE' })
  assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).name, data.name)
})
