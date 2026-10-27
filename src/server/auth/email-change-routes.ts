import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { Router, type RequestHandler, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { prisma } from '../db.ts'
import type { AuthenticatedRequest } from '../auth.ts'
import { ApiError } from '../api-error.ts'
import { deliverSecurityCode } from '../mail/transport.ts'
import { queueAccountSecurityEvent } from '../mail/email-outbox.ts'
import { invalidateSecurityChallenges, lockAccount, revokeOtherSessions, securityChanged } from './account-security.ts'
import { requireYandexProof } from './yandex-routes.ts'

const startBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), currentPassword: z.string().min(1).max(256).optional() }).strict()
const confirmBody = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).strict()
const invalidCode = () => new ApiError(400, 'INVALID_CODE', 'Неверный или истёкший код. Начните изменение почты заново.')
const unavailable = () => new ApiError(409, 'EMAIL_UNAVAILABLE', 'Этот адрес нельзя использовать. Укажите другой.')
function codeHash(id: string, email: string, code: string) {
  return createHmac('sha256', process.env.JWT_SECRET!).update(`email-change:${id}:${email}:${code}`).digest('hex')
}
type Dependencies = {
  requireAuth: RequestHandler
  verifyPassword: (hash: string | null, password: string, account?: string) => Promise<boolean>
  clearRefreshCookie: (response: Response) => void
  sendCode?: typeof deliverSecurityCode
}
export function createEmailChangeRouter(dependencies: Dependencies) {
  const router = Router()
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: request => (request as AuthenticatedRequest).auth!.userId, message: { message: 'Слишком много попыток. Попробуйте позже.' } })
  const sendLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: request => (request as AuthenticatedRequest).auth!.userId, message: { message: 'Слишком много запросов кода. Попробуйте позже.' } })
  router.use(dependencies.requireAuth, limiter, (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  router.post('/start', sendLimiter, async (request: AuthenticatedRequest, response) => {
    const input = startBody.parse(request.body)
    const snapshot = await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId } })
    if (snapshot.passwordHash && !await dependencies.verifyPassword(snapshot.passwordHash, input.currentPassword ?? '', snapshot.email)) throw new ApiError(401, 'INVALID_PASSWORD', 'Текущий пароль Staffly указан неверно.')
    const id = randomUUID(), code = randomInt(0, 1_000_000).toString().padStart(6, '0'), expiresAt = new Date(Date.now() + 10 * 60_000)
    await prisma.$transaction(async tx => {
      const user = await lockAccount(tx, request.auth!)
      if (user.securityVersion !== snapshot.securityVersion || user.passwordHash !== snapshot.passwordHash) throw securityChanged()
      const proof = user.passwordHash ? null : await requireYandexProof(tx, request, 'EMAIL_CHANGE', user)
      if (user.email === input.email || await tx.user.findUnique({ where: { email: input.email } })) throw unavailable()
      await tx.emailChangeToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } })
      await tx.emailChangeToken.create({ data: { id, userId: user.id, sessionId: request.auth!.sessionId, email: input.email, codeHash: codeHash(id, input.email, code), securityVersion: user.securityVersion, expiresAt } })
      if (proof) await tx.oAuthAttempt.delete({ where: { id: proof.id } })
    })
    try { await (dependencies.sendCode ?? deliverSecurityCode)('email-change', input.email, code) }
    catch {
      await prisma.emailChangeToken.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } })
      throw new ApiError(503, 'EMAIL_SEND_FAILED', 'Не удалось отправить код. Попробуйте начать изменение почты заново.')
    }
    response.json({ challengeId: id, email: input.email, expiresAt })
  })
  router.post('/confirm', async (request: AuthenticatedRequest, response) => {
    const input = confirmBody.parse(request.body)
    let changed: boolean
    try {
      changed = await prisma.$transaction(async tx => {
        const user = await lockAccount(tx, request.auth!), now = new Date()
        const token = await tx.emailChangeToken.findFirst({ where: { id: input.challengeId, userId: user.id, sessionId: request.auth!.sessionId, securityVersion: user.securityVersion, usedAt: null, expiresAt: { gt: now }, attempts: { lt: 5 } } })
        if (!token) return false
        const valid = timingSafeEqual(Buffer.from(token.codeHash, 'hex'), Buffer.from(codeHash(token.id, token.email, input.code), 'hex'))
        await tx.emailChangeToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 }, ...(valid ? { usedAt: now } : {}) } })
        if (!valid) return false
        if (await tx.user.findUnique({ where: { email: token.email } })) throw unavailable()
        await tx.user.update({ where: { id: user.id }, data: { email: token.email, emailVerifiedAt: now, securityVersion: { increment: 1 } } })
        await invalidateSecurityChallenges(tx, user.id)
        await revokeOtherSessions(tx, user.id)
        await queueAccountSecurityEvent(tx, user.id, 'EMAIL_CHANGED', { oldEmail: user.email, newEmail: token.email })
        return true
      })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw unavailable()
      throw error
    }
    if (!changed) throw invalidCode()
    dependencies.clearRefreshCookie(response)
    response.json({ message: 'Почта изменена. Войдите снова с новым адресом или через Яндекс.' })
  })
  router.post('/cancel', async (request: AuthenticatedRequest, response) => {
    const input = z.object({ challengeId: z.string().uuid() }).strict().parse(request.body)
    await prisma.emailChangeToken.updateMany({ where: { id: input.challengeId, userId: request.auth!.userId, sessionId: request.auth!.sessionId, usedAt: null }, data: { usedAt: new Date() } })
    response.status(204).end()
  })
  return router
}
