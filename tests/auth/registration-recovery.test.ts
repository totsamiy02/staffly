import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createHmac, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import express from 'express'
import cookieParser from 'cookie-parser'
import { prisma } from '../../src/server/db.ts'
import { createAuthRouter, createSession } from '../../src/server/auth.ts'
import { passwordHash, passwordSchema, verifyLoginPassword } from '../../src/server/auth/passwords.ts'
import { passwordValidationError } from '../../src/app/auth/password-policy.ts'
import { ApiError } from '../../src/server/api-error.ts'

const suffix = randomUUID(), ownerPassword = 'моя длинная фраза для входа', attackerPassword = 'AttackerKnownPassword-42!'
const email = (name: string) => `${name}-${suffix}@example.test`
const mail = new Map<string, string>(), accounts = new Set<string>()
const keys = new Set<string>()
let server: Server, base: string, ip = 0
class Browser {
  token = ''; cookie = ''
  async request(path: string, body?: unknown) {
    // A different IP for every request proves that account protection is independent of IP limits.
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Forwarded-For': `198.51.${Math.floor(++ip / 250)}.${ip % 250 + 1}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), Cookie: this.cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (response.ok && response.headers.getSetCookie().length) this.cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    return response
  }
  async session(id: string) {
    const response = await this.request('/fixture/session', { id }); this.token = (await response.json()).accessToken
  }
}
async function createUser(name: string, verified = true, hasPassword = false) {
  const value = await prisma.user.create({ data: { email: email(name), emailVerifiedAt: verified ? new Date() : null, passwordHash: hasPassword ? await passwordHash(attackerPassword) : null } })
  accounts.add(value.email)
  return value
}
function verification(userId: string, code: string) {
  return prisma.emailVerificationToken.create({ data: { userId, tokenHash: createHmac('sha256', process.env.JWT_SECRET!).update(`verification:${userId}:${code}`).digest('hex'), expiresAt: new Date(Date.now() + 60_000) } })
}
const verificationBody = (address: string, code: string) => ({ email: address, code, password: ownerPassword, confirmPassword: ownerPassword, consentData: true, consentTerms: true })

