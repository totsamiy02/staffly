import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { recordSecurityEvent } from './journal.ts'

export async function securityHistory(userId: string, organizationId: string | undefined, page = 1) {
  if (organizationId && !(await getMembership(userId, organizationId)).owner) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Журнал безопасности организации доступен только владельцу.')
  const where = { ...(organizationId ? { organizationId } : { userId, organizationId: null }), expiresAt: { gt: new Date() } }
  const pageSize = 25, total = await prisma.securityEvent.count({ where }), pages = Math.max(1, Math.ceil(total / pageSize)), current = Math.min(Math.max(page, 1), pages)
  const entries = await prisma.securityEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (current - 1) * pageSize, take: pageSize,
    select: { id: true, userId: true, action: true, outcome: true, createdAt: true, correlationId: true, resourceType: true, resourceId: true, count: true } })
  const actors = organizationId ? await prisma.organizationMember.findMany({ where: { organizationId, userId: { in: entries.flatMap(e => e.userId ? [e.userId] : []) } }, select: { userId: true, user: { select: { firstName: true, lastName: true, deletedAt: true } } } }) : []
  const labels = new Map(actors.map(m => [m.userId, m.user.deletedAt ? 'Удалённый пользователь' : [m.user.lastName, m.user.firstName].filter(Boolean).join(' ') || 'Участник']))
  const publicEntries = entries.map(({ userId: actor, ...entry }) => ({ ...entry, actorLabel: !actor ? 'Система' : actor === userId ? 'Вы' : labels.get(actor) ?? 'Аккаунт вне организации' }))
  await recordSecurityEvent(prisma, { action: 'JOURNAL_VIEWED', userId, organizationId, resourceType: 'JOURNAL' })
  return { entries: publicEntries, retentionDays: 180, cleanupEnabled: process.env.DATA_PURGE_ENABLED === 'true', pagination: { page: current, pages, total } }
}
