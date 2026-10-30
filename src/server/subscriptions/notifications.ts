import { prisma } from '../db.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { effectiveSubscription, plans } from '../../app/subscriptions/plans.ts'

// Owner-only inbox notices. Delivery keys survive dismiss/read and prevent
// refreshes or multiple workers from resurrecting the same reminder.
export async function syncSubscriptionNotices(userId?: string, organizationId?: string, afterId?: string, includeActive = false, db: Prisma.TransactionClient = prisma) {
  const owners = await db.organizationMember.findMany({ where: { role: 'OWNER', leftAt: null, user: { deletedAt: null }, organization: { deletedAt: null }, ...(userId ? { userId } : {}), ...(organizationId ? { organizationId } : {}), ...(afterId ? { id: { gt: afterId } } : {}) }, include: { organization: { include: { subscription: true } } }, orderBy: { id: 'asc' }, take: 200 })
  const freeOwners: Array<{ userId: string; organizationId: string }> = []
  for (const owner of owners) {
    const record = owner.organization.subscription
    if (!record) continue
    const sub = effectiveSubscription(record), now = new Date()
    if (sub.phase === 'free') { freeOwners.push({ userId: owner.userId, organizationId: owner.organizationId }); continue }
    const ending = !!sub.validUntil && Date.parse(sub.validUntil) - +now <= 3 * 86400000
    if (!includeActive && !ending && (sub.phase === 'active' || sub.phase === 'trial')) continue
    const phase = (sub.phase === 'active' || sub.phase === 'trial') && ending ? 'ending' : sub.phase
    const key = `${owner.organizationId}:${owner.userId}:${record.revision}:${phase}`
    const date = (value: string) => new Date(value).toLocaleDateString('ru-RU', { timeZone: owner.organization.timezone })
    const title = phase === 'ending' ? sub.phase === 'trial' ? 'Пробный период скоро закончится' : 'Подписка скоро закончится' : sub.phase === 'trial' ? 'Пробный Бизнес подключён' : sub.phase === 'grace' ? 'Подписка закончилась' : sub.phase === 'expired' ? 'Подписка завершилась' : `Тариф «${plans[sub.plan].name}» подключён`
    const message = sub.phase === 'expired' ? 'Данные доступны для просмотра. Продлите подписку или выберите бесплатный тариф.' : sub.phase === 'grace' ? `Льготный доступ действует до ${date(sub.graceUntil!)}. Выберите тариф для дальнейшей работы.` : `Возможности тарифа «${plans[sub.plan].name}» доступны до ${date(sub.validUntil!)}.${sub.scheduled ? ` С ${date(sub.scheduled.startsAt)} — ${plans[sub.scheduled.plan].name}.` : ''}`
    await db.accountNotification.updateMany({ where: { userId: owner.userId, organizationId: owner.organizationId, type: 'SUBSCRIPTION_STATUS', readAt: null, subscriptionDeliveryKey: { not: key } }, data: { readAt: now } })
    await db.accountNotification.createMany({ data: [{ userId: owner.userId, organizationId: owner.organizationId, type: 'SUBSCRIPTION_STATUS', title, message, subscriptionDeliveryKey: key, emailAttemptedAt: now }], skipDuplicates: true })
  }
  if (freeOwners.length) await db.accountNotification.updateMany({ where: { type: 'SUBSCRIPTION_STATUS', readAt: null, OR: freeOwners }, data: { readAt: new Date() } })
  return owners.length === 200 ? owners.at(-1)!.id : undefined
}