describe('Mailbox ownership, first passwords and recovery', () => {
  before(async () => {
    const app = express(); app.set('trust proxy', 1); app.use(express.json(), cookieParser())
    app.post('/fixture/session', async (request, response) => response.json(await createSession(await prisma.user.findUniqueOrThrow({ where: { id: request.body.id } }), request, response)))
    app.use('/api/auth', createAuthRouter({ sendCode: async (kind, address, code) => { mail.set(`${kind}:${address}`, code) } }))
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error instanceof ApiError ? error.status : 500).json({ message: error instanceof Error ? error.message : 'Error' }))
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`
  })
  after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    for (const address of accounts) for (const purpose of ['password', 'send-code', 'verification-code', 'reset-code']) keys.add(createHmac('sha256', process.env.JWT_SECRET!).update(`${purpose}:${address}`).digest('hex'))
    await prisma.authAttemptLimit.deleteMany({ where: { key: { in: [...keys] } } })
    await prisma.user.deleteMany({ where: { email: { in: [...accounts] } } }); await prisma.$disconnect()
  })
  it('never activates a password chosen by somebody who preregistered the address', async () => {
    const address = email('preregistered'); accounts.add(address); const attacker = new Browser(), owner = new Browser()
    assert.equal((await attacker.request('/api/auth/register', { email: address, password: attackerPassword, confirmPassword: attackerPassword, consentData: true, consentTerms: true })).status, 202)
    const pending = await prisma.user.findUniqueOrThrow({ where: { email: address } }); assert.equal(pending.passwordHash, null); assert.equal(pending.emailVerifiedAt, null)
    assert.equal((await owner.request('/api/auth/register', { email: address })).status, 202)
    const code = mail.get(`verification:${address}`)!; assert.ok(code)
    assert.equal((await owner.request('/api/auth/verify-email', { email: address, code })).status, 400)
    const response = await owner.request('/api/auth/verify-email', verificationBody(address, code)); assert.equal(response.status, 200); assert.ok((await response.json()).accessToken)
    assert.equal((await attacker.request('/api/auth/login', { email: address, password: attackerPassword })).status, 401)
    assert.equal((await owner.request('/api/auth/login', { email: address, password: ownerPassword })).status, 200)
    assert.equal((await owner.request('/api/auth/verify-email', verificationBody(address, code))).status, 400)
  })
  it('replaces legacy pending passwords and consumes parallel verification exactly once', async () => {
    const account = await createUser('legacy', false, true), browser = new Browser(); await verification(account.id, '572960')
    const responses = await Promise.all([browser.request('/api/auth/verify-email', verificationBody(account.email, '572960')), new Browser().request('/api/auth/verify-email', verificationBody(account.email, '572960'))])
    assert.equal(responses.filter(response => response.ok).length, 1)
    const current = await prisma.user.findUniqueOrThrow({ where: { id: account.id } })
    assert.ok(await verifyLoginPassword(current.passwordHash, ownerPassword)); assert.equal(await verifyLoginPassword(current.passwordHash, attackerPassword), false)
    assert.ok(current.termsAcceptedAt && current.dataConsentAt); assert.equal(await prisma.authSession.count({ where: { userId: account.id } }), 1)
  })
  it('limits verification guesses and refuses expired codes', async () => {
    const account = await createUser('guesses', false), browser = new Browser(); const token = await verification(account.id, '572960')
    for (let index = 0; index < 5; index++) assert.equal((await browser.request('/api/auth/verify-email', verificationBody(account.email, '000000'))).status, 400)
    assert.equal((await browser.request('/api/auth/verify-email', verificationBody(account.email, '572960'))).status, 400)
    await prisma.emailVerificationToken.update({ where: { id: token.id }, data: { attempts: 0, expiresAt: new Date(0) } })
    assert.equal((await browser.request('/api/auth/verify-email', verificationBody(account.email, '572960'))).status, 400)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).emailVerifiedAt, null)
  })
  it('recovers a Yandex-only account, preserves its identity and revokes all prior sessions', async () => {
    const account = await createUser('yandex-recovery'), browser = new Browser(), other = new Browser()
    await prisma.authIdentity.create({ data: { userId: account.id, provider: 'yandex', subject: account.id, email: account.email } })
    await browser.session(account.id); await other.session(account.id)
    assert.equal((await browser.request('/api/auth/forgot-password', { email: account.email })).status, 202)
    const code = mail.get(`reset:${account.email}`)!; assert.ok(code)
    const body = { email: account.email, code, password: ownerPassword, confirmPassword: ownerPassword }
    assert.equal((await browser.request('/api/auth/reset-password', { ...body, code: 'bad' })).status, 400)
    const responses = await Promise.all([browser.request('/api/auth/reset-password', body), other.request('/api/auth/reset-password', body)])
    assert.equal(responses.filter(response => response.ok).length, 1)
    assert.equal((await browser.request('/api/auth/me')).status, 401); assert.equal((await other.request('/api/auth/me')).status, 401)
    assert.equal(await prisma.authIdentity.count({ where: { userId: account.id, subject: account.id } }), 1)
    assert.equal(await prisma.emailDelivery.count({ where: { userId: account.id, sourceKind: 'MANDATORY', recipientEmail: account.email } }), 1)
    assert.equal((await new Browser().request('/api/auth/reset-password', body)).status, 400)
    assert.equal((await new Browser().request('/api/auth/login', { email: account.email, password: ownerPassword })).status, 200)
  })
  it('keeps recovery replies generic and never recovers an unverified or deleted account', async () => {
    const pending = await createUser('not-verified', false), deleted = await createUser('deleted')
    await prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
    const absent = email('absent'); accounts.add(absent)
    const replies = []
    for (const address of [pending.email, deleted.email, absent]) {
      const response = await new Browser().request('/api/auth/forgot-password', { email: address }); assert.equal(response.status, 202); replies.push(await response.json()); assert.equal(mail.has(`reset:${address}`), false)
    }
    assert.deepEqual(replies[0], replies[1]); assert.deepEqual(replies[0], replies[2])
  })
  it('separates verification and reset codes, expires them and bounds reset guesses', async () => {
    const account = await createUser('reset-guards'), browser = new Browser()
    await verification(account.id, '572960')
    const body = { email: account.email, code: '572960', password: ownerPassword, confirmPassword: ownerPassword }
    assert.equal((await browser.request('/api/auth/reset-password', body)).status, 400)
    await browser.request('/api/auth/forgot-password', { email: account.email })
    const code = mail.get(`reset:${account.email}`)!, wrong = code === '000000' ? '111111' : '000000'
    assert.equal((await browser.request('/api/auth/verify-email', verificationBody(account.email, code))).status, 400)
    for (let index = 0; index < 5; index++) assert.equal((await browser.request('/api/auth/reset-password', { ...body, code: wrong })).status, 400)
    assert.equal((await browser.request('/api/auth/reset-password', { ...body, code })).status, 400)
    const token = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: account.id } }); assert.equal(token.attempts, 5)
    await prisma.passwordResetToken.update({ where: { id: token.id }, data: { attempts: 0, expiresAt: new Date(0) } })
    assert.equal((await browser.request('/api/auth/reset-password', { ...body, code })).status, 400)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).passwordHash, null)
  })
  it('limits code sending per mailbox across IPs and keeps only the latest usable code', async () => {
    const account = await createUser('send-limits'), browser = new Browser()
    for (let index = 0; index < 5; index++) {
      await prisma.user.update({ where: { id: account.id }, data: { lastSecurityEmailAt: null } })
      assert.equal((await browser.request('/api/auth/forgot-password', { email: account.email })).status, 202)
      assert.equal(await prisma.passwordResetToken.count({ where: { userId: account.id } }), 1)
    }
    assert.equal((await new Browser().request('/api/auth/forgot-password', { email: account.email })).status, 429)
  })
  it('bounds account password guesses across IPs and server instances, then permits recovery after cooldown', async () => {
    const account = await createUser('distributed', true, true)
    for (let index = 0; index < 10; index++) assert.equal((await new Browser().request('/api/auth/login', { email: account.email, password: 'incorrect' })).status, 401)
    assert.equal((await new Browser().request('/api/auth/login', { email: account.email, password: attackerPassword })).status, 429)
    const key = createHmac('sha256', process.env.JWT_SECRET!).update(`password:${account.email}`).digest('hex')
    await prisma.authAttemptLimit.update({ where: { key }, data: { expiresAt: new Date(0) } })
    assert.equal((await new Browser().request('/api/auth/login', { email: account.email, password: attackerPassword })).status, 200)
  })
  it('lets verified recovery unlock a throttled password immediately', async () => {
    const account = await createUser('locked-recovery', true, true), key = createHmac('sha256', process.env.JWT_SECRET!).update(`password:${account.email}`).digest('hex')
    await prisma.authAttemptLimit.create({ data: { key, attempts: 11, expiresAt: new Date(Date.now() + 15 * 60_000) } })
    const browser = new Browser(); assert.equal((await browser.request('/api/auth/login', { email: account.email, password: attackerPassword })).status, 429)
    await browser.request('/api/auth/forgot-password', { email: account.email })
    const code = mail.get(`reset:${account.email}`)!
    assert.equal((await browser.request('/api/auth/reset-password', { email: account.email, code, password: ownerPassword, confirmPassword: ownerPassword })).status, 200)
    assert.equal((await browser.request('/api/auth/login', { email: account.email, password: ownerPassword })).status, 200)
  })
  it('uses one modern policy for creation while allowing old passwords for login', async () => {
    for (const value of [ownerPassword, '🦊🌿'.repeat(8), 'very long lowercase phrase with spaces']) { assert.equal(passwordValidationError(value), ''); assert.equal(passwordSchema.safeParse(value).success, true) }
    for (const value of ['short', ' '.repeat(20), 'a'.repeat(20), 'correct horse battery staple', '123456789012345']) assert.equal(passwordSchema.safeParse(value).success, false)
    const account = await createUser('old-password'), browser = new Browser()
    await prisma.user.update({ where: { id: account.id }, data: { passwordHash: await passwordHash('OldPass-42!') } })
    assert.equal((await browser.request('/api/auth/login', { email: account.email, password: 'OldPass-42!' })).status, 200)
  })
})
