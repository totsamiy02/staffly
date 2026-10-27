import type { Prisma } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'

export type AccountSession = { userId: string; sessionId: string }
export async function lockAccount(tx: Prisma.TransactionClient, auth: AccountSession) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${auth.userId}::uuid FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${auth.sessionId}::uuid AND user_id = ${auth.userId}::uuid FOR UPDATE`
  const user = await tx.user.findUnique({ where: { id: auth.userId } }), now = new Date()
  const session = await tx.authSession.findFirst({ where: { id: auth.sessionId, userId: auth.userId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } } })
  if (!user || user.deletedAt || !user.emailVerifiedAt || !session) throw new ApiError(401, 'SESSION_EXPIRED', 'Сеанс завершён. Войдите снова.')
  return user
}
export async function invalidateSecurityChallenges(tx: Prisma.TransactionClient, userId: string) {
  const now = new Date()
  await tx.oAuthAttempt.deleteMany({ where: { userId } })
  await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } })
  await tx.emailChangeToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } })
}
export function revokeOtherSessions(tx: Prisma.TransactionClient, userId: string, keepSessionId?: string) {
  return tx.authSession.updateMany({ where: { userId, ...(keepSessionId ? { id: { not: keepSessionId } } : {}), revokedAt: null }, data: { revokedAt: new Date(), lastActiveAt: null } })
}
export function securityChanged() {
  return new ApiError(409, 'SECURITY_CHANGED', 'Настройки безопасности уже изменились. Подтвердите действие ещё раз.')
}
