import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { Router } from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { hash, verify, argon2id } from 'argon2'
import { SignJWT, jwtVerify } from 'jose'
import { z } from 'zod'
import { prisma } from './db.ts'
import { deliverPasswordChanged, deliverSecurityCode } from './mail.ts'
import { mediaUrl } from './storage/image-service.ts'

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
const COOKIE_PATH = '/api/auth'
const invalidCredentials = 'Неверная почта или пароль.'

const email = z.string().trim().toLowerCase().email().max(254)
const password = z.string().min(10).max(128)
  .refine((value) => /[a-zа-яё]/u.test(value), 'Добавьте строчную букву.')
  .refine((value) => /[A-ZА-ЯЁ]/u.test(value), 'Добавьте заглавную букву.')
  .refine((value) => /\d/.test(value), 'Добавьте цифру.')
  .refine((value) => /[^\p{L}\p{N}\s]/u.test(value), 'Добавьте специальный символ.')
  .refine((value) => !/\s/u.test(value), 'Пароль не должен содержать пробелы.')
const registerBody = z.object({ email, password, confirmPassword: z.string(), consentData: z.literal(true), consentTerms: z.literal(true) })
  .refine((body) => body.password === body.confirmPassword, { path: ['confirmPassword'], message: 'Пароли не совпадают' })
const loginBody = z.object({ email, password: z.string() })
const codeBody = z.object({ email, code: z.string().regex(/^\d{6}$/) })
const resetBody = codeBody.extend({ password, confirmPassword: z.string() })
  .refine((body) => body.password === body.confirmPassword, { path: ['confirmPassword'], message: 'Пароли не совпадают' })
const changeBody = z.object({ currentPassword: z.string(), newPassword: password })

const router = Router()
const tooManyRequests = (_request: Request, response: Response) => response.status(429).json({ message: 'Слишком много запросов. Попробуйте позже.' })
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false, handler: tooManyRequests })
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, handler: tooManyRequests })
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: tooManyRequests,
  keyGenerator: (request) => `${ipKeyGenerator(request.ip || '127.0.0.1')}:${createHash('sha256').update(String(request.body?.email || '').trim().toLowerCase()).digest('hex')}`,
})
router.use(authLimiter)

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

function passwordHash(value: string) {
  return hash(value, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
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

function clearRefreshCookie(response: Response) {
  response.clearCookie(COOKIE_NAME, { path: COOKIE_PATH, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' })
}

function publicUser(user: { id: string; email: string; firstName?: string | null; lastName?: string | null; middleName?: string | null; phone?: string | null; bio?: string | null; avatarFileId?: string | null }) {
  const displayName = [user.lastName, user.firstName].filter(Boolean).join(' ') || user.email.split('@')[0]
  return { id: user.id, email: user.email, displayName, firstName: user.firstName ?? null, lastName: user.lastName ?? null, middleName: user.middleName ?? null, phone: user.phone ?? null, bio: user.bio ?? null, avatarUrl: mediaUrl(user.avatarFileId) }
}

async function accessToken(userId: string, sessionId: string) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_LIFETIME)
    .sign(jwtKey)
}

async function createSession(user: { id: string; email: string }, request: Request, response: Response) {
  const now = Date.now()
  const rawToken = newToken()
  const session = await prisma.authSession.create({
    data: {
      userId: user.id,
      refreshTokenHash: digest(rawToken),
      idleExpiresAt: new Date(now + IDLE_MS),
      absoluteExpiresAt: new Date(now + ABSOLUTE_MS),
      userAgent: request.get('user-agent')?.slice(0, 512),
      ipAddress: request.ip?.slice(0, 45),
    },
  })
  setRefreshCookie(response, rawToken)
  return { user: publicUser(user), accessToken: await accessToken(user.id, session.id) }
}

export type AuthenticatedRequest = Request & { auth?: { userId: string; sessionId: string; email: string } }

export async function requireAuth(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  const bearer = request.get('authorization')?.match(/^Bearer (.+)$/)
  if (!bearer) { response.status(401).json({ message: 'Требуется вход в аккаунт.' }); return }
  try {
    const { payload } = await jwtVerify(bearer[1], jwtKey, { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error('Invalid token')
    const session = await prisma.authSession.findUnique({ where: { id: payload.sid }, include: { user: true } })
    const now = new Date()
    if (!session || session.userId !== payload.sub || session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now || session.user.deletedAt || !session.user.emailVerifiedAt) {
      response.status(401).json({ message: 'Сессия завершена.' }); return
    }
    request.auth = { userId: session.userId, sessionId: session.id, email: session.user.email }
    if (session.lastUsedAt.getTime() < now.getTime() - 60_000) void prisma.authSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastUsedAt: now } })
    next()
  } catch {
    response.status(401).json({ message: 'Сессия завершена.' })
  }
}

const sentMessage = process.env.NODE_ENV === 'development' && (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD)
  ? 'Если адрес подходит для этого действия, код появится в терминале сервера. Настройте SMTP для отправки на почту.'
  : 'Если адрес подходит для этого действия, код отправлен. Проверьте почту.'

router.post('/register', accountLimiter, async (request, response) => {
  const parsed = registerBody.safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ message: 'Проверьте данные регистрации.', errors: z.flattenError(parsed.error).fieldErrors }); return }
  const { email: userEmail, password: userPassword } = parsed.data
  const code = newCode()
  const now = new Date()
  try {
    const user = await prisma.user.create({ data: {
      email: userEmail,
      passwordHash: await passwordHash(userPassword),
      lastSecurityEmailAt: now,
    } })
    await prisma.emailVerificationToken.create({ data: { userId: user.id, tokenHash: codeDigest(user.id, 'verification', code), expiresAt: new Date(now.getTime() + CODE_MS) } })
    try { await deliverSecurityCode('verification', userEmail, code) }
    catch (error) {
      await prisma.user.delete({ where: { id: user.id } })
      throw error
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error
  }
  response.status(202).json({ message: sentMessage })
})

