import assert from 'node:assert/strict'
import { before, after, it } from 'node:test'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import { Pool } from 'pg'
import express from 'express'
import { SignJWT } from 'jose'
import { S3Client } from '@aws-sdk/client-s3'
import { prisma } from '../../src/server/db.ts'
import { requireAuth, createSession } from '../../src/server/auth.ts'
import { createOrganization } from '../../src/server/organizations/organization-service.ts'
import { createRequest } from '../../src/server/requests/service.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { createLiveHub } from '../../src/server/live/hub.ts'
import { eventParser } from '../../src/app/live-stream.ts'
import { liveQueryOptions, setLiveConnected, applyLiveHints } from '../../src/app/live-query.ts'
import { QueryClient } from '@tanstack/react-query'
import { TokenBuckets } from '../../src/server/security/admission.ts'
import { PostgresRateLimitStore } from '../../src/server/security/rate-limit.ts'
import { ReadCache } from '../../src/server/read-cache.ts'
import { createS3Storage } from '../../src/server/storage/s3-storage.ts'
import { enqueueExport, getExport, processReportExport } from '../../src/server/schedule/reports/export-jobs.ts'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'
import { storage } from '../../src/server/storage/provider.ts'
import { deletePendingFile } from '../../src/server/storage/image-service.ts'
import { isDatabaseBusy } from '../../src/server/api-error.ts'
import { readMembership } from '../../src/server/organizations/access/membership-read.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { observePool, runRequestTiming } from '../../src/server/performance.ts'

let userId: string, otherId: string, orgId: string, locationId: string, memberId: string, token: string, sessionId: string
const jobs: string[] = []
before(async () => {
  userId = (await prisma.user.create({ data: { email: `scale-${randomUUID()}@example.test`, emailVerifiedAt: new Date(), emailNotificationsEnabled: false } })).id
  otherId = (await prisma.user.create({ data: { email: `scale-other-${randomUUID()}@example.test`, emailVerifiedAt: new Date(), emailNotificationsEnabled: false } })).id
  const org = await createOrganization(userId, { name: 'Scaling verification', description: null, timezone: 'Europe/Moscow' })
  orgId = org.id; locationId = org.locationId
  memberId = (await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId } } })).id
  sessionId = (await prisma.authSession.create({ data: { userId, refreshTokenHash: randomUUID(), idleExpiresAt: new Date(Date.now() + 86400000), absoluteExpiresAt: new Date(Date.now() + 86400000) } })).id
  token = await new SignJWT({ sid: sessionId }).setSubject(userId).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('15m').sign(new TextEncoder().encode(process.env.JWT_SECRET))
})
after(async () => {
  for (const id of jobs) {
    const job = await prisma.reportExport.findUnique({ where: { id } })
    if (job?.objectKey) {
      const file = await prisma.storedFile.findUnique({ where: { objectKey: job.objectKey } })
      if (file) await deletePendingFile(file.id); else await storage.delete(job.objectKey)
    }
  }
  await prisma.reportExport.deleteMany({ where: { organizationId: orgId } })
  await prisma.accountNotification.deleteMany({ where: { organizationId: orgId } })
  await prisma.organizationRequest.deleteMany({ where: { organizationId: orgId } })
  await prisma.documentFolder.deleteMany({ where: { organizationId: orgId } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } })
  await prisma.$disconnect()
})

it('commits simultaneous new sessions for distinct accounts without global snapshot conflicts', async () => {
  const accounts = Array.from({ length: 40 }, () => ({ id: randomUUID(), email: `parallel-login-${randomUUID()}@example.test`, emailVerifiedAt: new Date(), emailNotificationsEnabled: false }))
  await prisma.user.createMany({ data: accounts })
  const users = await prisma.user.findMany({ where: { id: { in: accounts.map(account => account.id) } } })
  const app = express()
  app.get('/:id', async (request, response) => { response.json(await createSession(users.find(user => user.id === request.params.id)!, request, response)) })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const results = await Promise.all(users.map(async user => { const response = await fetch(base + '/' + user.id); await response.json(); return response.status }))
    assert.ok(results.every(status => status === 200), JSON.stringify(results))
    assert.equal(await prisma.authSession.count({ where: { userId: { in: accounts.map(account => account.id) }, revokedAt: null } }), 40)
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await prisma.user.deleteMany({ where: { id: { in: accounts.map(account => account.id) } } })
  }
})

