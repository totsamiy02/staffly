import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { Router } from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import type { User } from '../generated/prisma/client.ts'
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import { z } from 'zod'
import { prisma } from './db.ts'
import { deliverSecurityCode } from './mail/transport.ts'
import { queuePasswordChanged } from './mail/email-outbox.ts'
import { mediaUrl } from './storage/image-service.ts'
import { createYandexRouter } from './auth/yandex-routes.ts'
import { passwordSchema as password, passwordHash, verifyLoginPassword } from './auth/passwords.ts'
import { lockAccount, invalidateSecurityChallenges, revokeOtherSessions, securityChanged } from './auth/account-security.ts'
import { createEmailChangeRouter } from './auth/email-change-routes.ts'
import { clearPasswordAttempts, reserveAuthAttempt } from './auth/attempt-limits.ts'
import { accountRateLimit, PostgresRateLimitStore } from './security/rate-limit.ts'
export { verifyLoginPassword } from './auth/passwords.ts'
import { sessionTransaction } from './auth/session-transaction.ts'
import { recordTiming } from './performance.ts'
import { ApiError } from './api-error.ts'
import { rotateRefreshToken, revokeRefreshToken } from './auth/refresh-tokens.ts'
import { securityContext, bindSecuritySession, recordSecurityEvent } from './security/journal.ts'

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters')
const jwtKey = new TextEncoder().encode(jwtSecret)

const ACCESS_LIFETIME = '15m'
const IDLE_MS = 7 * 24 * 60 * 60 * 1000
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000
const CODE_MS = 10 * 60 * 1000
const EMAIL_COOLDOWN_MS = 60 * 1000
const MAX_CODE_ATTEMPTS = 5
const COOKIE_NAME = 'staffly_refresh'
const BROWSER_COOKIE_NAME = 'staffly_browser'
const COOKIE_PATH = '/api/auth'
const invalidCredentials = 'Неверная почта или пароль.'

const email = z.string().trim().toLowerCase().email().max(254)
const registerBody = z.object({ email })
const loginBody = z.object({ email, password: z.string().min(1).max(256) })
const codeBody = z.object({ email, code: z.string().regex(/^\d{6}$/) })
const resetBody = codeBody.extend({ password, confirmPassword: z.string() })
  .refine((body) => body.password === body.confirmPassword, { path: ['confirmPassword'], message: 'Пароли не совпадают' })
const verifyBody = resetBody.and(z.object({ consentData: z.literal(true), consentTerms: z.literal(true) }))
const changeBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: password })

const tooManyRequests = (_request: Request, response: Response) => response.status(429).json({ message: 'Слишком много запросов. Попробуйте позже.' })
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, store: new PostgresRateLimitStore('auth-ip', 100), standardHeaders: 'draft-8', legacyHeaders: false, handler: tooManyRequests, skip: request => request.method === 'GET' || request.path === '/refresh' })
const refreshLimiter = rateLimit({ windowMs: 60_000, limit: 120, store: new PostgresRateLimitStore('refresh-ip', 120), standardHeaders: 'draft-8', legacyHeaders: false, handler: tooManyRequests })
// Account-level password attempts remain 10/15 min across every IP and replica.
// This coarser IP budget permits a normal 20–40-person office to sign in together.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, store: new PostgresRateLimitStore('login-ip', 100), standardHeaders: 'draft-8', legacyHeaders: false, handler: tooManyRequests })
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: tooManyRequests,
  keyGenerator: (request) => `${ipKeyGenerator(request.ip || '127.0.0.1')}:${createHash('sha256').update(String(request.body?.email || '').trim().toLowerCase()).digest('hex')}`,
})

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function codeDigest(userId: string, kind: 'verification' | 'reset', code: string) {
  return createHmac('sha256', jwtKey).update(`${kind}:${userId}:${code}`).digest('hex')
}

function newCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

function newToken() {
  return randomBytes(48).toString('base64url')
}

function setRefreshCookie(response: Response, token: string) {
  response.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: ABSOLUTE_MS,
  })
}