router.post('/resend-verification', accountLimiter, async (request, response) => {
  const parsed = z.object({ email }).safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ message: 'Укажите корректный email.' }); return }
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
      try { await deliverSecurityCode('verification', user.email, code) }
      catch (error) { await prisma.user.updateMany({ where: { id: user.id, lastSecurityEmailAt: now }, data: { lastSecurityEmailAt: user.lastSecurityEmailAt } }); throw error }
    }
  }
  response.status(202).json({ message: sentMessage })
})

router.post('/verify-email', accountLimiter, async (request, response) => {
  const parsed = codeBody.safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ message: 'Укажите почту и шестизначный код.' }); return }
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (!user || user.deletedAt || user.emailVerifiedAt) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
  const record = await prisma.emailVerificationToken.findFirst({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: 'desc' } })
  if (!record || record.expiresAt <= new Date() || record.attempts >= MAX_CODE_ATTEMPTS) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
  const expected = codeDigest(user.id, 'verification', parsed.data.code)
  const updated = await prisma.emailVerificationToken.updateMany({ where: { id: record.id, usedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS }, expiresAt: { gt: new Date() } }, data: { attempts: { increment: 1 }, ...(record.tokenHash === expected ? { usedAt: new Date() } : {}) } })
  if (!updated.count || record.tokenHash !== expected) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
  const verified = await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } })
  response.json(await createSession(verified, request, response))
})

const dummyHashPromise = passwordHash('staffly-dummy-password-for-timing')

router.post('/login', loginLimiter, accountLimiter, async (request, response) => {
  const parsed = loginBody.safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ message: invalidCredentials }); return }
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  const valid = await verify(user?.passwordHash ?? await dummyHashPromise, parsed.data.password)
  if (!user || !valid || user.deletedAt) { response.status(401).json({ message: invalidCredentials }); return }
  if (!user.emailVerifiedAt) { response.status(403).json({ code: 'EMAIL_NOT_VERIFIED', message: 'Подтвердите email перед входом.' }); return }
  response.json(await createSession(user, request, response))
})

router.post('/refresh', async (request, response) => {
  const rawToken = request.cookies?.[COOKIE_NAME]
  if (typeof rawToken !== 'string' || rawToken.length > 256) { response.status(401).json({ message: 'Сессия завершена.' }); return }
  const session = await prisma.authSession.findUnique({ where: { refreshTokenHash: digest(rawToken) }, include: { user: true } })
  const now = new Date()
  if (!session || session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now || session.user.deletedAt || !session.user.emailVerifiedAt) {
    clearRefreshCookie(response)
    response.status(401).json({ message: 'Сессия завершена.' }); return
  }
  const nextToken = newToken()
  const updated = await prisma.authSession.updateMany({
    where: { id: session.id, refreshTokenHash: digest(rawToken), revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
    data: { refreshTokenHash: digest(nextToken), lastUsedAt: now, idleExpiresAt: new Date(Math.min(now.getTime() + IDLE_MS, session.absoluteExpiresAt.getTime())) },
  })
  if (!updated.count) { clearRefreshCookie(response); response.status(401).json({ message: 'Сессия завершена.' }); return }
  setRefreshCookie(response, nextToken)
  response.json({ user: publicUser(session.user), accessToken: await accessToken(session.userId, session.id) })
})

router.post('/logout', async (request, response) => {
  const rawToken = request.cookies?.[COOKIE_NAME]
  if (typeof rawToken === 'string') await prisma.authSession.updateMany({ where: { refreshTokenHash: digest(rawToken) }, data: { revokedAt: new Date() } })
  clearRefreshCookie(response)
  response.status(204).end()
})

router.post('/logout-all', requireAuth, async (request: AuthenticatedRequest, response) => {
  await prisma.authSession.updateMany({ where: { userId: request.auth!.userId, revokedAt: null }, data: { revokedAt: new Date() } })
  clearRefreshCookie(response)
  response.status(204).end()
})

function deviceDetails(userAgent: string | null) {
  const value = userAgent ?? ''
  const device = /iPhone/i.test(value) ? 'iPhone' : /iPad/i.test(value) ? 'iPad' : /Android/i.test(value) ? 'Android' : /Macintosh|Mac OS X/i.test(value) ? 'Mac' : /Windows/i.test(value) ? 'Windows' : /Linux/i.test(value) ? 'Linux' : 'Неизвестное устройство'
  const browser = /Edg\//i.test(value) ? 'Microsoft Edge' : /OPR\//i.test(value) ? 'Opera' : /Chrome\//i.test(value) ? 'Google Chrome' : /Firefox\//i.test(value) ? 'Firefox' : /Safari\//i.test(value) ? 'Safari' : 'Браузер'
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
  const revoked = await prisma.authSession.updateMany({ where: { id: parsed.data, userId: request.auth!.userId, revokedAt: null }, data: { revokedAt: new Date() } })
  if (!revoked.count) { response.status(404).json({ message: 'Активный сеанс не найден.' }); return }
  if (parsed.data === request.auth!.sessionId) clearRefreshCookie(response)
  response.status(204).end()
})

