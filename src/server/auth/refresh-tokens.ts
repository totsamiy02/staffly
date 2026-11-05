import { createHash, createHmac } from 'node:crypto'
import { prisma } from '../db.ts'
import { sessionTransaction } from './session-transaction.ts'
import { recordSecurityEvent } from '../security/journal.ts'

export const REFRESH_RETRY_MS = 30_000
export const refreshHash = (token: string) => createHash('sha256').update(token).digest('hex')
// A retry can reproduce its successor without storing a usable token in the DB.
function successor(token: string, sessionId: string) {
  return createHmac('sha384', process.env.JWT_SECRET!).update('staffly-refresh-v1\0').update(sessionId).update('\0').update(token).digest('base64url')
}

export async function rotateRefreshToken(rawToken: string, browserToken: unknown) {
  const hash = refreshHash(rawToken)
  return sessionTransaction(() => prisma.$transaction(async tx => {
    const current = await tx.authSession.findUnique({ where: { refreshTokenHash: hash }, select: { id: true, userId: true } })
    const spent = current ? null : await tx.refreshTokenUse.findUnique({ where: { tokenHash: hash }, include: { session: { select: { userId: true } } } })
    const identity = current ?? (spent ? { id: spent.sessionId, userId: spent.session.userId } : null)
    if (!identity) return null
    // Same lock order as login, password/email changes and account deletion.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${identity.userId}::uuid FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${identity.id}::uuid FOR UPDATE`
    const session = await tx.authSession.findUnique({ where: { id: identity.id }, include: { user: true } })
    const now = new Date()
    if (!session || session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now || session.user.deletedAt || !session.user.emailVerifiedAt) return null
    if (session.refreshTokenHash === hash) {
      const token = successor(rawToken, session.id)
      await tx.refreshTokenUse.create({ data: { tokenHash: hash, sessionId: session.id, consumedAt: now, expiresAt: session.absoluteExpiresAt } })
      await tx.authSession.update({ where: { id: session.id }, data: { refreshTokenHash: refreshHash(token), lastUsedAt: now,
        idleExpiresAt: new Date(Math.min(+now + 7 * 86400_000, +session.absoluteExpiresAt)) } })
      return { session, token }
    }
    // Re-read under the lock: another replica may just have consumed this token.
    const used = await tx.refreshTokenUse.findUnique({ where: { tokenHash: hash } })
    if (!used || used.sessionId !== session.id) return null // A fresh login starts a new grant.
    const sameBrowser = typeof browserToken === 'string' && browserToken.length <= 256 && session.browserTokenHash === refreshHash(browserToken)
    if (sameBrowser && +now - +used.consumedAt <= REFRESH_RETRY_MS) {
      // Coalesce concurrent tabs and lost/out-of-order responses, without sliding
      // the grace deadline or issuing another generation on a retry.
      let token = rawToken
      for (let i = 0; i < 128; i++) {
        token = successor(token, session.id)
        if (refreshHash(token) === session.refreshTokenHash) return { session, token }
      }
    }
    // Commit revocation before returning the rejection; throwing would roll it back.
    await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: now, refreshReuseDetectedAt: now, lastActiveAt: null } })
    await recordSecurityEvent(tx, { action: 'REFRESH_REUSE', userId: session.userId, sessionId: session.id, resourceType: 'SESSION', resourceId: session.id, outcome: 'DENIED', reasonCode: 'TOKEN_REUSE' })
    return null
  }, { isolationLevel: 'ReadCommitted' }))
}

export async function revokeRefreshToken(rawToken: string) {
  const hash = refreshHash(rawToken)
  return sessionTransaction(() => prisma.$transaction(async tx => {
    const current = await tx.authSession.findUnique({ where: { refreshTokenHash: hash }, select: { id: true, userId: true } })
    const used = current ? null : await tx.refreshTokenUse.findUnique({ where: { tokenHash: hash }, include: { session: { select: { userId: true } } } })
    const identity = current ?? (used ? { id: used.sessionId, userId: used.session.userId } : null)
    if (!identity) return false
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${identity.userId}::uuid FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${identity.id}::uuid FOR UPDATE`
    // A login may have replaced this grant while we waited. The initial token
    // lookup is only an identity hint, never authority to revoke the new grant.
    const session = await tx.authSession.findUnique({ where: { id: identity.id } })
    if (!session) return false
    if (session.refreshTokenHash !== hash && (await tx.refreshTokenUse.findUnique({ where: { tokenHash: hash } }))?.sessionId !== session.id) return false
    if (!session.revokedAt) await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), lastActiveAt: null } })
    await recordSecurityEvent(tx, { action: 'SESSION_REVOKED', userId: session.userId, sessionId: session.id, resourceType: 'SESSION', resourceId: session.id })
    return true
  }, { isolationLevel: 'ReadCommitted' }))
}