export function clearRefreshCookie(response: Response) {
  response.clearCookie(COOKIE_NAME, { path: COOKIE_PATH, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' })
}

function publicUser(user: { id: string; publicId:number; email: string; firstName?: string | null; lastName?: string | null; middleName?: string | null; phone?: string | null; bio?: string | null; avatarFileId?: string | null }) {
  const displayName = [user.lastName, user.firstName].filter(Boolean).join(' ') || user.email.split('@')[0]
  return { id: user.id, publicId:user.publicId, email: user.email, displayName, firstName: user.firstName ?? null, lastName: user.lastName ?? null, middleName: user.middleName ?? null, phone: user.phone ?? null, bio: user.bio ?? null, avatarUrl: mediaUrl(user.avatarFileId) }
}

async function accessToken(userId: string, sessionId: string) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_LIFETIME)
    .sign(jwtKey)
}

export async function createSession(user: User, request: Request, response: Response) {
  const now = Date.now()
  const rawToken = newToken()
  const previousToken = request.cookies?.[COOKIE_NAME]
  const browserCookie = request.cookies?.[BROWSER_COOKIE_NAME]
  const browserToken = typeof browserCookie === 'string' && /^[A-Za-z0-9_-]{64}$/.test(browserCookie) ? browserCookie : newToken()
  const browserTokenHash = digest(browserToken)
  const { session, account } = await sessionTransaction(() => prisma.$transaction(async tx => {
    // Serialize continuity for one browser, then lock the account against security
    // changes. Fresh READ COMMITTED snapshots avoid unrelated SSI conflicts at login.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${browserTokenHash}, 7))::text`
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`
    const account = await tx.user.findUnique({ where: { id: user.id } })
    if (!account || account.deletedAt || !account.emailVerifiedAt || account.securityVersion !== user.securityVersion) throw securityChanged()
    const previous = typeof previousToken === 'string' && previousToken.length <= 256
      ? await tx.authSession.findUnique({ where: { refreshTokenHash: digest(previousToken) } }) : null
    const browserSession = await tx.authSession.findFirst({ where: { userId: user.id, browserTokenHash, revokedAt: null, idleExpiresAt: { gt: new Date(now) }, absoluteExpiresAt: { gt: new Date(now) } }, orderBy: { createdAt: 'desc' } })
    const current = previous?.userId === user.id && !previous.revokedAt && previous.idleExpiresAt.getTime() > now && previous.absoluteExpiresAt.getTime() > now ? previous : browserSession
    const data = { browserTokenHash, refreshTokenHash: digest(rawToken), lastUsedAt: new Date(now), idleExpiresAt: new Date(now + IDLE_MS), userAgent: request.get('user-agent')?.slice(0, 512), ipAddress: request.ip?.slice(0, 45) }
    // Authentication has already succeeded. The opaque browser cookie identifies
    // continuity even if a refresh response was lost; it is never accepted as authentication.
    await tx.authSession.updateMany({ where: { browserTokenHash, revokedAt: null, ...(current ? { id: { not: current.id } } : {}) }, data: { revokedAt: new Date(now), lastActiveAt: null } })
    if (previous && previous.id !== current?.id && !previous.revokedAt) await tx.authSession.update({ where: { id: previous.id }, data: { revokedAt: new Date(now), lastActiveAt: null } })
    const session = current ? await tx.authSession.update({ where: { id: current.id }, data: { ...data, idleExpiresAt: new Date(Math.min(now + IDLE_MS, current.absoluteExpiresAt.getTime())) } }) : await tx.authSession.create({ data: { ...data, userId: user.id, absoluteExpiresAt: new Date(now + ABSOLUTE_MS) } })
    // Password/provider authentication starts a new grant even when preserving the
    // browser's session row. An old grant cannot revoke this newly authenticated one.
    if (current) await tx.refreshTokenUse.deleteMany({ where: { sessionId: session.id } })
    await recordSecurityEvent(tx, { action: 'LOGIN', userId: account.id, sessionId: session.id, resourceType: 'SESSION', resourceId: session.id })
    return { session, account }
  }, { isolationLevel: 'ReadCommitted' }))
  setRefreshCookie(response, rawToken)
  response.cookie(BROWSER_COOKIE_NAME, browserToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: COOKIE_PATH, maxAge: 365 * 24 * 60 * 60 * 1000 })
  return { user: publicUser(account), accessToken: await accessToken(account.id, session.id) }
}

export type AuthenticatedRequest = Request & { auth?: { userId: string; sessionId: string; email: string; accessExpiresAt?: number } }
export async function assertActiveSession(auth: { userId: string; sessionId: string }) {
  const now = new Date()
  if (!await prisma.authSession.count({ where: { id: auth.sessionId, userId: auth.userId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, user: { deletedAt: null, emailVerifiedAt: { not: null } } } })) throw new ApiError(401, 'SESSION_EXPIRED', 'Сессия завершена.')
}
// Only this middleware can populate the cache. It lives for one Request, never across requests.
const authenticatedRequests = new WeakSet<Request>()
const accountTraffic = accountRateLimit('api-account', 600)

export async function requireAuth(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  if (authenticatedRequests.has(request)) { next(); return }
  const started = performance.now()
  const bearer = request.get('authorization')?.match(/^Bearer (.+)$/)
  if (!bearer) { response.status(401).json({ message: 'Требуется вход в аккаунт.' }); return }
  try {
    const { payload } = await jwtVerify(bearer[1], jwtKey, { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || !z.uuid().safeParse(payload.sub).success || !z.uuid().safeParse(payload.sid).success) throw new Error('Invalid token')
    const blocked = accountTraffic.blocked(payload.sub)
    if (blocked) { response.set('Retry-After', String(Math.max(1, Math.ceil((+blocked.resetTime - Date.now()) / 1000)))).status(429).json({ code: 'TOO_MANY_REQUESTS', message: 'Слишком много запросов. Повторите попытку позже.' }); return }
    const [session] = await prisma.$queryRaw<Array<{ id: string; userId: string; revokedAt: Date | null; idleExpiresAt: Date; absoluteExpiresAt: Date; lastUsedAt: Date; email: string; userDeletedAt: Date | null; emailVerifiedAt: Date | null }>>`
      SELECT s.id, s.user_id AS "userId", s.revoked_at AS "revokedAt", s.idle_expires_at AS "idleExpiresAt",
        s.absolute_expires_at AS "absoluteExpiresAt", s.last_used_at AS "lastUsedAt", u.email,
        u.deleted_at AS "userDeletedAt", u.email_verified_at AS "emailVerifiedAt"
      FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ${payload.sid}::uuid LIMIT 1`
    const now = new Date()
    if (!session || session.userId !== payload.sub || session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now || session.userDeletedAt || !session.emailVerifiedAt) {
      response.status(401).json({ message: 'Сессия завершена.' }); return
    }
    request.auth = { userId: session.userId, sessionId: session.id, email: session.email, accessExpiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : undefined }
    bindSecuritySession(session.id)
    authenticatedRequests.add(request)
    if (session.lastUsedAt.getTime() < now.getTime() - 60_000) await prisma.authSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastUsedAt: now } })
    accountTraffic(request, response, next)
  } catch (error) {
    if (error instanceof joseErrors.JOSEError || error instanceof Error && error.message === 'Invalid token') response.status(401).json({ message: 'Сессия завершена.' })
    else next(error)
  } finally { recordTiming('auth', performance.now() - started) }
}

const sentMessage = process.env.NODE_ENV === 'development' && (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD)
  ? 'Для получения кода настройте SMTP. Секретные данные не выводятся в журнал сервера.'
  : 'Если адрес подходит для этого действия, код отправлен. Проверьте почту.'

export function createAuthRouter({ sendCode = deliverSecurityCode }: { sendCode?: typeof deliverSecurityCode } = {}) {
  const router = Router()
  router.use(securityContext, authLimiter, (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })

  router.post('/register', accountLimiter, async (request, response) => {
    const parsed = registerBody.safeParse(request.body)
    if (!parsed.success) { response.status(400).json({ message: 'Проверьте данные регистрации.', errors: z.flattenError(parsed.error).fieldErrors }); return }
    await reserveAuthAttempt('send-code', parsed.data.email, 5)
    const now = new Date(), code = newCode()
    // A pending account never owns a password. The mailbox owner chooses it with the code.
    const user = await prisma.$transaction(async tx => {
      const pending = await tx.user.upsert({ where: { email: parsed.data.email }, create: { email: parsed.data.email }, update: {} })
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${pending.id}::uuid FOR UPDATE`
      const current = await tx.user.findUniqueOrThrow({ where: { id: pending.id } })
      if (current.deletedAt || current.emailVerifiedAt || current.lastSecurityEmailAt && current.lastSecurityEmailAt.getTime() > now.getTime() - EMAIL_COOLDOWN_MS) return null
      await tx.user.update({ where: { id: current.id }, data: { passwordHash: null, lastSecurityEmailAt: now } })
      await tx.emailVerificationToken.deleteMany({ where: { userId: current.id } })
      await tx.emailVerificationToken.create({ data: { userId: current.id, tokenHash: codeDigest(current.id, 'verification', code), expiresAt: new Date(now.getTime() + CODE_MS) } })
      return current
    })
    if (user) {
      try { await sendCode('verification', user.email, code) }
      catch (error) { await prisma.user.updateMany({ where: { id: user.id, lastSecurityEmailAt: now }, data: { lastSecurityEmailAt: user.lastSecurityEmailAt } }); throw error }
    }
    response.status(202).json({ message: sentMessage })
  })

  router.post('/resend-verification', accountLimiter, async (request, response) => {
    const parsed = z.object({ email }).safeParse(request.body)
    if (!parsed.success) { response.status(400).json({ message: 'Укажите корректный email.' }); return }
    await reserveAuthAttempt('send-code', parsed.data.email, 5)
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
    if (user && !user.deletedAt && !user.emailVerifiedAt) {
      const now = new Date()
      const claimed = await prisma.user.updateMany({ where: { id: user.id, OR: [{ lastSecurityEmailAt: null }, { lastSecurityEmailAt: { lte: new Date(now.getTime() - EMAIL_COOLDOWN_MS) } }] }, data: { lastSecurityEmailAt: now } })
      if (claimed.count) {
        const code = newCode()
        await prisma.$transaction([
          prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
          prisma.emailVerificationToken.create({ data: { userId: user.id, tokenHash: codeDigest(user.id, 'verification', code), expiresAt: new Date(now.getTime() + CODE_MS) } }),
        ])
        try { await sendCode('verification', user.email, code) }
        catch (error) { await prisma.user.updateMany({ where: { id: user.id, lastSecurityEmailAt: now }, data: { lastSecurityEmailAt: user.lastSecurityEmailAt } }); throw error }
      }
    }
    response.status(202).json({ message: sentMessage })
  })

  router.post('/verify-email', accountLimiter, async (request, response) => {
    const parsed = verifyBody.safeParse(request.body)
    if (!parsed.success) { response.status(400).json({ message: parsed.error.issues.find(issue => issue.path.includes('password'))?.message ?? 'Укажите код, новый пароль и согласия.' }); return }
    await reserveAuthAttempt('verification-code', parsed.data.email, 10)
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
    if (!user || user.deletedAt || user.emailVerifiedAt) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
    const record = await prisma.emailVerificationToken.findFirst({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: 'desc' } })
    if (!record || record.expiresAt <= new Date() || record.attempts >= MAX_CODE_ATTEMPTS) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
    const expected = codeDigest(user.id, 'verification', parsed.data.code)
    const nextHash = record.tokenHash === expected ? await passwordHash(parsed.data.password) : null
    const verified = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
      if (current.deletedAt || current.emailVerifiedAt || current.email !== user.email || current.securityVersion !== user.securityVersion) return null
      const now = new Date()
      const consumed = await tx.emailVerificationToken.updateMany({ where: { id: record.id, usedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS }, expiresAt: { gt: now } }, data: { attempts: { increment: 1 }, ...(nextHash ? { usedAt: now } : {}) } })
      if (!consumed.count || !nextHash) return null
      await clearPasswordAttempts(tx, user.email)
      await invalidateSecurityChallenges(tx, user.id)
      await revokeOtherSessions(tx, user.id)
      await tx.emailVerificationToken.deleteMany({ where: { userId: user.id } })
      return tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now, passwordHash: nextHash, termsAcceptedAt: now, dataConsentAt: now, securityVersion: { increment: 1 } } })
    })
    if (!verified) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
    response.json(await createSession(verified, request, response))
  })

  router.use('/yandex', createYandexRouter({ createSession, requireAuth, verifyPassword: verifyLoginPassword }))
  router.use('/email-change', createEmailChangeRouter({ requireAuth, verifyPassword: verifyLoginPassword, clearRefreshCookie }))

  router.post('/login', loginLimiter, accountLimiter, async (request, response) => {
    const parsed = loginBody.safeParse(request.body)
    if (!parsed.success) { response.status(400).json({ message: invalidCredentials }); return }
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
    let valid:boolean
    try{valid=await verifyLoginPassword(user?.passwordHash??null,parsed.data.password,parsed.data.email)}catch(error){if(error instanceof ApiError&&error.code==='AUTH_ACCOUNT_LIMIT')await recordSecurityEvent(prisma,{action:'LOGIN_FAILED',userId:user?.id,outcome:'DENIED',reasonCode:'ACCOUNT_RATE_LIMIT'});throw error}
    if (!user || !valid || user.deletedAt) { await recordSecurityEvent(prisma, { action: 'LOGIN_FAILED', userId: user?.id, outcome: 'DENIED', reasonCode: user?.deletedAt?'ACCOUNT_DELETING':!user?.passwordHash?'PASSWORD_UNAVAILABLE':'INVALID_CREDENTIALS' }); response.status(401).json({ message: invalidCredentials }); return }
    if (!user.emailVerifiedAt) { await recordSecurityEvent(prisma,{action:'LOGIN_FAILED',userId:user.id,outcome:'DENIED',reasonCode:'EMAIL_UNVERIFIED'}); response.status(403).json({ code: 'EMAIL_NOT_VERIFIED', message: 'Подтвердите email перед входом.' }); return }
    response.json(await createSession(user, request, response))
  })

  router.post('/refresh', refreshLimiter, async (request, response) => {
    const rawToken = request.cookies?.[COOKIE_NAME]
    if (typeof rawToken !== 'string' || rawToken.length > 256) { response.status(401).json({ message: 'Сессия завершена.' }); return }
    const rotated = await rotateRefreshToken(rawToken, request.cookies?.[BROWSER_COOKIE_NAME])
    if (!rotated) {
      response.status(401).json({ message: 'Сессия завершена.' }); return
    }
    const { session, token } = rotated
    setRefreshCookie(response, token)
    response.json({ user: publicUser(session.user), accessToken: await accessToken(session.userId, session.id) })
  })

  router.post('/logout', async (request, response) => {
    const rawToken = request.cookies?.[COOKIE_NAME]
    if (typeof rawToken === 'string' && rawToken.length <= 256 && await revokeRefreshToken(rawToken)) clearRefreshCookie(response)
    response.status(204).end()
  })

  router.post('/logout-all', requireAuth, async (request: AuthenticatedRequest, response) => {
    await prisma.$transaction(async tx => { const result = await tx.authSession.updateMany({ where: { userId: request.auth!.userId, revokedAt: null }, data: { revokedAt: new Date(), lastActiveAt: null } }); await recordSecurityEvent(tx, { action: 'SESSIONS_REVOKED', userId: request.auth!.userId, count: result.count }) })
    clearRefreshCookie(response)
    response.status(204).end()
  })

  function deviceDetails(userAgent: string | null) {
    const value = userAgent ?? ''
    const device = /iPhone/i.test(value) ? 'iPhone' : /iPad/i.test(value) ? 'iPad' : /Android/i.test(value) ? 'Android' : /Macintosh|Mac OS X/i.test(value) ? 'Mac' : /Windows/i.test(value) ? 'Windows' : /Linux/i.test(value) ? 'Linux' : 'Неизвестное устройство'
    const browser = /Edg\/|EdgiOS\/|EdgA\//i.test(value) ? 'Microsoft Edge' : /OPR\//i.test(value) ? 'Opera' : /Chrome\/|CriOS\//i.test(value) ? 'Google Chrome' : /Firefox\/|FxiOS\//i.test(value) ? 'Firefox' : /Safari\//i.test(value) ? 'Safari' : 'Браузер'
    const kind = /iPhone|iPad|Android|Mobile/i.test(value) ? 'mobile' : 'desktop'
    return { device, browser, kind }
  }

  router.get('/sessions', requireAuth, async (request: AuthenticatedRequest, response) => {
    const now = new Date()
    const sessions = await prisma.authSession.findMany({ where: { userId: request.auth!.userId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } }, orderBy: { lastUsedAt: 'desc' } })
    response.json({ sessions: sessions.map((session) => ({ id: session.id, ...deviceDetails(session.userAgent), ipAddress: session.ipAddress, createdAt: session.createdAt, lastUsedAt: session.lastUsedAt, current: session.id === request.auth!.sessionId })) })
  })

  router.delete('/sessions/:sessionId', requireAuth, async (request: AuthenticatedRequest, response) => {
    const parsed = z.string().uuid().safeParse(request.params.sessionId)
    if (!parsed.success) { response.status(400).json({ message: 'Некорректный идентификатор сеанса.' }); return }
    const revoked = await prisma.$transaction(async tx => { const result = await tx.authSession.updateMany({ where: { id: parsed.data, userId: request.auth!.userId, revokedAt: null }, data: { revokedAt: new Date(), lastActiveAt: null } }); if (result.count) await recordSecurityEvent(tx, { action: 'SESSION_REVOKED', userId: request.auth!.userId, resourceType: 'SESSION', resourceId: parsed.data }); return result })
    if (!revoked.count) { response.status(404).json({ message: 'Активный сеанс не найден.' }); return }
    if (parsed.data === request.auth!.sessionId) clearRefreshCookie(response)
    response.status(204).end()
  })

  router.post('/sessions/revoke-others', requireAuth, async (request: AuthenticatedRequest, response) => {
    await prisma.$transaction(tx => revokeOtherSessions(tx, request.auth!.userId, request.auth!.sessionId))
    response.status(204).end()
  })

  router.get('/me', requireAuth, async (request: AuthenticatedRequest, response) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId } })
    response.json({ user: publicUser(user) })
  })

  router.post('/forgot-password', accountLimiter, async (request, response) => {
    const parsed = z.object({ email }).safeParse(request.body)
    if (!parsed.success) { response.status(400).json({ message: 'Укажите корректный email.' }); return }
    await reserveAuthAttempt('send-code', parsed.data.email, 5)
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
    if (user && !user.deletedAt && user.emailVerifiedAt) {
      const now = new Date()
      const code = newCode()
      const claimed = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`
        const current = await tx.user.findUnique({ where: { id: user.id } })
        if (!current || current.deletedAt || !current.emailVerifiedAt || current.email !== user.email || current.securityVersion !== user.securityVersion || current.lastSecurityEmailAt && current.lastSecurityEmailAt.getTime() > now.getTime() - EMAIL_COOLDOWN_MS) return false
        await tx.user.update({ where: { id: user.id }, data: { lastSecurityEmailAt: now } })
        await tx.passwordResetToken.deleteMany({ where: { userId: user.id } })
        await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: codeDigest(user.id, 'reset', code), expiresAt: new Date(now.getTime() + CODE_MS) } })
        return true
      })
      if (claimed) {
        try { await sendCode('reset', user.email, code) }
        catch (error) { await prisma.user.updateMany({ where: { id: user.id, lastSecurityEmailAt: now }, data: { lastSecurityEmailAt: user.lastSecurityEmailAt } }); throw error }
      }
    }
    response.status(202).json({ message: sentMessage })
  })

  router.post('/reset-password', accountLimiter, async (request, response) => {
    const parsed = resetBody.safeParse(request.body)
    if (!parsed.success) { response.status(400).json({ message: parsed.error.issues.find(issue => issue.path.includes('password'))?.message ?? 'Проверьте новый пароль и код.' }); return }
    await reserveAuthAttempt('reset-code', parsed.data.email, 10)
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
    if (!user || user.deletedAt || !user.emailVerifiedAt) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
    const record = await prisma.passwordResetToken.findFirst({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: 'desc' } })
    if (!record || record.expiresAt <= new Date() || record.attempts >= MAX_CODE_ATTEMPTS) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
    const expected = codeDigest(user.id, 'reset', parsed.data.code)
    const nextHash = record.tokenHash === expected ? await passwordHash(parsed.data.password) : null
    const changed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`
      const current = await tx.user.findUnique({ where: { id: user.id } })
      if (!current || current.deletedAt || !current.emailVerifiedAt || current.email !== user.email || current.securityVersion !== user.securityVersion) return false
      const updated = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS }, expiresAt: { gt: new Date() } }, data: { attempts: { increment: 1 }, ...(nextHash ? { usedAt: new Date() } : {}) } })
      if (!updated.count || !nextHash) return false
      await clearPasswordAttempts(tx, user.email)
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: nextHash, securityVersion: { increment: 1 } } })
      await invalidateSecurityChallenges(tx, user.id)
      await revokeOtherSessions(tx, user.id)
      await queuePasswordChanged(tx, user.id)
      return true
    })
    if (!changed) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
    clearRefreshCookie(response)
    response.json({ message: 'Пароль обновлён. Войдите снова.' })
  })

  router.post('/change-password', loginLimiter, requireAuth, async (request: AuthenticatedRequest, response) => {
    const parsed = changeBody.safeParse(request.body)
    if (!parsed.success) { response.status(400).json({ message: parsed.error.issues.find(issue => issue.path.includes('newPassword'))?.message ?? 'Проверьте новый пароль.' }); return }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId } })
    if (!user.passwordHash) { response.status(409).json({ code: 'PASSWORD_NOT_SET', message: 'Сначала создайте пароль в настройках способов входа, подтвердив Яндекс ID.' }); return }
    if (!await verifyLoginPassword(user.passwordHash, parsed.data.currentPassword, user.email)) { await recordSecurityEvent(prisma, { action: 'CONFIRMATION_FAILED', userId: user.id, outcome: 'DENIED', reasonCode: 'INVALID_CONFIRMATION', resourceType: 'ACCOUNT', resourceId: user.id }); response.status(401).json({ message: 'Текущий пароль указан неверно.' }); return }
    if (parsed.data.currentPassword === parsed.data.newPassword) { response.status(400).json({ message: 'Новый пароль должен отличаться от текущего.' }); return }
    const nextHash = await passwordHash(parsed.data.newPassword)
    await prisma.$transaction(async tx => {
      const current = await lockAccount(tx, request.auth!)
      if (current.securityVersion !== user.securityVersion || current.passwordHash !== user.passwordHash) throw securityChanged()
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: nextHash, securityVersion: { increment: 1 } } })
      await invalidateSecurityChallenges(tx, user.id)
      await revokeOtherSessions(tx, user.id, request.auth!.sessionId)
      await queuePasswordChanged(tx, user.id)
    })
    response.json({ message: 'Пароль обновлён. Другие сеансы завершены.' })
  })

  router.use(async (error: unknown, request: AuthenticatedRequest, _response: Response, next: NextFunction) => {
    if (request.auth && error instanceof ApiError && ['INVALID_PASSWORD', 'INVALID_CODE', 'SECURITY_CHANGED', 'YANDEX_WRONG_ACCOUNT', 'YANDEX_EXPIRED'].includes(error.code)) {
      await recordSecurityEvent(prisma, { action: 'CONFIRMATION_FAILED', userId: request.auth.userId, outcome: 'DENIED', reasonCode: 'INVALID_CONFIRMATION', resourceType: 'ACCOUNT', resourceId: request.auth.userId })
    }
    next(error)
  })
  return router
}

export default createAuthRouter()
