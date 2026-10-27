import { createHmac } from 'node:crypto'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import type { Prisma } from '../../generated/prisma/client.ts'

const windowMs = 15 * 60_000
const attemptKey = (purpose: string, identifier: string) => createHmac('sha256', process.env.JWT_SECRET!).update(`${purpose}:${identifier}`).digest('hex')
// Shared PostgreSQL buckets protect the account across IPs, processes and restarts.
// HMAC keys do not expose addresses or credential hashes in the table.
export async function reserveAuthAttempt(purpose: string, identifier: string, limit: number) {
  const key = attemptKey(purpose, identifier)
  const now = new Date(), expiresAt = new Date(now.getTime() + windowMs)
  const [bucket] = await prisma.$queryRaw<{ attempts: number; expires_at: Date }[]>`
    INSERT INTO auth_attempt_limits (key, attempts, expires_at) VALUES (${key}, 1, ${expiresAt})
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN auth_attempt_limits.expires_at <= ${now} THEN 1 ELSE LEAST(auth_attempt_limits.attempts + 1, ${limit + 1}) END,
      expires_at = CASE WHEN auth_attempt_limits.expires_at <= ${now} THEN ${expiresAt} ELSE auth_attempt_limits.expires_at END
    RETURNING attempts, expires_at`
  if (bucket.attempts > limit) throw new ApiError(429, 'AUTH_ACCOUNT_LIMIT', 'Слишком много попыток для этого аккаунта. Попробуйте через 15 минут или используйте другой способ входа.')
  return { key, expiresAt: bucket.expires_at }
}

export async function clearAuthAttempts(bucket: { key: string; expiresAt: Date }) {
  // Do not clear a newer window opened while the credential check was running.
  await prisma.authAttemptLimit.deleteMany({ where: { key: bucket.key, expiresAt: bucket.expiresAt } })
}

export async function clearPasswordAttempts(tx: Prisma.TransactionClient, email: string) {
  await tx.authAttemptLimit.deleteMany({ where: { key: attemptKey('password', email) } })
}