it('serializes competing account logins in one browser and leaves only the final session active', async () => {
  const users = await prisma.user.findMany({ where: { id: { in: [userId, otherId] } } })
  const browserToken = randomBytes(48).toString('base64url')
  const browserTokenHash = createHash('sha256').update(browserToken).digest('hex')
  const app = express()
  app.get('/:id', async (request, response) => {
    request.cookies = { staffly_browser: browserToken }
    response.json(await createSession(users.find(user => user.id === request.params.id)!, request, response))
  })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => fetch(url + '/' + users[i % 2].id)))
    for (const response of responses) { assert.equal(response.status, 200); await response.json() }
    assert.equal(await prisma.authSession.count({ where: { browserTokenHash, revokedAt: null } }), 1)
  } finally {
    await prisma.authSession.deleteMany({ where: { browserTokenHash } })
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('bounds token bucket memory, refills by elapsed time and cannot bypass a busy key', () => {
  const buckets = new TokenBuckets(2, 2, 2)
  assert.equal(buckets.take('a', 1000), true); assert.equal(buckets.take('a', 1000), true)
  assert.equal(buckets.take('a', 1000), false); assert.equal(buckets.take('a', 1500), true)
  assert.equal(buckets.take('b', 1500), true); assert.equal(buckets.take('c', 1500), false)
  assert.equal(buckets.size, 2); assert.equal(buckets.take('c', 70000), true)
})

it('attributes SQL and a queued pool acquisition to their own concurrent request', async () => {
  const pool = observePool(new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }))
  const request = (seconds: number) => new Promise<Partial<Record<'pool' | 'sql', number>>>((resolve, reject) => {
    runRequestTiming(totals => { pool.query('SELECT pg_sleep($1)', [seconds]).then(() => resolve(totals), reject) })
  })
  try {
    const first = request(.1)
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = request(.01)
    const [a, b] = await Promise.all([first, second])
    assert.ok((a.sql ?? 0) >= 80, JSON.stringify(a))
    assert.ok((b.sql ?? 0) >= 5, JSON.stringify(b))
    assert.ok((b.pool ?? 0) >= 60, JSON.stringify(b))
  } finally { await pool.end() }
})

it('shares an atomic limiter across store instances and isolates account keys', async () => {
  const name = randomUUID(), a = new PostgresRateLimitStore(name, 10), b = new PostgresRateLimitStore(name, 10)
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? a : b).increment(userId)))
  assert.deepEqual(results.map(hit => hit.totalHits).sort((a, b) => a - b), [1,2,3,4,5,6,7,8,9,10])
  assert.equal((await b.increment(userId)).totalHits, 11)
  assert.ok(+results[0].resetTime > Date.now() && +results[0].resetTime < Date.now() + 61000)
  assert.equal((await a.increment(otherId)).totalHits, 1)
  await a.resetKey(userId)
  assert.equal((await b.increment(userId)).totalHits, 11) // A denial cache stays conservative until its window expires.
  await b.resetKey(userId)
  assert.equal((await b.increment(userId)).totalHits, 1)
})

async function apiProcess(extra: Record<string, string>) {
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env: { ...process.env,
    PORT: String(port), HOST: '127.0.0.1', RUN_BACKGROUND_WORKERS: 'false', TRUST_PROXY: 'false', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
  const url = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/health/live')).ok) { ready = true; break } } catch { /* Wait for this test process. */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert(ready, log)
  return { url, log: () => log, stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const done = once(child, 'exit'); child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000)
    try { await done } finally { clearTimeout(timer) }
  } }
}

