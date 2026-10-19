import { randomUUID } from 'node:crypto'
import type { Prisma, EmailDelivery } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { normalizeEmailCategories, type EmailCategory } from '../../app/notifications/email-preferences.ts'
import { renderEmail, sendPreparedMail, type EmailContent } from '../mail.ts'

export async function enqueueEmail(tx: Prisma.TransactionClient | typeof prisma, data: { userId: string; organizationId?: string; sourceKey: string; sourceKind: string; sourceId?: string; category?: EmailCategory; content?: EmailContent; availableAt?: Date }) {
  if (data.category) {
    const user = await tx.user.findUnique({ where: { id: data.userId }, select: { deletedAt: true, emailNotificationsEnabled: true, emailNotificationCategories: true } })
    if (!user || user.deletedAt || !user.emailNotificationsEnabled || !normalizeEmailCategories(user.emailNotificationCategories)[data.category]) return
  }
  const created = await tx.emailDelivery.createMany({ data: [{ userId: data.userId, organizationId: data.organizationId, sourceKey: data.sourceKey, sourceKind: data.sourceKind, sourceId: data.sourceId, category: data.category, ...(data.content ? { payload: data.content as unknown as Prisma.InputJsonValue } : {}) }], skipDuplicates: true })
  if (created.count && data.availableAt) await tx.$executeRaw`UPDATE email_deliveries SET available_at=${data.availableAt.toISOString()}::timestamptz WHERE source_key=${data.sourceKey}`
}
export function passwordChangedEmail(): EmailContent {
  return { title: 'Пароль изменён', eyebrow: 'Безопасность', intro: 'Пароль вашего аккаунта Staffly обновлён. Остальные активные сеансы завершены.', action: { label: 'Проверить безопасность', path: '/app/settings?section=security' }, footer: 'Если это сделали не вы, немедленно восстановите доступ через страницу входа.' }
}
export async function queuePasswordChanged(tx: Prisma.TransactionClient, userId: string) {
  await enqueueEmail(tx, { userId, sourceKind: 'MANDATORY', sourceKey: `password:${randomUUID()}`, content: passwordChangedEmail() })
}

export async function processEmailDeliveries(options: { now?: Date; send?: typeof sendPreparedMail; limit?: number; shouldContinue?: () => boolean } = {}) {
  const send = options.send ?? sendPreparedMail
  // Reclaim leases after a worker crash; SKIP LOCKED prevents simultaneous workers claiming a row.
  let processed = 0
  while (processed < (options.limit ?? Infinity) && (options.shouldContinue?.() ?? true)) {
    const now = options.now ?? new Date()
    const jobs = await prisma.$transaction(async tx => {
      // The pg adapter expects UTC timestamps. Scope UTC to this queue transaction;
      // do not change the connection timezone of callers' business transactions.
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM email_deliveries WHERE status='PENDING' AND available_at<=${now.toISOString()}::timestamptz AND (locked_until IS NULL OR locked_until<=${now.toISOString()}::timestamptz) ORDER BY (category IS NULL) DESC,available_at,event_order FOR UPDATE SKIP LOCKED LIMIT 1`
      if (!rows.length) return []
      await tx.emailDelivery.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { lockedUntil: new Date(+now + 180_000), attempts: { increment: 1 } } })
      return tx.emailDelivery.findMany({ where: { id: { in: rows.map(r => r.id) } } })
    })
    if (!jobs.length) break
    processed += jobs.length
    for (const job of jobs) {
      try {
        // Settings and access are rechecked on every attempt, not just when the event was queued.
        const user = await prisma.user.findUnique({ where: { id: job.userId }, select: { email:true,deletedAt:true,emailVerifiedAt:true,emailNotificationsEnabled:true,emailNotificationCategories:true } })
        if (!user || user.deletedAt || !user.emailVerifiedAt || job.category && (!user.emailNotificationsEnabled || !normalizeEmailCategories(user.emailNotificationCategories)[job.category as EmailCategory])) { await finish(job, 'SKIPPED'); continue }
        const { buildDeliveryContent } = await import('./email-content.ts')
        const content = await buildDeliveryContent(job, now)
        if (!content) { await finish(job, 'SKIPPED'); continue }
        // An opt-out in another tab also cancels already claimed work before SMTP starts.
        const current = await prisma.emailDelivery.findUnique({ where: { id: job.id }, select: { status: true } })
        if (current?.status !== 'PENDING') continue
        await send(user.email, renderEmail(content), job.id)
        await finish(job, 'SENT', now)
      } catch (error) {
        // Do not store mail content, addresses, credentials or provider responses in the queue log.
        console.error('Email delivery attempt failed:', job.id, error instanceof Error ? error.name : 'Error')
        const status = job.attempts >= 7 || +now - +job.createdAt > 86400_000 ? 'FAILED' : 'PENDING'
        const availableAt = new Date(+now + Math.min(3600_000, 30_000 * 2 ** (job.attempts - 1))).toISOString()
        await prisma.$executeRaw`UPDATE email_deliveries SET locked_until=NULL,status=${status},available_at=${availableAt}::timestamptz WHERE id=${job.id}::uuid AND status='PENDING'`
      }
    }
  }
  return processed
}
async function finish(job: EmailDelivery, status: string, now?: Date) {
  if (now) await prisma.$executeRaw`UPDATE email_deliveries SET status=${status},locked_until=NULL,delivered_at=${now.toISOString()}::timestamptz WHERE id=${job.id}::uuid AND status='PENDING'`
  else await prisma.emailDelivery.updateMany({ where: { id: job.id, status: 'PENDING' }, data: { status, lockedUntil: null } })
}
