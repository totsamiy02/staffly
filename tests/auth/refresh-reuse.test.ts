import assert from 'node:assert/strict'
import { before, after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import { prisma, databasePool } from '../../src/server/db.ts'
import authRouter, { createSession } from '../../src/server/auth.ts'
import { refreshHash, REFRESH_RETRY_MS, revokeRefreshToken } from '../../src/server/auth/refresh-tokens.ts'

let base: string, server: ReturnType<ReturnType<typeof express>['listen']>
const users: string[] = []
type Cookies = Record<string, string>
async function post(path: string, cookies: Cookies = {}, body = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') }, body: JSON.stringify(body) })
}
function cookiesFrom(response: Response, previous: Cookies = {}) {
  const next = { ...previous }
  for (const line of response.headers.getSetCookie()) { const [k, v] = line.split(';')[0].split('='); if (v) next[k] = decodeURIComponent(v); else delete next[k] }
  return next
}
async function login() {
  const user = await prisma.user.create({ data: { email: `reuse-${randomUUID()}@example.test`, emailVerifiedAt: new Date() } }); users.push(user.id)
  const response = await post('/fixture', {}, { id: user.id }); assert.equal(response.status, 200)
  return { user, cookies: cookiesFrom(response), result: await response.json() }
}
before(async () => {
  const app = express(); app.use(express.json(), cookieParser())
  app.post('/fixture', async (req, res) => res.json(await createSession(await prisma.user.findUniqueOrThrow({ where: { id: req.body.id } }), req, res)))
  app.use('/api/auth', authRouter)
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ code: error.code }))
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
})
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.$disconnect() })

it('coalesces concurrent refreshes across replicas/tabs and recovers a lost response without rotating twice', async () => {
  const fixture = await login()
  const replies = await Promise.all(Array.from({ length: 6 }, () => post('/api/auth/refresh', fixture.cookies)))
  assert.ok(replies.every(r => r.status === 200))
  const replacements = replies.map(r => cookiesFrom(r, fixture.cookies))
  assert.equal(new Set(replacements.map(c => c.staffly_refresh)).size, 1)
  assert.notEqual(replacements[0].staffly_refresh, fixture.cookies.staffly_refresh)
  assert.equal(await prisma.refreshTokenUse.count({ where: { session: { userId: fixture.user.id } } }), 1)
  // Ignore every response's Set-Cookie, as if the network lost the response.
  const retry = await post('/api/auth/refresh', fixture.cookies)
  assert.equal(retry.status, 200); assert.equal(cookiesFrom(retry).staffly_refresh, replacements[0].staffly_refresh)
  assert.equal((await post('/api/auth/refresh', replacements[0])).status, 200)
})

it('recovers out-of-order cookie responses after several rotations within a fixed retry window', async () => {
  const fixture = await login(); let current = fixture.cookies
  for (let i = 0; i < 4; i++) { const r = await post('/api/auth/refresh', current); assert.equal(r.status, 200); current = cookiesFrom(r, current) }
  const retry = await post('/api/auth/refresh', fixture.cookies)
  assert.equal(retry.status, 200); assert.equal(cookiesFrom(retry).staffly_refresh, current.staffly_refresh)
  assert.equal(await prisma.refreshTokenUse.count({ where: { session: { userId: fixture.user.id } } }), 4)
})

