import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import express from 'express'
import cookieParser from 'cookie-parser'
import { hash } from 'argon2'
import sharp from 'sharp'
import { prisma } from '../../src/server/db.ts'
import authRouter, { createSession, requireAuth, verifyLoginPassword } from '../../src/server/auth.ts'
import profileRouter from '../../src/server/profile/routes.ts'
import { createYandexRouter } from '../../src/server/auth/yandex-routes.ts'
import { exchangeYandexCode, parseYandexProfile, yandexAuthorizationUrl, yandexAvatar, yandexConfig, type YandexProfile, type YandexConfig } from '../../src/server/auth/yandex-provider.ts'
import { removeUserAvatar } from '../../src/server/storage/image-service.ts'
import { ApiError } from '../../src/server/api-error.ts'
import { safeReturnTo } from '../../src/app/auth/return-to.ts'

const config: YandexConfig = { clientId: 'test-yandex-client', clientSecret: 'test-yandex-secret', origin: 'http://localhost:5173', redirectUri: 'http://localhost:5173/api/auth/yandex/callback' }
const suffix = randomUUID(), password = 'StafflyTesting-42!'
const email = (label: string) => `${label}-${suffix}@example.test`
const hashValue = (input: string) => createHash('sha256').update(input).digest('hex')
const profiles = new Map<string, YandexProfile>()
const attemptIds = new Set<string>()
let server: Server, base: string, passwordHash: string, image: Buffer, exchangeCalls = 0
class Browser {
  cookies = new Map<string, string>()
  token: string | null = null
  async request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { Origin: config.origin, Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(';')[0].split('='); if (value) this.cookies.set(name, decodeURIComponent(value)); else this.cookies.delete(name) }
    return response
  }
  async start(profile: YandexProfile, returnTo = '/app', link = false) {
    const response = await this.request(`/api/auth/yandex/${link ? 'link' : 'start'}`, { returnTo, ...(link ? { currentPassword: password } : {}) })
    assert.equal(response.status, 200)
    const data = await response.json(), url = new URL(data.authorizationUrl), state = url.searchParams.get('state')!, code = randomUUID()
    const id = this.cookies.get('staffly_yandex')!.split('.')[0]
    profiles.set(code, profile); attemptIds.add(id)
    return { response, url, state, code, id }
  }
  async callback(flow: Awaited<ReturnType<Browser['start']>>, query = `code=${flow.code}&state=${flow.state}`) { return this.request(`/api/auth/yandex/callback?${query}`) }
  async complete(body: unknown = { consentData: true, consentTerms: true }) {
    const response = await this.request('/api/auth/yandex/complete', body), data = await response.json()
    if (response.ok) this.token = data.accessToken
    return { response, data }
  }
  async login(accountEmail: string) {
    const response = await this.request('/api/auth/login', { email: accountEmail, password })
    assert.equal(response.status, 200); const data = await response.json(); this.token = data.accessToken; return data
  }
}
const profile = (label: string, extra: Partial<YandexProfile> = {}): YandexProfile => ({ subject: `test-${randomUUID()}`, email: email(label), firstName: 'Ярослав', lastName: 'Биленко', avatarId: 'test-avatar', ...extra })
async function localUser(label: string, data: object = {}) { return prisma.user.create({ data: { email: email(label), passwordHash, emailVerifiedAt: new Date(), firstName: 'Свое', lastName: 'Имя', ...data } }) }