it('rejects malformed/compressed/oversized bodies, ignores spoofed IPs and protects metrics', async () => {
  const metricsToken = randomUUID() + randomUUID()
  const api = await apiProcess({ HTTP_IP_RATE: '100', HTTP_IP_BURST: '5', METRICS_TOKEN: metricsToken })
  try {
    assert.equal((await fetch(api.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"DO_NOT_LOG"' })).status, 400)
    assert.equal((await fetch(api.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: 'compressed' })).status, 415)
    assert.equal((await fetch(api.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(17000) }) })).status, 413)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await fetch(api.url + '/internal/metrics')).status, 404)
    const metrics = await fetch(api.url + '/internal/metrics', { headers: { Authorization: `Bearer ${metricsToken}` } })
    assert.equal(metrics.status, 200); assert.match(await metrics.text(), /staffly_http_duration_seconds/)
    await new Promise(resolve => setTimeout(resolve, 100))
    const flood = await Promise.all(Array.from({ length: 40 }, (_, index) => fetch(api.url + '/api/organizations', { headers: { Authorization: 'Bearer forged.invalid.token', 'X-Forwarded-For': `203.0.113.${index + 1}` } })))
    assert.ok(flood.some(response => response.status === 429)); assert.ok(flood.every(response => [401, 429].includes(response.status)))
    assert.equal((await fetch(api.url + '/health/live')).status, 200)
    assert.ok(!api.log().includes('DO_NOT_LOG'))
  } finally { await api.stop() }
})

it('returns a temporary availability error rather than logging a valid user out on database outage', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 100 })
  const occupied = await pool.connect()
  try { await assert.rejects(pool.query('SELECT 1'), error => isDatabaseBusy(error)) }
  finally { occupied.release(); await pool.end() }
  assert.equal(isDatabaseBusy(new Error('Business operation timeout')), false)
  const database = new URL(process.env.DATABASE_URL!)
  const upstreamAddress = { host: database.hostname, port: Number(database.port || 5432) }
  const sockets = new Set<net.Socket>()
  const proxy = net.createServer(socket => {
    const upstream = net.connect(upstreamAddress)
    sockets.add(socket); sockets.add(upstream)
    socket.on('close', () => { sockets.delete(socket); upstream.destroy() })
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy() })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  database.hostname = '127.0.0.1'; database.port = String((proxy.address() as net.AddressInfo).port)
  let api: Awaited<ReturnType<typeof apiProcess>> | undefined
  try {
    api = await apiProcess({ DATABASE_URL: database.toString(), DB_CONNECT_TIMEOUT_MS: '500' })
    // Start against a valid UTC model, then lose the database. A missing/legacy
    // model at startup is a different failure and must now prevent boot.
    const closed = new Promise<void>(resolve => proxy.close(() => resolve()))
    sockets.forEach(socket => socket.destroy()); await closed
    const response = await fetch(api.url + '/api/organizations', { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'DATABASE_BUSY')
  } finally { sockets.forEach(socket => socket.destroy()); proxy.close(); await api?.stop() }
})

it('coalesces concurrent cache reads and does not restore invalidated in-flight data', async () => {
  const cache = new ReadCache(1000)
  let complete!: (value: string) => void, loads = 0
  const first = cache.read('org', 'key', () => { loads++; return new Promise<string>(resolve => { complete = resolve }) })
  const second = cache.read('org', 'key', async () => { loads++; return 'unexpected' })
  cache.invalidate('org'); complete('old')
  assert.deepEqual(await Promise.all([first, second]), ['old', 'old']); assert.equal(loads, 1)
  assert.equal(await cache.read('org', 'key', async () => 'new'), 'new')
})

it('retains calendars on unrelated hints but invalidates schedule, profile and access changes', async () => {
  const cache = new ReadCache()
  let reads = 0
  const read = (org: string) => cache.read(org, `shifts:${org}`, async () => ++reads)
  assert.equal(await read('a'), 1); assert.equal(await read('b'), 2)
  for (const topic of ['requests', 'requests-mine', 'requests-review', 'notifications', 'exports', 'documents', 'events']) {
    cache.invalidateForHint({ topic, organizationId: 'a' })
    cache.invalidateForHint({ topic })
    assert.equal(await read('a'), 1); assert.equal(await read('b'), 2)
  }
  for (const topic of ['schedule', 'profile', 'organization', 'access']) {
    const before = reads
    cache.invalidateForHint({ topic, organizationId: 'a' })
    assert.equal(await read('a'), before + 1); assert.equal(await read('b'), 2)
  }
  cache.invalidateForHint({ topic: 'profile' })
  const before = reads
  assert.equal(await read('a'), before + 1); assert.equal(await read('b'), before + 2)
})