it('revokes the related session and its access tokens on reuse outside grace, leaving other sessions active', async () => {
  const fixture = await login()
  const other = await post('/fixture', {}, { id: fixture.user.id }); const otherCookies = cookiesFrom(other)
  const r = await post('/api/auth/refresh', fixture.cookies); const next = cookiesFrom(r, fixture.cookies); const access = (await r.json()).accessToken
  await prisma.refreshTokenUse.update({ where: { tokenHash: refreshHash(fixture.cookies.staffly_refresh) }, data: { consumedAt: new Date(Date.now() - REFRESH_RETRY_MS - 1000) } })
  assert.equal((await post('/api/auth/refresh', fixture.cookies)).status, 401)
  assert.equal((await post('/api/auth/refresh', next)).status, 401)
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${access}` } })).status, 401)
  assert.equal((await post('/api/auth/refresh', otherCookies)).status, 200)
})

it('does not grant grace to a replay from a different browser and ignores unknown token hashes', async () => {
  const fixture = await login()
  assert.equal((await post('/api/auth/refresh', { staffly_refresh: randomUUID() })).status, 401)
  assert.equal((await post('/api/auth/refresh', fixture.cookies)).status, 200)
  assert.equal((await post('/api/auth/refresh', { staffly_refresh: fixture.cookies.staffly_refresh })).status, 401)
  assert.ok((await prisma.authSession.findFirstOrThrow({ where: { userId: fixture.user.id } })).revokedAt)
})

it('logs out with a spent token after a lost response and starts a fresh grant on authenticated login', async () => {
  const fixture = await login()
  await post('/api/auth/refresh', fixture.cookies)
  assert.equal((await post('/api/auth/logout', fixture.cookies)).status, 204)
  assert.ok((await prisma.authSession.findFirstOrThrow({ where: { userId: fixture.user.id } })).revokedAt)
  const fresh = await post('/fixture', fixture.cookies, { id: fixture.user.id }); const current = cookiesFrom(fresh, fixture.cookies)
  assert.equal((await post('/api/auth/refresh', fixture.cookies)).status, 401)
  assert.equal((await post('/api/auth/refresh', current)).status, 200)
})

it('starts a fresh grant on repeat login without letting an older grant revoke the preserved browser session', async () => {
  const fixture = await login()
  const rotated = await post('/api/auth/refresh', fixture.cookies)
  const session = await prisma.authSession.findFirstOrThrow({ where: { userId: fixture.user.id } })
  const fresh = await post('/fixture', cookiesFrom(rotated, fixture.cookies), { id: fixture.user.id })
  assert.equal(fresh.status, 200)
  assert.equal(await prisma.refreshTokenUse.count({ where: { sessionId: session.id } }), 0)
  assert.equal((await post('/api/auth/refresh', fixture.cookies)).status, 401)
  const obsoleteLogout = await post('/api/auth/logout', fixture.cookies)
  assert.equal(obsoleteLogout.status, 204); assert.equal(obsoleteLogout.headers.get('set-cookie'), null)
  assert.equal((await post('/api/auth/refresh', cookiesFrom(fresh, fixture.cookies))).status, 200)
  assert.equal(await prisma.authSession.count({ where: { userId: fixture.user.id } }), 1)
})

it('does not revoke a fresh login when logout looked up its old grant before the login committed', async () => {
  const fixture = await login()
  await post('/api/auth/refresh', fixture.cookies)
  const session = await prisma.authSession.findFirstOrThrow({ where: { userId: fixture.user.id } })
  let ready!: () => void, release!: () => void
  const locked = new Promise<void>(resolve => { ready = resolve }), commit = new Promise<void>(resolve => { release = resolve })
  const newToken = randomUUID() + randomUUID()
  // Hold the real login's user/session locks while changing the grant. The old
  // history remains visible to another connection until this transaction commits.
  const relogin = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${fixture.user.id}::uuid FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${session.id}::uuid FOR UPDATE`
    await tx.authSession.update({ where: { id: session.id }, data: { refreshTokenHash: refreshHash(newToken) } })
    await tx.refreshTokenUse.deleteMany({ where: { sessionId: session.id } })
    ready(); await commit
  })
  await locked
  const logout = revokeRefreshToken(fixture.cookies.staffly_refresh)
  try {
    let waiting = false
    for (let i = 0; i < 100; i++) {
      const result = await databasePool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()) AS waiting")
      if (result.rows[0].waiting) { waiting = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(waiting, 'Logout must reach the uncommitted login before commit')
    release(); await Promise.all([relogin, logout])
    assert.equal((await prisma.authSession.findUniqueOrThrow({ where: { id: session.id } })).revokedAt, null)
    assert.equal((await post('/api/auth/refresh', { ...fixture.cookies, staffly_refresh: newToken })).status, 200)
  } finally { release(); await Promise.allSettled([relogin, logout]) }
})
