import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Router, type Request, type Response, type RequestHandler } from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import type { AuthenticatedRequest } from '../auth.ts'
import type { User, OAuthAttempt } from '../../generated/prisma/client.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { startBackgroundTask } from '../background-task.ts'
import { replaceUserAvatar } from '../storage/image-service.ts'
import { queueAccountSecurityEvent } from '../mail/email-outbox.ts'
import { lockAccount, invalidateSecurityChallenges, revokeOtherSessions, securityChanged } from './account-security.ts'
import { passwordSchema, passwordHash } from './passwords.ts'
import { clearPasswordAttempts } from './attempt-limits.ts'
import { safeReturnTo } from '../../app/auth/return-to.ts'
import { exchangeYandexCode, yandexAuthorizationUrl, yandexAvatar, yandexConfig, type YandexConfig, type YandexProfile } from './yandex-provider.ts'

const cookieName = 'staffly_yandex'
const cookiePath = '/api/auth'
const lifetime = 10 * 60_000
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')
const random = () => randomBytes(32).toString('base64url')
const startBody = z.object({ returnTo: z.string().max(2048).optional() }).strict()
const linkBody = startBody.extend({ currentPassword: z.string().min(1).max(256) }).strict()
const passwordBody = z.object({ password: passwordSchema, confirmPassword: z.string() }).strict().refine(value => value.password === value.confirmPassword, { path: ['confirmPassword'], message: 'Пароли не совпадают.' })
type Purpose = 'LOGIN' | 'LINK' | 'PASSWORD_SETUP' | 'EMAIL_CHANGE'
const completeBody = z.object({ currentPassword: z.string().max(256).optional(), consentData: z.boolean().optional(), consentTerms: z.boolean().optional() }).strict()
const profileBody = z.object({ subject: z.string().min(1).max(128), email: z.string().email().max(254).nullable(), firstName: z.string().max(80).nullable(), lastName: z.string().max(80).nullable(), avatarId: z.string().max(200).nullable() })
const expired = () => new ApiError(400, 'YANDEX_EXPIRED', 'Вход через Яндекс истёк. Начните ещё раз.')
const conflict = () => new ApiError(409, 'YANDEX_ALREADY_LINKED', 'Этот аккаунт Яндекса уже подключён или у вас подключён другой аккаунт Яндекса.')
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: cookiePath })
function clearCookie(response: Response) {
  response.clearCookie(cookieName, cookieOptions())
  response.clearCookie(cookieName, { ...cookieOptions(), path: '/api/auth/yandex' })
}

function browserAttempt(request: Request) {
  const match = typeof request.cookies?.[cookieName] === 'string' ? /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(request.cookies[cookieName]) : null
  return match && z.string().uuid().safeParse(match[1]).success ? { id: match[1], browserHash: fingerprint(match[2]) } : null
}
async function pending(request: Request) {
  const browser = browserAttempt(request)
  if (!browser) throw expired()
  const record = await prisma.oAuthAttempt.findFirst({ where: { ...browser, purpose: 'LOGIN', userId: null, stage: 'PENDING', expiresAt: { gt: new Date() }, attempts: { lt: 5 } } })
  if (!record) throw expired()
  return record
}

export async function requireYandexProof(tx: Prisma.TransactionClient, request: AuthenticatedRequest, purpose: 'PASSWORD_SETUP' | 'EMAIL_CHANGE', user: Pick<User, 'id' | 'securityVersion'>) {
  const browser = browserAttempt(request)
  if (!browser || !request.auth || request.auth.userId !== user.id) throw expired()
  const record = await tx.oAuthAttempt.findFirst({ where: { ...browser, purpose, stage: 'REAUTH_READY', userId: user.id, sessionId: request.auth.sessionId, securityVersion: user.securityVersion, expiresAt: { gt: new Date() } } })
  if (!record) throw expired()
  await assertLinkSession(record, request, tx)
  const profile = profileBody.parse(record.profile)
  if (!await tx.authIdentity.findFirst({ where: { userId: user.id, provider: 'yandex', subject: profile.subject } })) throw expired()
  return record
}