it('parses split SSE frames and invalidates only the changed organization', async () => {
  const messages: unknown[] = [], parse = eventParser(message => messages.push(message))
  parse('event: cha'); parse('nge\r\ndata: [{"topic":"schedule"}]\r\n'); parse('\r\n')
  assert.equal(messages.length, 1)
  const client = new QueryClient()
  client.setQueryData(['schedule', 'a'], 'a'); client.setQueryData(['schedule', 'b'], 'b')
  client.setQueryData(['schedule-planning', 'a'], 'settings')
  client.setQueryData(['personal-documents', 'a'], 'documents')
  client.setQueryData(['personal-documents', undefined], 'all documents')
  await applyLiveHints(client, [{ topic: 'schedule', organizationId: 'a' }])
  assert.equal(client.getQueryState(['schedule', 'a'])?.isInvalidated, true)
  assert.equal(client.getQueryState(['schedule', 'b'])?.isInvalidated, false)
  assert.equal(client.getQueryState(['schedule-planning', 'a'])?.isInvalidated, true)
  await applyLiveHints(client, [{ topic: 'documents', organizationId: 'a' }])
  assert.equal(client.getQueryState(['personal-documents', 'a'])?.isInvalidated, true)
  assert.equal(client.getQueryState(['personal-documents', undefined])?.isInvalidated, true)
  client.setQueryData(['schedule', 'a'], 'name before edit')
  await applyLiveHints(client, [{ topic: 'profile', organizationId: 'a' }])
  assert.equal(client.getQueryState(['schedule', 'a'])?.isInvalidated, true)
  assert.equal(client.getQueryState(['schedule', 'b'])?.isInvalidated, false)
  setLiveConnected(true); assert.equal(liveQueryOptions.refetchInterval({ queryKey: ['schedule'] }), false)
  assert.equal(liveQueryOptions.refetchInterval({ queryKey: ['organization-members'] }), 60000)
  setLiveConnected(false); assert.ok(Number(liveQueryOptions.refetchInterval({ queryKey: ['schedule'] })) >= 30000)
  client.clear()
})

it('keeps personal request lists quiet on review-only hints and updates the actual author', async () => {
  const client = new QueryClient()
  const mine = ['requests', orgId, 'mine'], incoming = ['requests', orgId, 'incoming'], types = ['request-types', orgId]
  for (const key of [mine, incoming, types]) client.setQueryData(key, [])
  await applyLiveHints(client, [{ topic: 'requests-review', organizationId: orgId }])
  assert.equal(client.getQueryState(mine)?.isInvalidated, false)
  assert.equal(client.getQueryState(incoming)?.isInvalidated, true)
  assert.equal(client.getQueryState(types)?.isInvalidated, false)
  client.setQueryData(incoming, [])
  await applyLiveHints(client, [{ topic: 'requests-mine', organizationId: orgId }])
  assert.equal(client.getQueryState(mine)?.isInvalidated, true)
  assert.equal(client.getQueryState(incoming)?.isInvalidated, false)
  await applyLiveHints(client, [{ topic: 'requests', organizationId: orgId }])
  assert.equal(client.getQueryState(types)?.isInvalidated, true) // Type/campaign changes remain broad.
  client.clear()
})

