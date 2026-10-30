import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import express from 'express'
import { SignJWT } from 'jose'
import { prisma } from '../../src/server/db.ts'
import { ApiError } from '../../src/server/api-error.ts'
import { createBusinessOrganization as createOrganization } from '../support/business-organization.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import routes from '../../src/server/requests/routes.ts'
import { requestInclude, readRequestPage } from '../../src/server/requests/request-read.ts'
import { publicRequest } from '../../src/server/requests/request-presenter.ts'
import type { RequestMutationResponse, RequestDetail } from '../../src/shared/requests.ts'

let userId: string, organizationId: string, typeId: string, token: string, base: string
const app = express().use(express.json()).use('/api', routes)
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error instanceof ApiError ? error.status : 500).json({ code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR' })
})
const server = app.listen(0, '127.0.0.1')
before(async () => {
  if (!server.listening) await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  userId = (await prisma.user.create({ data: { email: `contract-${randomUUID()}@example.test`, emailVerifiedAt: new Date() } })).id
  organizationId = (await createOrganization(userId, { name: 'API contracts', description: null, timezone: 'Europe/Moscow' })).id
  typeId = (await prisma.requestType.findFirstOrThrow({ where: { organizationId, systemCode: 'OTHER' } })).id
  const session = await prisma.authSession.create({ data: { userId, refreshTokenHash: randomUUID(), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
  token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET))
})
after(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  try {
    await prisma.accountNotification.deleteMany({ where: { organizationId } })
    await prisma.organizationRequest.deleteMany({ where: { organizationId } })
    await prisma.documentFolder.deleteMany({ where: { organizationId } })
    await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.user.delete({ where: { id: userId } })
  } finally { await prisma.$disconnect() }
})

it('returns stable JSON mutation/detail contracts without persistence-only fields or relation graphs', async () => {
  const response = await fetch(`${base}/organizations/${organizationId}/requests`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestTypeId: typeId, comment: 'Contract fixture', submissionKey: 'private-key-' + randomUUID() }) })
  assert.equal(response.status, 201)
  const body = await response.json() as RequestMutationResponse
  assert.equal(typeof body.request.createdAt, 'string'); assert.ok(!Number.isNaN(Date.parse(body.request.createdAt)))
  assert.equal('submissionKey' in body.request, false); assert.equal('remindedAt' in body.request, false)
  assert.equal('creator' in body.request, false); assert.equal('requestType' in body.request, false)
  assert.deepEqual(body.request.answers, {}); assert.ok(Array.isArray(body.request.formSnapshot.fields))
  const detailResponse = await fetch(`${base}/organizations/${organizationId}/requests/${body.request.id}`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json() as RequestDetail
  assert.equal(detail.request.id, body.request.id)
  assert.equal(detail.request.creatorEmail.includes('@example.test'), true)
  assert.equal(typeof detail.request.events[0].createdAt, 'string')
  for (const key of ['creator', 'resolvedBy', 'relatedShift', 'requestType', '_count', 'submissionKey']) assert.equal(key in detail.request, false, key)
})

it('keeps the bounded SQL projection equivalent to Prisma, preserving user JSON and UTC timestamps', async () => {
  const request = await prisma.organizationRequest.findFirstOrThrow({ where: { organizationId } })
  await prisma.organizationRequest.update({ where: { id: request.id }, data: { answers: { observed_at: '2038-01-02T03:04:05Z', period: { start: '2038-01-01', end: '2038-01-02' } } } })
  await prisma.requestEvent.create({ data: { requestId: request.id, actorMemberId: request.createdByMemberId, type: 'CHANGED', changes: { original_start_at: '2038-01-02T03:04:05Z', nested: { untouched_key: true } } } })
  const actor = await getMembership(userId, organizationId)
  const direct = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude })
  const page = await prisma.$transaction(tx => readRequestPage(tx, organizationId, { id: request.id }, 1, 20), { isolationLevel: 'RepeatableRead' })
  assert.equal(page.total, 1)
  assert.deepEqual(publicRequest(page.rows[0], actor.id, actor), publicRequest(direct, actor.id, actor))
  assert.equal(publicRequest(page.rows[0], actor.id, actor).answers.observed_at, '2038-01-02T03:04:05Z')
})