describe('Yandex ID provider boundary', () => {
  it('allows only local app return paths, including invitation parameters', () => {
    assert.equal(safeReturnTo('/app?invite=example'), '/app?invite=example')
    assert.equal(safeReturnTo('/app/settings?section=security'), '/app/settings?section=security')
    for (const path of ['https://evil.test', '//evil.test', '/application', '/app/../../auth', '/app\\evil.test', '/app\nfoo', '/app/%2e%2e/%2e%2e/evil']) assert.equal(safeReturnTo(path), '/app')
  })
  it('validates callback origins and rejects HTTP in production without exposing configuration', () => {
    const keys = ['YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET', 'YANDEX_REDIRECT_URI', 'APP_ORIGIN', 'NODE_ENV'] as const
    const previous = keys.map(key => process.env[key])
    try {
      Object.assign(process.env, { YANDEX_CLIENT_ID: config.clientId, YANDEX_CLIENT_SECRET: config.clientSecret, YANDEX_REDIRECT_URI: config.redirectUri, APP_ORIGIN: config.origin, NODE_ENV: 'test' })
      assert.equal(yandexConfig()?.clientId, config.clientId)
      process.env.YANDEX_REDIRECT_URI = 'https://evil.test/api/auth/yandex/callback'; assert.equal(yandexConfig(), null)
      process.env.YANDEX_REDIRECT_URI = config.redirectUri; process.env.NODE_ENV = 'production'; assert.equal(yandexConfig(), null)
    } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] }) }
  })
  it('uses authorization code, unpredictable state and S256 PKCE without the client secret in the URL', () => {
    const url = new URL(yandexAuthorizationUrl(config, 'one-use-state', 'verifier'))
    assert.equal(url.origin, 'https://oauth.yandex.ru'); assert.equal(url.searchParams.get('response_type'), 'code')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update('verifier').digest('base64url'))
    assert.equal(url.searchParams.get('optional_scope'), 'login:avatar')
    assert.equal(url.searchParams.has('force_confirm'), false)
    assert.equal(new URL(yandexAuthorizationUrl(config, 'state', 'verifier', true)).searchParams.get('force_confirm'), 'yes')
    assert.ok(!url.href.includes(config.clientSecret)); assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri)
  })
  it('normalizes profile fields and validates the provider application', () => {
    assert.deepEqual(parseYandexProfile({ id: '123', client_id: config.clientId, default_email: ' NAME@EXAMPLE.TEST ', first_name: ' Ярослав ', last_name: 'Биленко', default_avatar_id: 'one/two', is_avatar_empty: false }, config.clientId), { subject: '123', email: 'name@example.test', firstName: 'Ярослав', lastName: 'Биленко', avatarId: 'one/two' })
    assert.throws(() => parseYandexProfile({ id: '123', client_id: 'wrong-client' }, config.clientId))
    const invalid = parseYandexProfile({ id: '123', first_name: '<script>x</script>', default_email: 'bad', default_avatar_id: '../../evil?url=http://localhost' }, config.clientId)
    assert.equal(invalid.firstName, null); assert.equal(invalid.email, null); assert.equal(invalid.avatarId, null)
  })
  it('keeps credentials in server requests, refuses redirects and sanitizes provider errors', async () => {
    let calls = 0
    const fetcher: typeof fetch = async (input, init) => {
      calls++
      assert.equal(init?.redirect, 'error'); assert.ok(init?.signal)
      if (calls === 1) {
        assert.equal(input, 'https://oauth.yandex.ru/token'); assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`)
        assert.equal(new URLSearchParams(init?.body as URLSearchParams).get('code_verifier'), 'verifier')
        return Response.json({ access_token: 'test-private-provider-token' })
      }
      assert.equal(input, 'https://login.yandex.ru/info?format=json'); assert.equal(new Headers(init?.headers).get('Authorization'), 'OAuth test-private-provider-token')
      return Response.json({ id: '123', default_email: 'name@example.test' })
    }
    assert.equal((await exchangeYandexCode(config, 'code', 'verifier', fetcher)).subject, '123')
    await assert.rejects(exchangeYandexCode(config, 'code', 'verifier', async () => { throw new Error('private-token-and-secret') }), error => error instanceof ApiError && !error.message.includes('private-token-and-secret'))
    await assert.rejects(exchangeYandexCode(config, 'code', 'verifier', async () => new Response('x'.repeat(40_000))))
    let requested = false
    await assert.rejects(yandexAvatar('../../localhost', async () => { requested = true; return new Response() })); assert.equal(requested, false)
  })
})

describe('Yandex ID authentication and account ownership', () => {
  before(async () => {
    passwordHash = await hash(password)
    image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#abcdef' } }).png().toBuffer()
    const app = express(); app.use(express.json()); app.use(cookieParser())
    app.use('/api/auth/yandex', createYandexRouter({ createSession, requireAuth, verifyPassword: verifyLoginPassword, config: () => config, exchange: async (_settings, code, verifier) => { exchangeCalls++; assert.equal(verifier.length, 43); const value = profiles.get(code); if (!value) throw new ApiError(502, 'YANDEX_UNAVAILABLE', 'Яндекс недоступен.'); return value }, avatar: async id => { if (id === 'broken-avatar') throw new Error('optional image failure'); return image } }))
    app.use('/api/auth', authRouter); app.use('/api', profileRouter)
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => { response.status(error instanceof ApiError ? error.status : 500).json({ code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR', message: error instanceof ApiError ? error.message : 'Internal error' }) })
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`
  })
  after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    const users = await prisma.user.findMany({ where: { email: { endsWith: `${suffix}@example.test` } }, select: { id: true } })
    for (const user of users) await removeUserAvatar(user.id)
    await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } })
    await prisma.oAuthAttempt.deleteMany({ where: { id: { in: [...attemptIds] } } })
    await prisma.$disconnect()
  })
  it('binds a short-lived handshake to an HttpOnly cookie and rejects state substitution and a different browser', async () => {
    const browser = new Browser(), flow = await browser.start(profile('binding'), 'https://evil.test')
    const cookie = flow.response.headers.getSetCookie().find(value => value.startsWith('staffly_yandex='))!
    assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i); assert.match(cookie, /Path=\/api\/auth(?:;|$)/i)
    const record = await prisma.oAuthAttempt.findUniqueOrThrow({ where: { id: flow.id } }); assert.equal(record.returnTo, '/app'); assert.equal(record.stateHash, hashValue(flow.state)); assert.notEqual(record.browserHash, browser.cookies.get('staffly_yandex'))
    const before = exchangeCalls
    const wrongState = await browser.callback(flow, `state=${'a'.repeat(43)}&code=${flow.code}`); assert.match(wrongState.headers.get('location')!, /yandex=expired/)
    const otherBrowser = new Browser(); const wrongBrowser = await otherBrowser.callback(flow); assert.match(wrongBrowser.headers.get('location')!, /yandex=expired/); assert.equal(exchangeCalls, before)
    const good = await browser.callback(flow); assert.equal(good.headers.get('location'), '/auth/yandex')
    assert.match((await browser.callback(flow)).headers.get('location')!, /yandex=expired/)
    assert.equal((await browser.request('/api/auth/yandex/pending')).status, 200)
  })
  it('consumes cancellation and expiry without exchanging a token', async () => {
    const browser = new Browser(), flow = await browser.start(profile('cancel')), before = exchangeCalls
    const response = await browser.callback(flow, `state=${flow.state}&error=access_denied&error_description=private-token`)
    assert.match(response.headers.get('location')!, /yandex=cancelled/); assert.ok(!response.headers.get('location')!.includes('private-token')); assert.equal(exchangeCalls, before)
    const expiredFlow = await browser.start(profile('expired')); await prisma.oAuthAttempt.update({ where: { id: expiredFlow.id }, data: { expiresAt: new Date(0) } })
    assert.match((await browser.callback(expiredFlow)).headers.get('location')!, /yandex=expired/); assert.equal(exchangeCalls, before)
  })
  it('accepts only one parallel callback without destroying its pending registration', async () => {
    const browser = new Browser(), flow = await browser.start(profile('parallel-callback'))
    const responses = await Promise.all([browser.callback(flow), browser.callback(flow)])
    assert.equal(responses.filter(response => response.headers.get('location') === '/auth/yandex').length, 1)
    assert.equal((await browser.request('/api/auth/yandex/pending')).status, 200)
  })
  it('requires consents and creates one passwordless account with a local avatar and standard notification defaults', async () => {
    const browser = new Browser(), identity = profile('registration'), flow = await browser.start(identity, '/app?invite=test-invitation')
    assert.equal((await browser.callback(flow)).headers.get('location'), '/auth/yandex')
    const pending = await (await browser.request('/api/auth/yandex/pending')).json(); assert.equal(pending.mode, 'register'); assert.equal(pending.email, identity.email)
    assert.equal((await browser.complete({})).response.status, 400)
    const { response, data } = await browser.complete(); assert.equal(response.status, 200); assert.equal(data.returnTo, '/app?invite=test-invitation')
    assert.equal(data.user.displayName, 'Биленко Ярослав'); assert.equal(data.user.firstName, 'Ярослав'); assert.match(data.user.avatarUrl, /^\/api\/media\//)
    for (const key of ['passwordHash', 'subject', 'clientSecret', 'codeVerifier', 'identities']) assert.ok(!(key in data.user))
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: data.user.id }, include: { identities: true } }); assert.equal(stored.passwordHash, null); assert.ok(stored.emailVerifiedAt && stored.dataConsentAt && stored.termsAcceptedAt); assert.equal(stored.identities.length, 1)
    const categories = stored.emailNotificationCategories as Record<string, boolean>; assert.equal(categories.shiftChanges, true); assert.equal(categories.documents, true); assert.equal(categories.actionDigest, undefined)
    assert.equal(await prisma.organizationMember.count({ where: { userId: stored.id } }), 0)
    assert.equal((await browser.complete()).response.status, 400)
    const refreshed = await (await browser.request('/api/auth/refresh', {})).json(); browser.token = refreshed.accessToken; assert.equal(refreshed.user.avatarUrl, data.user.avatarUrl); assert.equal(refreshed.user.displayName, data.user.displayName)
    const me = await (await browser.request('/api/auth/me')).json(), ownProfile = await (await browser.request('/api/profile')).json(); assert.equal(me.user.displayName, data.user.displayName); assert.equal(ownProfile.user.avatarUrl, data.user.avatarUrl)
    assert.equal((await browser.request('/api/auth/login', { email: identity.email, password: 'staffly-dummy-password-for-timing' })).status, 401)
    assert.equal((await browser.request('/api/auth/change-password', { currentPassword: password, newPassword: 'OtherStaffly-42!' })).status, 409)
  })
  it('preserves locally edited names, avatar and contact email on repeated Yandex login', async () => {
    const identity = profile('repeat'), first = new Browser(), flow = await first.start(identity); await first.callback(flow); const result = await first.complete(); const id = result.data.user.id, avatarUrl = result.data.user.avatarUrl
    await prisma.user.update({ where: { id }, data: { firstName: 'Мария', lastName: 'Своя' } })
    const second = new Browser(), nextFlow = await second.start({ ...identity, firstName: 'Changed', email: email('provider-new-email'), avatarId: null }, '/app/settings?section=profile')
    const response = await second.callback(nextFlow); assert.equal(response.headers.get('location'), '/app/settings?section=profile')
    const session = await (await second.request('/api/auth/refresh', {})).json(); assert.equal(session.user.id, id); assert.equal(session.user.displayName, 'Своя Мария'); assert.equal(session.user.email, identity.email); assert.equal(session.user.avatarUrl, avatarUrl)
    assert.equal(await prisma.user.count({ where: { email: email('provider-new-email') } }), 0)
  })
  it('requires the existing Staffly password instead of merging equal emails automatically', async () => {
    const existing = await localUser('collision'), browser = new Browser(), flow = await browser.start(profile('collision'))
    await browser.callback(flow); assert.equal((await (await browser.request('/api/auth/yandex/pending')).json()).mode, 'connect')
    assert.equal((await browser.complete({ consentData: true, consentTerms: true })).response.status, 401)
    assert.equal(await prisma.authIdentity.count({ where: { userId: existing.id } }), 0)
    assert.equal((await browser.complete({ currentPassword: 'wrong' })).response.status, 401)
    const result = await browser.complete({ currentPassword: password }); assert.equal(result.response.status, 200); assert.equal(result.data.user.id, existing.id); assert.equal(result.data.user.displayName, 'Имя Свое'); assert.equal(result.data.user.avatarUrl, null)
    assert.equal(await prisma.user.count({ where: { email: existing.email } }), 1)
  })
  it('does not attach an unverified or deleted account and locks repeated password failures', async () => {
    for (const kind of ['unverified', 'deleted']) {
      const existing = await localUser(kind, kind === 'unverified' ? { emailVerifiedAt: null } : { deletedAt: new Date() }), browser = new Browser(), flow = await browser.start(profile(kind)); await browser.callback(flow)
      assert.equal((await browser.complete({ currentPassword: password })).response.status, 401); assert.equal(await prisma.authIdentity.count({ where: { userId: existing.id } }), 0)
    }
    await localUser('attempts'); const browser = new Browser(), flow = await browser.start(profile('attempts')); await browser.callback(flow)
    for (let i = 0; i < 5; i++) assert.equal((await browser.complete({ currentPassword: 'wrong' })).response.status, 401)
    assert.equal((await browser.complete({ currentPassword: password })).response.status, 400)
  })
  it('allows explicit linking from settings while requiring the original live session', async () => {
    const existing = await localUser('settings-link'), browser = new Browser(); await browser.login(existing.email)
    const flow = await browser.start(profile('different-provider-email'), '/app', true)
    assert.equal((await browser.callback(flow)).headers.get('location'), '/app/settings?section=security&yandex=linked')
    const methods = await (await browser.request('/api/auth/yandex/methods')).json(); assert.equal(methods.hasPassword, true); assert.equal(methods.yandex.connected, true)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: existing.id } })).email, existing.email)
    const other = await localUser('revoked'), revoked = new Browser(); await revoked.login(other.email)
    const revokedFlow = await revoked.start(profile('revoked-provider'), '/app', true); await revoked.request('/api/auth/logout', {})
    assert.match((await revoked.callback(revokedFlow)).headers.get('location')!, /yandex=expired/); assert.equal(await prisma.authIdentity.count({ where: { userId: other.id } }), 0)
  })
  it('prevents linking another users identity and replacing an existing Yandex identity', async () => {
    const one = await localUser('identity-one'), two = await localUser('identity-two'), identity = profile('identity-one-provider'), a = new Browser(), b = new Browser()
    await a.login(one.email); await a.callback(await a.start(identity, '/app', true))
    await b.login(two.email); assert.match((await b.callback(await b.start(identity, '/app', true))).headers.get('location')!, /yandex=already-linked/)
    assert.match((await a.callback(await a.start(profile('replacement'), '/app', true))).headers.get('location')!, /yandex=already-linked/)
    assert.equal(await prisma.authIdentity.count({ where: { userId: one.id } }), 1); assert.equal(await prisma.authIdentity.count({ where: { userId: two.id } }), 0)
  })
  it('allows email recovery for Yandex-only accounts while direct setup still requires a fresh Yandex proof', async () => {
    const identity = profile('password-create'), browser = new Browser(); await browser.callback(await browser.start(identity)); const registered = await browser.complete(), userId = registered.data.user.id
    assert.equal((await browser.request('/api/auth/yandex/unlink', { currentPassword: password })).status, 409)
    assert.equal((await browser.request('/api/auth/forgot-password', { email: identity.email })).status, 202)
    assert.equal(await prisma.passwordResetToken.count({ where: { userId } }), 1)
    assert.equal((await browser.request('/api/auth/yandex/password/complete', { password, confirmPassword: password })).status, 400)
    const response = await browser.request('/api/auth/yandex/password/start', {}), url = new URL((await response.json()).authorizationUrl), oauthCode = randomUUID()
    profiles.set(oauthCode, identity); attemptIds.add(browser.cookies.get('staffly_yandex')!.split('.')[0])
    const callback = await browser.request(`/api/auth/yandex/callback?code=${oauthCode}&state=${url.searchParams.get('state')}`)
    assert.match(callback.headers.get('location')!, /yandex=password-ready/)
    assert.equal((await browser.request('/api/auth/yandex/password/complete', { password, confirmPassword: password })).status, 200)
    assert.equal((await browser.request('/api/auth/yandex/password/complete', { password, confirmPassword: password })).status, 409)
    assert.equal((await browser.request('/api/auth/me')).status, 200)
    await browser.login(identity.email!); assert.equal((await browser.request('/api/auth/yandex/unlink', { currentPassword: 'wrong' })).status, 401)
    assert.equal((await browser.request('/api/auth/yandex/unlink', { currentPassword: password })).status, 200)
    assert.equal(await prisma.authIdentity.count({ where: { userId } }), 0); assert.equal((await browser.request('/api/auth/me')).status, 200)
  })
  it('rejects missing provider email for a new identity and survives an optional avatar failure', async () => {
    const browser = new Browser(), flow = await browser.start(profile('missing-email', { email: null }))
    assert.match((await browser.callback(flow)).headers.get('location')!, /yandex=email-required/)
    const noAvatar = profile('no-avatar', { avatarId: 'broken-avatar' }); await browser.callback(await browser.start(noAvatar)); const result = await browser.complete(); assert.equal(result.response.status, 200); assert.equal(result.data.user.avatarUrl, null)
  })
  it('consumes concurrent registration only once', async () => {
    const browser = new Browser(), identity = profile('concurrent'); assert.equal((await browser.callback(await browser.start(identity))).headers.get('location'), '/auth/yandex')
    const results = await Promise.all([browser.complete(), browser.complete()])
    assert.equal(results.filter(result => result.response.ok).length, 1, JSON.stringify(results.map(result => ({status: result.response.status, code: result.data.code, message: result.data.message}))))
    assert.equal(await prisma.user.count({ where: { email: identity.email! } }), 1); assert.equal(await prisma.authIdentity.count({ where: { subject: identity.subject } }), 1)
  })
})