it('matches UTC membership dates and preserves actual offsets in JSON projections', async () => {
  const expected = await prisma.organizationMember.findUniqueOrThrow({ where: { id: memberId }, include: {
    organization: true, _count: { select: { locationMemberships: true } }, accessAssignments: true,
    locationMemberships: { where: { leftAt: null, location: { archivedAt: null } } },
  } })
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'Europe/Kiev'`
    const compact = await readMembership(tx, userId, orgId)
    assert.ok(compact)
    assert.deepEqual(compact.membership, expected)
  })
  const at = <T>(work: () => Promise<T>) => locationContext.run({ organizationId: orgId, locationId }, work)
  const direct = await at(() => getMembership(userId, orgId))
  const transactional = await at(() => prisma.$transaction(tx => getMembership(userId, orgId, tx)))
  assert.deepEqual(direct, transactional)
})

it('checks a session once per HTTP request and rechecks revocation on the next request', async () => {
  const app = express()
  app.get('/probe', requireAuth, requireAuth, (_request, response) => response.json({ ok: true }))
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/probe`
  const original = prisma.$queryRaw
  let lookups = 0
  prisma.$queryRaw = new Proxy(original, { apply(target, receiver, args) { if (Array.isArray(args[0]) && args[0].join('').includes('FROM auth_sessions')) lookups++; return Reflect.apply(target, receiver, args) } })
  try {
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
    assert.equal(lookups, 1)
    await prisma.authSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 401)
    assert.equal(lookups, 2)
  } finally {
    prisma.$queryRaw = original
    await prisma.authSession.update({ where: { id: sessionId }, data: { revokedAt: null } })
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('delivers committed changes across listeners, hides foreign scopes and emits nothing on rollback', async () => {
  const colleague = await prisma.organizationMember.create({ data: { organizationId: orgId, userId: otherId } })
  await prisma.locationMember.create({ data: { organizationId: orgId, locationId, memberId: colleague.id } })
  const a = createLiveHub(), b = createLiveHub({ validationIntervalMs: 200 }), app = express()
  app.get('/live', requireAuth, b.handler)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const controller = new AbortController(), events: Array<{ event: string; data: string }> = []
  let reading: Promise<void> | undefined
  const wait = async (predicate: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 5000
    while (!await predicate()) { if (Date.now() > end) assert.fail('Live update timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  try {
    await wait(() => a.connected() && b.connected())
    // The account-wide page must receive hints from its memberships too.
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/live`
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
    assert.equal(response.status, 200)
    reading = (async () => { const reader = response.body!.getReader(), decoder = new TextDecoder(), parse = eventParser(event => events.push(event)); try { while (true) { const next = await reader.read(); if (next.done) break; parse(decoder.decode(next.value, { stream: true })) } } catch { /* Aborted on cleanup. */ } })()
    await wait(() => events.some(event => event.event === 'ready'))
    await wait(async () => !!(await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId }, select: { lastActiveAt: true } })).lastActiveAt)
    await prisma.$transaction(async tx => { await tx.$executeRaw`SELECT pg_notify('staffly_live', ${JSON.stringify({ topic: 'schedule', organizationId: randomUUID() })})` })
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_notify('staffly_live', ${JSON.stringify({ topic: 'schedule', organizationId: orgId })})`
      throw new Error('rollback')
    }))
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(events.filter(event => event.event === 'change').length, 0)
    await prisma.organizationLocation.update({ where: { id: locationId }, data: { name: 'Committed live change' } })
    await wait(() => events.some(event => event.event === 'change' && event.data.includes('organization')))
    assert.ok(events.every(event => !event.data.includes(userId) && !event.data.includes('Committed live change')))
    const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: orgId, systemCode: 'VACATION' } })
    const create = (id: string) => prisma.organizationRequest.create({ data: { organizationId: orgId, locationId,
      createdByMemberId: id, authorMemberId: id, requestTypeId: type.id, typeNameSnapshot: 'Private request', systemCodeSnapshot: 'VACATION', status: 'PENDING' } })
    const assigned = await create(colleague.id)
    await wait(() => events.some(event => event.event === 'change' && event.data.includes('requests-review')))
    assert.ok(!events.some(event => event.event === 'change' && event.data.includes('requests-mine')))
    await prisma.organizationRequest.update({ where: { id: assigned.id }, data: { outcome: { assignees: [memberId] } } })
    await wait(() => events.some(event => event.event === 'change' && event.data.includes('requests-mine')))
    const mineCount = () => events.filter(event => event.event === 'change' && event.data.includes('requests-mine')).length
    let beforeMine = mineCount()
    await prisma.organizationRequest.update({ where: { id: assigned.id }, data: { outcome: { assignees: [] } } })
    await wait(() => mineCount() > beforeMine) // Removed assignee must clear a stale personal list.
    beforeMine = mineCount()
    await create(memberId)
    await wait(() => mineCount() > beforeMine)
    assert.ok(events.every(event => !event.data.includes('Private request') && !event.data.includes(colleague.id)))
    await prisma.authSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
    await wait(() => b.size() === 0 && events.some(event => event.event === 'reset'))
  } finally {
    controller.abort(); await reading
    await a.stop(); await b.stop()
    await prisma.authSession.update({ where: { id: sessionId }, data: { revokedAt: null } })
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('deduplicates concurrent submissions under shared organization locks', async () => {
  const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: orgId, systemCode: 'VACATION' } })
  const input = { requestTypeId: type.id, submissionKey: randomUUID(), startDate: '2038-12-01', endDate: '2038-12-03' }
  const requests = await Promise.all(Array.from({ length: 8 }, () => locationContext.run({ organizationId: orgId, locationId }, () => createRequest(userId, orgId, input))))
  assert.equal(new Set(requests.map(request => request.id)).size, 1)
})