router.post('/sessions/revoke-others', requireAuth, async (request: AuthenticatedRequest, response) => {
  await prisma.authSession.updateMany({ where: { userId: request.auth!.userId, id: { not: request.auth!.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } })
  response.status(204).end()
})

router.get('/me', requireAuth, async (request: AuthenticatedRequest, response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId } })
  response.json({ user: publicUser(user) })
})

router.post('/forgot-password', accountLimiter, async (request, response) => {
  const parsed = z.object({ email }).safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ message: 'Укажите корректный email.' }); return }
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (user && !user.deletedAt && user.emailVerifiedAt) {
    const now = new Date()
    const claimed = await prisma.user.updateMany({ where: { id: user.id, OR: [{ lastSecurityEmailAt: null }, { lastSecurityEmailAt: { lte: new Date(now.getTime() - EMAIL_COOLDOWN_MS) } }] }, data: { lastSecurityEmailAt: now } })
    if (claimed.count) {
      const code = newCode()
      await prisma.$transaction([
        prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
        prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: codeDigest(user.id, 'reset', code), expiresAt: new Date(now.getTime() + CODE_MS) } }),
      ])
      try { await deliverSecurityCode('reset', user.email, code) }
      catch (error) { await prisma.user.updateMany({ where: { id: user.id, lastSecurityEmailAt: now }, data: { lastSecurityEmailAt: user.lastSecurityEmailAt } }); throw error }
    }
  }
  response.status(202).json({ message: sentMessage })
})

router.post('/reset-password', accountLimiter, async (request, response) => {
  const parsed = resetBody.safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ message: 'Проверьте новый пароль и код.' }); return }
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (!user || user.deletedAt || !user.emailVerifiedAt) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
  const record = await prisma.passwordResetToken.findFirst({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: 'desc' } })
  if (!record || record.expiresAt <= new Date() || record.attempts >= MAX_CODE_ATTEMPTS) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
  const expected = codeDigest(user.id, 'reset', parsed.data.code)
  const nextHash = record.tokenHash === expected ? await passwordHash(parsed.data.password) : null
  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS }, expiresAt: { gt: new Date() } }, data: { attempts: { increment: 1 }, ...(nextHash ? { usedAt: new Date() } : {}) } })
    if (!updated.count || !nextHash) return false
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: nextHash } })
    await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } })
    return true
  })
  if (!changed) { response.status(400).json({ message: 'Неверный или истёкший код.' }); return }
  clearRefreshCookie(response)
  void deliverPasswordChanged(user.email).catch((error) => console.error('Password-reset email failed:', error))
  response.json({ message: 'Пароль обновлён. Войдите снова.' })
})

router.post('/change-password', loginLimiter, requireAuth, async (request: AuthenticatedRequest, response) => {
  const parsed = changeBody.safeParse(request.body)
  if (!parsed.success) { response.status(400).json({ message: 'Новый пароль не соответствует требованиям безопасности.' }); return }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId } })
  if (!await verify(user.passwordHash, parsed.data.currentPassword)) { response.status(401).json({ message: 'Текущий пароль указан неверно.' }); return }
  if (parsed.data.currentPassword === parsed.data.newPassword) { response.status(400).json({ message: 'Новый пароль должен отличаться от текущего.' }); return }
  const nextHash = await passwordHash(parsed.data.newPassword)
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: nextHash } }),
    prisma.authSession.updateMany({ where: { userId: user.id, id: { not: request.auth!.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } }),
  ])
  void deliverPasswordChanged(user.email).catch((error) => console.error('Password-changed email failed:', error))
  response.json({ message: 'Пароль обновлён. Другие сеансы завершены.' })
})

export default router
