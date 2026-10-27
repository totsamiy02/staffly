import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID, createHmac } from 'node:crypto'
import type { Server } from 'node:http'
import express from 'express'
import cookieParser from 'cookie-parser'
import { ZodError } from 'zod'
import { prisma } from '../../src/server/db.ts'
import authRouter, { createSession, clearRefreshCookie, requireAuth, verifyLoginPassword } from '../../src/server/auth.ts'
import { createYandexRouter } from '../../src/server/auth/yandex-routes.ts'
import { createEmailChangeRouter } from '../../src/server/auth/email-change-routes.ts'
import { passwordHash } from '../../src/server/auth/passwords.ts'
import { ApiError } from '../../src/server/api-error.ts'
import { processEmailDeliveries } from '../../src/server/mail/email-outbox.ts'
import type { YandexProfile, YandexConfig } from '../../src/server/auth/yandex-provider.ts'
import type { User } from '../../src/generated/prisma/client.ts'

const suffix = randomUUID(), password = 'StafflySecurity-42!', nextPassword = 'NewStafflySecurity-43!'
const address = (label: string) => `${label}-${suffix}@example.test`
const config: YandexConfig = { clientId: 'security-test', clientSecret: 'test-only-secret', origin: 'http://localhost:5173', redirectUri: 'http://localhost:5173/api/auth/yandex/callback' }
const profiles = new Map<string, YandexProfile>(), codes = new Map<string, string>(), snapshots = new Map<string, User>()
const attempts = new Set<string>()
let base: string, server: Server, storedHash: string
class Browser {
  cookies = new Map<string, string>(); token = ''
  async request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { Origin: config.origin, Cookie: [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    for (const line of response.headers.getSetCookie()) { const [name, value] = line.split(';')[0].split('='); if (value) this.cookies.set(name, decodeURIComponent(value)); else this.cookies.delete(name) }
    return response
  }
  async session(user: User, stale = false) {
    if (stale) snapshots.set(user.id, user)
    const response = await this.request('/fixture/session', { userId: user.id, stale })
    if (response.ok) this.token = (await response.json()).accessToken
    return response
  }
  async proof(user: User, purpose: 'password' | 'email', subject = user.id) {
    const response = await this.request(`/api/auth/yandex/${purpose}/start`, {})
    assert.equal(response.status, 200)
    const url = new URL((await response.json()).authorizationUrl), code = randomUUID(), id = this.cookies.get('staffly_yandex')!.split('.')[0]
    attempts.add(id); profiles.set(code, { subject, email: user.email, firstName: 'Provider', lastName: 'Name', avatarId: null })
    const callback = await this.request(`/api/auth/yandex/callback?code=${code}&state=${url.searchParams.get('state')}`)
    return { callback, id }
  }
  setup() { return this.request('/api/auth/yandex/password/complete', { password, confirmPassword: password }) }
  async emailStart(email: string, currentPassword?: string) {
    const response = await this.request('/api/auth/email-change/start', { email, ...(currentPassword ? { currentPassword } : {}) })
    const data = await response.json(); return { response, data }
  }
  confirm(challengeId: string, code: string) { return this.request('/api/auth/email-change/confirm', { challengeId, code }) }
}
async function user(label: string, hasPassword = true) {
  const value = await prisma.user.create({ data: { email: address(label), passwordHash: hasPassword ? storedHash : null, firstName: 'Локальное', lastName: 'Имя', emailVerifiedAt: new Date(), emailNotificationsEnabled: false } })
  if (!hasPassword) await prisma.authIdentity.create({ data: { userId: value.id, provider: 'yandex', subject: value.id, email: value.email } })
  return value
}
async function resetCode(user: User, code = '572960') {
  await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: createHmac('sha256', process.env.JWT_SECRET!).update(`reset:${user.id}:${code}`).digest('hex'), expiresAt: new Date(Date.now() + 60_000) } })
  return code
}
describe('Account login methods and security changes', () => {
  before(async () => {
    storedHash = await passwordHash(password)
    const app = express(); app.use(express.json(), cookieParser())
    // Only a test fixture: production has no endpoint or flag for issuing test sessions.
    app.post('/fixture/session', async (request, response) => {
      const account = request.body.stale ? snapshots.get(request.body.userId)! : await prisma.user.findUniqueOrThrow({ where: { id: request.body.userId } })
      response.json(await createSession(account, request, response))
    })
    app.use('/api/auth/yandex', createYandexRouter({ requireAuth, createSession, verifyPassword: verifyLoginPassword, config: () => config, exchange: async (_settings, code) => { const profile = profiles.get(code); if (!profile) throw new Error('Invalid fixture code'); return profile } }))
    app.use('/api/auth/email-change', createEmailChangeRouter({ requireAuth, clearRefreshCookie, verifyPassword: verifyLoginPassword, sendCode: async (_kind, email, code) => { if (email === address('smtp-failure')) throw new Error('private SMTP response'); codes.set(email, code) } }))
    app.use('/api/auth', authRouter)
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => { response.status(error instanceof ApiError ? error.status : error instanceof ZodError ? 400 : 500).json({ code: error instanceof ApiError ? error.code : 'ERROR' }) })
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const location = server.address(); assert.ok(location && typeof location !== 'string'); base = `http://127.0.0.1:${location.port}`
  })
  after(async () => {
    await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections() })
    await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@example.test` } } })
    await prisma.oAuthAttempt.deleteMany({ where: { id: { in: [...attempts] } } }); await prisma.$disconnect()
  })
  it('requires the current Staffly password before starting a link, including when already authenticated', async () => {
    const account = await user('link-password'), browser = new Browser(); await browser.session(account)
    assert.equal((await browser.request('/api/auth/yandex/link', {})).status, 400)
    assert.equal((await browser.request('/api/auth/yandex/link', { currentPassword: 'wrong' })).status, 401)
    assert.equal(await prisma.oAuthAttempt.count({ where: { userId: account.id } }), 0)
    assert.equal((await browser.request('/api/auth/yandex/link', { currentPassword: password })).status, 200)
    attempts.add(browser.cookies.get('staffly_yandex')!.split('.')[0])
  })
  it('requires a fresh matching Yandex identity and never trusts a success query marker', async () => {
    const account = await user('proof', false), browser = new Browser(); await browser.session(account)
    assert.equal((await browser.setup()).status, 400)
    const mismatch = await browser.proof(account, 'password', 'another-yandex-id'); assert.match(mismatch.callback.headers.get('location')!, /wrong-account/)
    assert.equal((await browser.setup()).status, 400)
    const proof = await browser.proof(account, 'password'); assert.match(proof.callback.headers.get('location')!, /password-ready/)
    const methods = await (await browser.request('/api/auth/yandex/methods')).json(); assert.equal(methods.passwordSetupReady, true); assert.equal(methods.emailChangeReady, false)
    const other = new Browser(); await other.session(account); other.cookies.set('staffly_yandex', browser.cookies.get('staffly_yandex')!)
    assert.equal((await other.setup()).status, 400)
    assert.equal((await browser.setup()).status, 200); assert.equal((await browser.setup()).status, 409)
    assert.equal((await other.request('/api/auth/me')).status, 401)
    assert.equal((await browser.request('/api/auth/me')).status, 200)
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: account.id } }); assert.ok(await verifyLoginPassword(stored.passwordHash, password)); assert.equal(stored.firstName, 'Локальное')
    const mail = await prisma.emailDelivery.findMany({ where: { userId: account.id } }); assert.equal(mail.length, 1); assert.equal(mail[0].category, null); assert.equal(mail[0].sourceKind, 'MANDATORY'); assert.equal(mail[0].recipientEmail, account.email)
  })
  it('binds proofs to purpose, browser, expiration and credential version', async () => {
    const account = await user('purpose', false), browser = new Browser(); await browser.session(account)
    await browser.proof(account, 'email'); assert.equal((await browser.setup()).status, 400)
    const proof = await browser.proof(account, 'password')
    const copy = new Browser(); copy.token = browser.token; copy.cookies.set('staffly_refresh', browser.cookies.get('staffly_refresh')!)
    assert.equal((await copy.setup()).status, 400)
    await prisma.oAuthAttempt.update({ where: { id: proof.id }, data: { expiresAt: new Date(0) } }); assert.equal((await browser.setup()).status, 400)
    await browser.proof(account, 'password'); await prisma.user.update({ where: { id: account.id }, data: { securityVersion: { increment: 1 } } }); assert.equal((await browser.setup()).status, 400)
  })
  it('does not permit a revoked original session to finish password creation', async () => {
    const account = await user('revoked-proof', false), browser = new Browser(); await browser.session(account); await browser.proof(account, 'password')
    await browser.request('/api/auth/logout', {}); assert.equal((await browser.setup()).status, 401)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).passwordHash, null)
  })
  it('consumes parallel password setup exactly once and sends only one security notification', async () => {
    const account = await user('parallel-password', false), browser = new Browser(); await browser.session(account); await browser.proof(account, 'password')
    const responses = await Promise.all([browser.setup(), browser.setup()]); assert.equal(responses.filter(r => r.ok).length, 1)
    assert.equal(await prisma.emailDelivery.count({ where: { userId: account.id } }), 1)
  })
  it('invalidates old reset codes and pending links after a password change', async () => {
    const account = await user('change-password'), browser = new Browser(), other = new Browser(); await browser.session(account); await other.session(account)
    const code = await resetCode(account)
    const started = await browser.request('/api/auth/yandex/link', { currentPassword: password }); assert.equal(started.status, 200)
    const flowId = browser.cookies.get('staffly_yandex')!.split('.')[0]; attempts.add(flowId)
    assert.equal((await browser.request('/api/auth/change-password', { currentPassword: password, newPassword: nextPassword })).status, 200)
    assert.equal(await prisma.oAuthAttempt.count({ where: { id: flowId } }), 0)
    assert.equal((await browser.request('/api/auth/reset-password', { email: account.email, code, password, confirmPassword: password })).status, 400)
    assert.equal((await other.request('/api/auth/me')).status, 401); assert.equal((await browser.request('/api/auth/me')).status, 200)
    assert.equal((await browser.request('/api/auth/login', { email: account.email, password: nextPassword })).status, 200)
    assert.equal((await browser.request('/api/auth/login', { email: account.email, password })).status, 401)
  })
  it('does not create a session from an authenticated snapshot predating a credential change', async () => {
    const account = await user('stale-login'), browser = new Browser()
    await prisma.user.update({ where: { id: account.id }, data: { securityVersion: { increment: 1 } } })
    assert.equal((await browser.session(account, true)).status, 409); assert.equal(await prisma.authSession.count({ where: { userId: account.id } }), 0)
  })
  it('still recovers an existing password, consumes the code and revokes every old session', async () => {
    const account = await user('existing-password-reset'), browser = new Browser(), other = new Browser(); await browser.session(account); await other.session(account)
    const code = await resetCode(account)
    const body = { email: account.email, code, password: nextPassword, confirmPassword: nextPassword }
    assert.equal((await browser.request('/api/auth/reset-password', { ...body, code: '000000' })).status, 400)
    assert.equal((await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: account.id } })).attempts, 1)
    assert.equal((await browser.request('/api/auth/reset-password', body)).status, 200)
    assert.equal((await browser.request('/api/auth/reset-password', body)).status, 400)
    assert.equal((await browser.request('/api/auth/me')).status, 401); assert.equal((await other.request('/api/auth/me')).status, 401)
    assert.equal((await browser.request('/api/auth/login', { email: account.email, password: nextPassword })).status, 200)
    assert.equal(await prisma.emailDelivery.count({ where: { userId: account.id, sourceKind: 'MANDATORY' } }), 1)
  })
  it('keeps the old address until code confirmation and requires password proof for email change', async () => {
    const account = await user('email-local'), browser = new Browser(), other = new Browser(); await browser.session(account); await other.session(account)
    assert.equal((await browser.emailStart(address('new-local'))).response.status, 401)
    const { response, data } = await browser.emailStart(address('new-local'), password); assert.equal(response.status, 200); assert.equal(data.code, undefined)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).email, account.email)
    const token = await prisma.emailChangeToken.findUniqueOrThrow({ where: { id: data.challengeId } }); assert.notEqual(token.codeHash, codes.get(data.email))
    assert.equal((await other.confirm(data.challengeId, codes.get(data.email)!)).status, 400)
    const wrong = codes.get(data.email) === '000000' ? '111111' : '000000'; assert.equal((await browser.confirm(data.challengeId, wrong)).status, 400)
    assert.equal((await prisma.emailChangeToken.findUniqueOrThrow({ where: { id: data.challengeId } })).attempts, 1)
    assert.equal((await browser.confirm(data.challengeId, codes.get(data.email)!)).status, 200)
    assert.equal((await browser.confirm(data.challengeId, codes.get(data.email)!)).status, 401)
    assert.equal((await other.request('/api/auth/me')).status, 401)
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: account.id } }); assert.equal(updated.email, data.email); assert.equal(updated.firstName, account.firstName); assert.equal(updated.passwordHash, account.passwordHash)
    const mail = await prisma.emailDelivery.findMany({ where: { userId: account.id } }); assert.deepEqual(mail.map(m => m.recipientEmail).sort(), [account.email, data.email].sort()); assert.ok(mail.every(m => m.sourceKind === 'MANDATORY' && !m.category))
    assert.equal((await browser.request('/api/auth/login', { email: account.email, password })).status, 401)
    assert.equal((await browser.request('/api/auth/login', { email: data.email, password })).status, 200)
  })
  it('does not substitute a password-setup proof for email-change proof', async () => {
    const account = await user('email-purpose', false), browser = new Browser(); await browser.session(account); await browser.proof(account, 'password')
    assert.equal((await browser.emailStart(address('wrong-purpose'))).response.status, 400)
    await browser.proof(account, 'email'); const { data, response } = await browser.emailStart(address('yandex-new-address')); assert.equal(response.status, 200)
    assert.equal((await browser.emailStart(address('proof-reused'))).response.status, 400)
    assert.equal((await browser.confirm(data.challengeId, codes.get(data.email)!)).status, 200)
    const identity = await prisma.authIdentity.findUniqueOrThrow({ where: { userId_provider: { userId: account.id, provider: 'yandex' } } }); assert.equal(identity.subject, account.id); assert.equal(identity.email, account.email)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).passwordHash, null)
    // The same Yandex subject still opens the original account, even with the old provider email.
    const fresh = new Browser(), start = await fresh.request('/api/auth/yandex/start', {}), url = new URL((await start.json()).authorizationUrl), code = randomUUID()
    attempts.add(fresh.cookies.get('staffly_yandex')!.split('.')[0]); profiles.set(code, { subject: account.id, email: account.email, firstName: 'Provider', lastName: 'Changed', avatarId: null })
    const callback = await fresh.request(`/api/auth/yandex/callback?code=${code}&state=${url.searchParams.get('state')}`); assert.equal(callback.headers.get('location'), '/app')
    const session = await (await fresh.request('/api/auth/refresh', {})).json(); assert.equal(session.user.id, account.id); assert.equal(session.user.email, data.email); assert.equal(session.user.firstName, 'Локальное')
  })
  it('limits wrong email codes and rejects expired, cancelled and cross-account challenges', async () => {
    const account = await user('email-limits'), browser = new Browser(); await browser.session(account)
    const { data } = await browser.emailStart(address('email-limits-new'), password), wrong = codes.get(data.email) === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) assert.equal((await browser.confirm(data.challengeId, wrong)).status, 400)
    assert.equal((await browser.confirm(data.challengeId, codes.get(data.email)!)).status, 400)
    const next = await browser.emailStart(address('email-expired'), password); await prisma.emailChangeToken.update({ where: { id: next.data.challengeId }, data: { expiresAt: new Date(0) } }); assert.equal((await browser.confirm(next.data.challengeId, codes.get(next.data.email)!)).status, 400)
    const cancel = await browser.emailStart(address('email-cancel'), password); assert.equal((await browser.request('/api/auth/email-change/cancel', { challengeId: cancel.data.challengeId })).status, 204); assert.equal((await browser.confirm(cancel.data.challengeId, codes.get(cancel.data.email)!)).status, 400)
    const third = await browser.emailStart(address('email-other-user'), password), attacker = new Browser(); await attacker.session(await user('email-attacker')); assert.equal((await attacker.confirm(third.data.challengeId, codes.get(third.data.email)!)).status, 400)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).email, account.email)
  })
  it('invalidates a pending email change on credential change and leaves no usable token after delivery failure', async () => {
    const account = await user('email-stale'), browser = new Browser(); await browser.session(account)
    const { data } = await browser.emailStart(address('email-stale-new'), password)
    assert.equal((await browser.request('/api/auth/change-password', { currentPassword: password, newPassword: nextPassword })).status, 200)
    assert.equal((await browser.confirm(data.challengeId, codes.get(data.email)!)).status, 400)
    const failed = await browser.emailStart(address('smtp-failure'), nextPassword); assert.equal(failed.response.status, 503); assert.ok(!JSON.stringify(failed.data).includes('private SMTP'))
    assert.equal(await prisma.emailChangeToken.count({ where: { userId: account.id, usedAt: null } }), 0)
  })
  it('rejects an occupied email at request and again at confirmation without changing data or sending alerts', async () => {
    const account = await user('email-conflict'), taken = await user('email-taken'), browser = new Browser(); await browser.session(account)
    assert.equal((await browser.emailStart(taken.email, password)).response.status, 409)
    const { data } = await browser.emailStart(address('email-late-taken'), password); await prisma.user.create({ data: { email: data.email } })
    assert.equal((await browser.confirm(data.challengeId, codes.get(data.email)!)).status, 409)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).email, account.email); assert.equal(await prisma.emailDelivery.count({ where: { userId: account.id } }), 0)
  })
  it('commits concurrent email confirmation once and preserves old and new alert recipients at delivery time', async () => {
    const account = await user('email-parallel'), browser = new Browser(); await browser.session(account)
    const { data } = await browser.emailStart(address('email-parallel-new'), password)
    const responses = await Promise.all([browser.confirm(data.challengeId, codes.get(data.email)!), browser.confirm(data.challengeId, codes.get(data.email)!)]); assert.equal(responses.filter(r => r.ok).length, 1)
    assert.equal(await prisma.emailDelivery.count({ where: { userId: account.id } }), 2)
    // Another address change must not redirect an already queued security alert.
    await prisma.user.update({ where: { id: account.id }, data: { email: address('email-later') } })
    const deliveries: Array<{ email: string; text: string }> = []
    await processEmailDeliveries({ send: async (email, mail) => { deliveries.push({ email, text: mail.text }) } })
    const own = deliveries.filter(d => [account.email, data.email].includes(d.email)); assert.equal(own.length, 2); assert.ok(own.every(d => !d.text.includes(codes.get(data.email)!)))
    assert.deepEqual(own.map(d => d.email).sort(), [account.email, data.email].sort())
  })
})