it('claims a durable export once, generates XLSX outside the API and rechecks download access', async () => {
  const input = { from: '2038-11-01', to: '2038-11-30', locationIds: [locationId], memberIds: [], includeFormer: false, config: defaultReportConfig() }
  const [a, b] = await Promise.all([enqueueExport(userId, orgId, input), enqueueExport(userId, orgId, input)])
  jobs.push(a.id); assert.equal(a.id, b.id)
  const claimed = await Promise.all([processReportExport(), processReportExport()])
  assert.equal(claimed.filter(Boolean).length, 1)
  const ready = await getExport(userId, orgId, a.id)
  assert.equal(ready.job.status, 'READY')
  assert.equal((await storage.read(ready.job.objectKey!)).subarray(0, 2).toString(), 'PK')
  await assert.rejects(getExport(otherId, orgId, a.id), { code: 'EXPORT_NOT_FOUND' })
  await prisma.organizationMember.update({ where: { id: memberId }, data: { role: 'MEMBER' } })
  try { await assert.rejects(getExport(userId, orgId, a.id), { code: 'INSUFFICIENT_PERMISSIONS' }) }
  finally { await prisma.organizationMember.update({ where: { id: memberId }, data: { role: 'OWNER' } }) }
})

it('uses shared S3 storage for put/read/stream/delete and rejects unsafe keys before I/O', async () => {
  const objects = new Map<string, Buffer>()
  const server = http.createServer(async (request, response) => {
    const key = request.url!.split('?')[0]
    if (request.method === 'PUT') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      if (objects.has(key)) { response.statusCode = 412; response.end(); return }
      objects.set(key, Buffer.concat(chunks)); response.end(); return
    }
    if (request.method === 'DELETE') { objects.delete(key); response.statusCode = 204; response.end(); return }
    const value = objects.get(key)
    if (!value) { response.statusCode = 404; response.end(); return }
    response.setHeader('Content-Length', value.length); response.end(value)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const client = new S3Client({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' }, maxAttempts: 1 })
  const s3 = createS3Storage(client, 'private-test'), key = `organizations/${randomUUID()}/${randomUUID()}.txt`
  try {
    await s3.put(key, Buffer.from('shared object')); assert.equal((await s3.read(key)).toString(), 'shared object')
    const result = await s3.stream(key), chunks: Buffer[] = []; for await (const chunk of result.stream) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(), 'shared object'); assert.equal(result.size, 13)
    await assert.rejects(s3.put(key, Buffer.from('overwrite')))
    await assert.rejects(s3.read('../../secrets')); await s3.delete(key); await assert.rejects(s3.read(key))
  } finally { client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