async function assertLinkSession(record: OAuthAttempt, request: Request, db: Pick<Prisma.TransactionClient, 'authSession'> = prisma) {
  const rawToken = request.cookies?.staffly_refresh
  if (!record.userId || !record.sessionId || typeof rawToken !== 'string' || rawToken.length > 256) throw expired()
  const now = new Date()
  const session = await db.authSession.findFirst({ where: { id: record.sessionId, userId: record.userId, refreshTokenHash: fingerprint(rawToken), revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, user: { deletedAt: null, emailVerifiedAt: { not: null } } } })
  if (!session) throw expired()
}

async function attachIdentity(userId: string, profile: YandexProfile, record: OAuthAttempt, request: Request) {
  try {
    await prisma.$transaction(async tx => {
      await lockAccount(tx, { userId, sessionId: record.sessionId! })
      await assertLinkSession(record, request, tx)
      const user = await tx.user.findUnique({ where: { id: userId } })
      if (!user || user.deletedAt || !user.emailVerifiedAt) throw expired()
      if (record.purpose !== 'LINK' || record.securityVersion !== user.securityVersion || !user.passwordHash) throw securityChanged()
      const identity = await tx.authIdentity.findUnique({ where: { provider_subject: { provider: 'yandex', subject: profile.subject } } })
      if (identity?.userId === userId) return
      if (identity || await tx.authIdentity.findUnique({ where: { userId_provider: { userId, provider: 'yandex' } } })) throw conflict()
      await tx.authIdentity.create({ data: { userId, provider: 'yandex', subject: profile.subject, email: profile.email ?? user.email } })
      await tx.user.update({ where: { id: userId }, data: { securityVersion: { increment: 1 } } })
      await invalidateSecurityChallenges(tx, userId)
      await revokeOtherSessions(tx, userId, record.sessionId!)
      await queueAccountSecurityEvent(tx, userId, 'YANDEX_LINKED')
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw conflict()
    throw error
  }
}

type Dependencies = {
  createSession: (user: User, request: Request, response: Response) => Promise<unknown>
  requireAuth: RequestHandler
  verifyPassword: (hash: string | null, password: string, account?: string) => Promise<boolean>
  config?: () => YandexConfig | null
  exchange?: typeof exchangeYandexCode
  avatar?: (avatarId: string) => Promise<Buffer>
}

export function createYandexRouter(dependencies: Dependencies) {
  const router = Router()
  const config = dependencies.config ?? yandexConfig
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Слишком много попыток входа через Яндекс. Попробуйте позже.' } })
  const callbackLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Слишком много попыток входа через Яндекс. Попробуйте позже.' } })
  const credentialLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: request => (request as AuthenticatedRequest).auth?.userId ?? browserAttempt(request)?.browserHash ?? ipKeyGenerator(request.ip || '127.0.0.1'), message: { message: 'Слишком много попыток подтверждения. Попробуйте позже.' } })
  router.use((_request, response, next) => { response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next() })
  router.get('/status', (_request, response) => { response.json({ enabled: Boolean(config()) }) })

  async function start(request: AuthenticatedRequest, response: Response, purpose: Purpose) {
    const settings = config()
    if (!settings) throw new ApiError(503, 'YANDEX_DISABLED', 'Вход через Яндекс пока недоступен.')
    const input = purpose === 'LINK' ? linkBody.parse(request.body) : startBody.parse(request.body)
    const account = purpose !== 'LOGIN' ? await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId } }) : null
    if (account) {
      if (purpose === 'LINK') {
        if (!await dependencies.verifyPassword(account.passwordHash, 'currentPassword' in input && typeof input.currentPassword === 'string' ? input.currentPassword : '', account.email)) throw new ApiError(401, 'INVALID_PASSWORD', 'Текущий пароль Staffly указан неверно.')
      } else {
        if (account.passwordHash) throw new ApiError(409, 'PASSWORD_ALREADY_SET', 'Для этого действия подтвердите текущий пароль Staffly.')
        if (!await prisma.authIdentity.findUnique({ where: { userId_provider: { userId: account.id, provider: 'yandex' } } })) throw expired()
      }
    }
    const old = browserAttempt(request)
    if (old) await prisma.oAuthAttempt.deleteMany({ where: old })
    const state = random(), verifier = random(), browserToken = random()
    const data = { stateHash: fingerprint(state), browserHash: fingerprint(browserToken), codeVerifier: verifier, purpose, returnTo: account && purpose !== 'PASSWORD_SETUP' ? '/app/settings?section=security' : safeReturnTo(input.returnTo, account ? '/app/settings?section=security' : '/app'), ...(account ? { userId: account.id, sessionId: request.auth!.sessionId, securityVersion: account.securityVersion } : {}), expiresAt: new Date(Date.now() + lifetime) }
    const record = account ? await prisma.$transaction(async tx => {
      const current = await lockAccount(tx, request.auth!)
      if (current.securityVersion !== account.securityVersion || current.passwordHash !== account.passwordHash) throw securityChanged()
      return tx.oAuthAttempt.create({ data })
    }) : await prisma.oAuthAttempt.create({ data })
    clearCookie(response)
    response.cookie(cookieName, `${record.id}.${browserToken}`, { ...cookieOptions(), maxAge: lifetime })
    response.json({ authorizationUrl: yandexAuthorizationUrl(settings, state, verifier, purpose !== 'LOGIN') })
  }
  router.post('/start', limiter, (request, response) => start(request, response, 'LOGIN'))
  router.post('/link', dependencies.requireAuth, credentialLimiter, limiter, (request, response) => start(request, response, 'LINK'))
  router.post('/password/start', dependencies.requireAuth, limiter, (request, response) => start(request, response, 'PASSWORD_SETUP'))
  router.post('/email/start', dependencies.requireAuth, limiter, (request, response) => start(request, response, 'EMAIL_CHANGE'))

  router.get('/callback', callbackLimiter, async (request, response) => {
    let record: OAuthAttempt | null = null
    let ownsAttempt = false
    try {
      const settings = config(), browser = browserAttempt(request)
      const state = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(request.query.state)
      if (!settings || !browser) throw expired()
      record = await prisma.oAuthAttempt.findFirst({ where: { ...browser, stateHash: fingerprint(state), stage: 'STARTED', expiresAt: { gt: new Date() } } })
      if (!record?.codeVerifier) throw expired()
      const claimed = await prisma.oAuthAttempt.updateMany({ where: { id: record.id, stage: 'STARTED', expiresAt: { gt: new Date() } }, data: { stage: 'EXCHANGING', codeVerifier: null } })
      if (!claimed.count) throw expired()
      ownsAttempt = true
      if (request.query.error) throw new ApiError(400, 'YANDEX_CANCELLED', 'Вход отменён.')
      const code = z.string().min(1).max(2048).parse(request.query.code)
      const profile = await (dependencies.exchange ?? exchangeYandexCode)(settings, code, record.codeVerifier)
      if (record.userId) {
        await assertLinkSession(record, request)
        if (record.purpose === 'LINK') {
          await attachIdentity(record.userId, profile, record, request)
          await prisma.oAuthAttempt.deleteMany({ where: { id: record.id } })
          clearCookie(response)
          response.redirect(303, '/app/settings?section=security&yandex=linked')
        } else if (record.purpose === 'PASSWORD_SETUP' || record.purpose === 'EMAIL_CHANGE') {
          await prisma.$transaction(async tx => {
            const user = await lockAccount(tx, { userId: record!.userId!, sessionId: record!.sessionId! })
            await assertLinkSession(record!, request, tx)
            if (user.securityVersion !== record!.securityVersion || user.passwordHash) throw securityChanged()
            if (!await tx.authIdentity.findFirst({ where: { userId: user.id, provider: 'yandex', subject: profile.subject } })) throw new ApiError(403, 'YANDEX_WRONG_ACCOUNT', 'Подтвердите вход через тот аккаунт Яндекса, который уже подключён к Staffly.')
            await tx.oAuthAttempt.update({ where: { id: record!.id }, data: { stage: 'REAUTH_READY', profile, expiresAt: new Date(Date.now() + 5 * 60_000) } })
          })
          response.cookie(cookieName, request.cookies[cookieName], { ...cookieOptions(), maxAge: 5 * 60_000 })
          response.redirect(303, `/app/settings?section=security&yandex=${record.purpose === 'PASSWORD_SETUP' ? 'password-ready' : 'email-ready'}${record.purpose === 'PASSWORD_SETUP' && record.returnTo !== '/app/settings?section=security' ? `&returnTo=${encodeURIComponent(safeReturnTo(record.returnTo))}` : ''}`)
        } else throw expired()
        return
      }
      if (record.purpose !== 'LOGIN') throw expired()
      const identity = await prisma.authIdentity.findUnique({ where: { provider_subject: { provider: 'yandex', subject: profile.subject } }, include: { user: true } })
      if (identity) {
        if (identity.user.deletedAt || !identity.user.emailVerifiedAt) throw new ApiError(403, 'YANDEX_ACCOUNT_UNAVAILABLE', 'Аккаунт недоступен.')
        await prisma.authIdentity.update({ where: { id: identity.id }, data: { lastLoginAt: new Date() } })
        await dependencies.createSession(identity.user, request, response)
        await prisma.oAuthAttempt.delete({ where: { id: record.id } })
        clearCookie(response)
        response.redirect(303, safeReturnTo(record.returnTo))
        return
      }
      if (!profile.email) throw new ApiError(400, 'YANDEX_EMAIL_REQUIRED', 'Яндекс не передал почту.')
      await prisma.oAuthAttempt.update({ where: { id: record.id }, data: { stage: 'PENDING', profile, expiresAt: new Date(Date.now() + lifetime) } })
      response.cookie(cookieName, request.cookies[cookieName], { ...cookieOptions(), maxAge: lifetime })
      response.redirect(303, '/auth/yandex')
    } catch (error) {
      if (record && ownsAttempt) { await prisma.oAuthAttempt.deleteMany({ where: { id: record.id } }).catch(() => undefined); clearCookie(response) }
      const code = error instanceof ApiError ? error.code : 'YANDEX_FAILED'
      const marker = code === 'YANDEX_CANCELLED' ? 'cancelled' : code === 'YANDEX_ALREADY_LINKED' ? 'already-linked' : code === 'YANDEX_EMAIL_REQUIRED' ? 'email-required' : code === 'YANDEX_ACCOUNT_UNAVAILABLE' ? 'account-unavailable' : code === 'YANDEX_WRONG_ACCOUNT' ? 'wrong-account' : code === 'SECURITY_CHANGED' ? 'security-changed' : code === 'YANDEX_EXPIRED' ? 'expired' : 'failed'
      const target = record?.userId ? new URL('/app/settings?section=security', 'https://staffly.invalid') : new URL('/auth', 'https://staffly.invalid')
      target.searchParams.set('yandex', marker)
      if (!record?.userId && record?.returnTo) target.searchParams.set('returnTo', safeReturnTo(record.returnTo))
      response.redirect(303, target.pathname + target.search)
    }
  })

  router.get('/pending', async (request, response) => {
    const record = await pending(request), profile = profileBody.parse(record.profile)
    const existing = await prisma.user.findUnique({ where: { email: profile.email! } })
    response.json({ mode: existing ? 'connect' : 'register', email: profile.email, firstName: profile.firstName, lastName: profile.lastName, canConfirmPassword: Boolean(existing?.passwordHash && existing.emailVerifiedAt && !existing.deletedAt), returnTo: safeReturnTo(record.returnTo) })
  })
  router.post('/cancel', async (request, response) => {
    const browser = browserAttempt(request)
    if (browser) await prisma.oAuthAttempt.deleteMany({ where: browser })
    clearCookie(response)
    response.status(204).end()
  })

  router.post('/complete', credentialLimiter, async (request, response) => {
    const input = completeBody.parse(request.body), record = await pending(request), profile = profileBody.parse(record.profile)
    if (!profile.email) throw expired()
    const existing = await prisma.user.findUnique({ where: { email: profile.email } })
    if (existing) {
      const valid = await dependencies.verifyPassword(existing.passwordHash, input.currentPassword ?? '', existing.email)
      if (!valid || !existing.passwordHash || !existing.emailVerifiedAt || existing.deletedAt) {
        await prisma.oAuthAttempt.updateMany({ where: { id: record.id }, data: { attempts: { increment: 1 } } })
        throw new ApiError(401, 'YANDEX_CONFIRM_ACCOUNT', 'Не удалось подтвердить аккаунт. Проверьте пароль Staffly или войдите обычным способом и подключите Яндекс в настройках.')
      }
    } else if (!input.consentData || !input.consentTerms) throw new ApiError(400, 'CONSENT_REQUIRED', 'Подтвердите согласие на обработку данных и ознакомление с соглашением.')
    let result: { user: User; created: boolean }
    try {
      result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM oauth_attempts WHERE id = ${record.id}::uuid FOR UPDATE`
        const current = await tx.oAuthAttempt.findFirst({ where: { id: record.id, browserHash: record.browserHash, purpose: 'LOGIN', userId: null, stage: 'PENDING', expiresAt: { gt: new Date() }, attempts: { lt: 5 } } })
        if (!current) throw expired()
        if (existing) await tx.$queryRaw`SELECT id FROM users WHERE id = ${existing.id}::uuid FOR UPDATE`
        const account = await tx.user.findUnique({ where: { email: profile.email! } })
        if (account && (!existing || account.id !== existing.id || account.passwordHash !== existing.passwordHash || account.securityVersion !== existing.securityVersion || !account.emailVerifiedAt || account.deletedAt)) throw new ApiError(409, 'YANDEX_ACCOUNT_CHANGED', 'Данные аккаунта изменились. Начните вход ещё раз.')
        if (!account && existing) throw expired()
        if (await tx.authIdentity.findUnique({ where: { provider_subject: { provider: 'yandex', subject: profile.subject } } }) || account && await tx.authIdentity.findUnique({ where: { userId_provider: { userId: account.id, provider: 'yandex' } } })) throw conflict()
        const now = new Date()
        const user = account ? await tx.user.update({ where: { id: account.id }, data: { securityVersion: { increment: 1 } } }) : await tx.user.create({ data: { email: profile.email!, firstName: profile.firstName, lastName: profile.lastName, emailVerifiedAt: now, termsAcceptedAt: now, dataConsentAt: now } })
        await tx.authIdentity.create({ data: { userId: user.id, provider: 'yandex', subject: profile.subject, email: profile.email! } })
        await tx.oAuthAttempt.delete({ where: { id: record.id } })
        if (account) { await invalidateSecurityChallenges(tx, user.id); await revokeOtherSessions(tx, user.id) }
        await queueAccountSecurityEvent(tx, user.id, 'YANDEX_LINKED')
        return { user, created: !account }
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw conflict()
      throw error
    }
    if (result.created && profile.avatarId) {
      try { await replaceUserAvatar(result.user.id, await (dependencies.avatar ?? yandexAvatar)(profile.avatarId)) }
      catch { /* An optional avatar must never prevent sign-in. Upload remains available in settings. */ }
      result.user = await prisma.user.findUniqueOrThrow({ where: { id: result.user.id } })
    }
    clearCookie(response)
    const session = await dependencies.createSession(result.user, request, response)
    response.json({ ...(session as object), returnTo: safeReturnTo(record.returnTo) })
  })

  router.get('/methods', dependencies.requireAuth, async (request: AuthenticatedRequest, response) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId }, include: { identities: { where: { provider: 'yandex' }, select: { email: true } } } })
    let passwordSetupReady = false, emailChangeReady = false
    if (!user.passwordHash) for (const purpose of ['PASSWORD_SETUP', 'EMAIL_CHANGE'] as const) {
      try { await requireYandexProof(prisma, request, purpose, user); if (purpose === 'PASSWORD_SETUP') passwordSetupReady = true; else emailChangeReady = true }
      catch (error) { if (!(error instanceof ApiError)) throw error }
    }
    response.json({ hasPassword: Boolean(user.passwordHash), passwordSetupReady, emailChangeReady, yandex: { enabled: Boolean(config()), connected: Boolean(user.identities.length), email: user.identities[0]?.email ?? null } })
  })

  router.post('/password/complete', dependencies.requireAuth, credentialLimiter, async (request: AuthenticatedRequest, response) => {
    const input = passwordBody.parse(request.body)
    const nextHash = await passwordHash(input.password)
    await prisma.$transaction(async tx => {
      const user = await lockAccount(tx, request.auth!)
      if (user.passwordHash) throw new ApiError(409, 'PASSWORD_ALREADY_SET', 'Пароль уже создан. Используйте изменение пароля.')
      await requireYandexProof(tx, request, 'PASSWORD_SETUP', user)
      await clearPasswordAttempts(tx, user.email)
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: nextHash, securityVersion: { increment: 1 } } })
      await invalidateSecurityChallenges(tx, user.id)
      await revokeOtherSessions(tx, user.id, request.auth!.sessionId)
      await queueAccountSecurityEvent(tx, user.id, 'PASSWORD_CREATED')
    }, { isolationLevel: 'Serializable' })
    clearCookie(response)
    response.json({ message: 'Пароль создан. Теперь можно входить по почте и паролю или через Яндекс.' })
  })
  router.post('/unlink', dependencies.requireAuth, credentialLimiter, async (request: AuthenticatedRequest, response) => {
    const password = z.object({ currentPassword: z.string().min(1).max(256) }).strict().parse(request.body)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId } })
    if (!user.passwordHash) throw new ApiError(409, 'LAST_LOGIN_METHOD', 'Сначала создайте пароль, чтобы сохранить доступ к аккаунту.')
    if (!await dependencies.verifyPassword(user.passwordHash, password.currentPassword, user.email)) throw new ApiError(401, 'INVALID_PASSWORD', 'Текущий пароль указан неверно.')
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
      const samePassword = current.passwordHash && Buffer.byteLength(current.passwordHash) === Buffer.byteLength(user.passwordHash!) && timingSafeEqual(Buffer.from(current.passwordHash), Buffer.from(user.passwordHash!))
      if (!samePassword || current.deletedAt || current.securityVersion !== user.securityVersion) throw securityChanged()
      await lockAccount(tx, request.auth!)
      const removed = await tx.authIdentity.deleteMany({ where: { userId: user.id, provider: 'yandex' } })
      if (!removed.count) return
      await tx.user.update({ where: { id: user.id }, data: { securityVersion: { increment: 1 } } })
      await invalidateSecurityChallenges(tx, user.id)
      await revokeOtherSessions(tx, user.id, request.auth!.sessionId)
      await queueAccountSecurityEvent(tx, user.id, 'YANDEX_UNLINKED')
    }, { isolationLevel: 'Serializable' })
    response.json({ message: 'Яндекс отключён. Остальные сеансы завершены.' })
  })
  return router
}

export function startOAuthCleanup() {
  return startBackgroundTask({ name: 'OAuth cleanup', intervalMs: 10 * 60_000, run: async () => {
    await prisma.authAttemptLimit.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } } })
    await prisma.oAuthAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    await prisma.emailChangeToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  } })
}
