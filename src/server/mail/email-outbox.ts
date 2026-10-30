import { randomUUID } from 'node:crypto'
import type { Prisma, EmailDelivery } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { normalizeEmailCategories, type EmailCategory } from '../../app/notifications/email-preferences.ts'
import { renderEmail, sendPreparedMail, type EmailContent } from './transport.ts'

export async function enqueueEmail(tx: Prisma.TransactionClient | typeof prisma, data: { userId: string; organizationId?: string; sourceKey: string; sourceKind: string; sourceId?: string; category?: EmailCategory; content?: EmailContent; availableAt?: Date; recipientEmail?: string }) {
  if (data.recipientEmail && (data.sourceKind !== 'MANDATORY' || data.category)) throw new Error('A fixed recipient is only allowed for mandatory security mail')
  if (data.category) {
    const user = await tx.user.findUnique({ where: { id: data.userId }, select: { deletedAt: true, emailNotificationsEnabled: true, emailNotificationCategories: true } })
    if (!user || user.deletedAt || !user.emailNotificationsEnabled || !normalizeEmailCategories(user.emailNotificationCategories)[data.category]) return
  }
  const created = await tx.emailDelivery.createMany({ data: [{ userId: data.userId, organizationId: data.organizationId, sourceKey: data.sourceKey, sourceKind: data.sourceKind, sourceId: data.sourceId, category: data.category, recipientEmail: data.recipientEmail, ...(data.content ? { payload: data.content as unknown as Prisma.InputJsonValue } : {}) }], skipDuplicates: true })
  if (created.count && data.availableAt) await tx.$executeRaw`UPDATE email_deliveries SET available_at=${data.availableAt.toISOString()}::timestamptz WHERE source_key=${data.sourceKey}`
}
export function passwordChangedEmail(): EmailContent {
  return { title: 'Пароль изменён', eyebrow: 'Безопасность', intro: 'Пароль вашего аккаунта Staffly обновлён. Остальные активные сеансы завершены.', action: { label: 'Проверить безопасность', path: '/app/settings?section=security' }, footer: 'Если это сделали не вы, немедленно восстановите доступ через страницу входа.' }
}
export async function queuePasswordChanged(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  await enqueueEmail(tx, { userId, sourceKind: 'MANDATORY', sourceKey: `password:${randomUUID()}`, recipientEmail: user.email, content: passwordChangedEmail() })
}

type SecurityEvent = 'YANDEX_LINKED' | 'YANDEX_UNLINKED' | 'PASSWORD_CREATED' | 'EMAIL_CHANGED'
export async function queueAccountSecurityEvent(tx: Prisma.TransactionClient, userId: string, event: SecurityEvent, details?: { oldEmail: string; newEmail: string }) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const messages: Record<SecurityEvent, { title: string; intro: string }> = {
    YANDEX_LINKED: { title: 'Яндекс ID подключён', intro: 'К вашему аккаунту Staffly подключён вход через Яндекс. Данные профиля и организации сохранены.' },
    YANDEX_UNLINKED: { title: 'Яндекс ID отключён', intro: 'Вход через Яндекс отключён. Вход по почте и паролю остаётся доступен. Остальные активные сеансы завершены.' },
    PASSWORD_CREATED: { title: 'Пароль для входа создан', intro: 'Теперь вы можете входить в Staffly по почте и заданному паролю, а также через Яндекс. Остальные активные сеансы завершены.' },
    EMAIL_CHANGED: { title: 'Почта аккаунта изменена', intro: 'Адрес для входа, восстановления доступа и писем Staffly изменён. Все прежние сеансы завершены.' },
  }
  const recipients = event === 'EMAIL_CHANGED' && details ? [...new Set([details.oldEmail, details.newEmail])] : [user.email]
  for (const recipientEmail of recipients) await enqueueEmail(tx, { userId, sourceKind: 'MANDATORY', sourceKey: `security:${event}:${randomUUID()}`, recipientEmail, content: { ...messages[event], eyebrow: 'Безопасность', ...(details ? { fields: [['Прежняя почта', details.oldEmail], ['Новая почта', details.newEmail]] } : {}), action: { label: 'Проверить способы входа', path: '/app/settings?section=security' }, footer: 'Если это сделали не вы, проверьте способы входа и завершите чужие сеансы в настройках безопасности.' } })
}

export async function claimEmailDelivery(now = new Date()) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(781234568::bigint)::text`
    const rows = await tx.$queryRaw<Array<{id:string;organizationId:string|null;category:string|null}>>`
      SELECT e.id,e.organization_id AS "organizationId",e.category FROM email_deliveries e
      LEFT JOIN organization_resource_budgets b ON b.organization_id=e.organization_id
      WHERE e.status='PENDING' AND e.available_at<=${now}::timestamptz AND (e.locked_until IS NULL OR e.locked_until<=${now}::timestamptz)
      AND (e.category IS NULL OR e.organization_id IS NULL OR
        b.organization_id IS NOT NULL AND (b.email_window_start<=${now}::timestamptz-interval '1 minute' OR b.email_window_count<b.email_minute_limit)
        AND NOT EXISTS(SELECT 1 FROM email_deliveries active WHERE active.organization_id=e.organization_id AND active.category IS NOT NULL AND active.status='PENDING' AND active.locked_until>${now}::timestamptz))
      ORDER BY (e.category IS NULL) DESC,b.last_email_at ASC NULLS FIRST,e.available_at,e.event_order
      LIMIT 1 FOR UPDATE OF e SKIP LOCKED`
    const row=rows[0]
    if (!row) return null
    if (row.organizationId && row.category) await tx.$executeRaw`
      UPDATE organization_resource_budgets SET last_email_at=${now}::timestamptz,
        email_window_count=CASE WHEN email_window_start<=${now}::timestamptz-interval '1 minute' THEN 1 ELSE email_window_count+1 END,
        email_window_start=CASE WHEN email_window_start<=${now}::timestamptz-interval '1 minute' THEN ${now}::timestamptz ELSE email_window_start END
      WHERE organization_id=${row.organizationId}::uuid`
    return tx.emailDelivery.update({where:{id:row.id},data:{lockedUntil:new Date(+now+180000),attempts:{increment:1}}})
  })
}

export async function processEmailDeliveries(options: { now?: Date; send?: typeof sendPreparedMail; limit?: number; shouldContinue?: () => boolean } = {}) {
  const send = options.send ?? sendPreparedMail
  // Reclaim leases after a worker crash; SKIP LOCKED prevents simultaneous workers claiming a row.
  let processed = 0
  while (processed < (options.limit ?? 100) && (options.shouldContinue?.() ?? true)) {
    const now = options.now ?? new Date()
    const job = await claimEmailDelivery(now)
    const jobs = job ? [job] : []
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
        const recipient = job.sourceKind === 'MANDATORY' && !job.category && job.recipientEmail ? job.recipientEmail : user.email
        await send(recipient, renderEmail(content), job.id)
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
