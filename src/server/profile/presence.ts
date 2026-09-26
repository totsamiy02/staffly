import { prisma } from '../db.ts'
import type { Prisma } from '../../generated/prisma/client.ts'

// Online means a visible authenticated tab sent a heartbeat in the last 90 seconds.
export const PRESENCE_TTL_MS = 90_000
export function onlineSessions(now = new Date()): Prisma.AuthSessionWhereInput {
  return { revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, lastActiveAt: { gt: new Date(now.getTime() - PRESENCE_TTL_MS) } }
}
export async function updatePresence(userId: string, sessionId: string, visible: boolean) {
  const now = new Date()
  await prisma.$transaction(async tx => {
    const updated = await tx.authSession.updateMany({ where: { id: sessionId, userId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } }, data: { lastActiveAt: visible ? now : null } })
    if (visible && updated.count) await tx.user.update({ where: { id: userId }, data: { lastSeenAt: now } })
  })
}
