import { prisma } from '../db.ts'
import { syncSubscriptionNotices } from './notifications.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { effectiveSubscription, nextMonth, plans, PLAN_VERSION, TRIAL_DAYS, type PlanId, type PaidPlanId } from '../../app/subscriptions/plans.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
type DB = Prisma.TransactionClient
async function lockedOwner(db: DB, userId: string, organizationId: string) {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
  const actor = await getMembership(userId, organizationId, db)
  if (!actor.owner) throw new ApiError(403, 'OWNER_REQUIRED', 'Изменить тариф может только владелец организации.')
  return actor
}
async function currentRecord(db: DB, organizationId: string) {
  const record = await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId } })
  if (record.nextPlan && record.nextStartsAt && record.nextStartsAt <= new Date()) return db.organizationSubscription.update({ where: { organizationId }, data: { plan: record.nextPlan, periodStart: record.nextStartsAt, periodEnd: record.nextEndsAt, trialEndsAt: null, nextPlan: null, nextStartsAt: null, nextEndsAt: null, revision: { increment: 1 } } })
  return record
}
async function usage(db: DB, organizationId: string) {
  const [members, locations, budget] = await Promise.all([
    db.organizationMember.count({ where: { organizationId, leftAt: null, user: { deletedAt: null } } }),
    db.organizationLocation.count({ where: { organizationId, archivedAt: null } }),
    db.organizationResourceBudget.findUniqueOrThrow({ where: { organizationId } }),
  ])
  return { members, locations, storageBytes: Number(budget.storageBytes) }
}
async function fits(db: DB, organizationId: string, plan: PlanId) {
  const current = await usage(db, organizationId), target = plans[plan]
  if (current.members > target.members || current.locations > target.locations || current.storageBytes > target.storageBytes) throw new ApiError(409, 'SUBSCRIPTION_DOWNGRADE_LIMIT', 'Сначала уменьшите число участников, точек или объём файлов до лимитов выбранного тарифа.', { organizationId, requiredPlan: plan, usage: current, limits: target })
}
export async function subscriptionDetails(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  const [record, current] = await Promise.all([prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId } }), usage(prisma, organizationId)])
  const purchases = actor.owner ? await prisma.subscriptionPurchase.findMany({ where: { organizationId, status: 'SUCCEEDED' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30, select: { id: true, plan: true, amountMinor: true, activatedAt: true, periodStart: true, periodEnd: true, kind: true } }) : []
  return { subscription: effectiveSubscription(record), usage: current, purchases, canManage: actor.owner, organization: { id: organizationId, name: actor.organization.name }, mode: 'test' as const }
}
export async function startBusinessTrial(userId: string, organizationId: string) {
  return prisma.$transaction(async db => {
    const actor = await lockedOwner(db, userId, organizationId)
    const record = await currentRecord(db, organizationId)
    if (record.trialStartedAt) throw new ApiError(409, 'SUBSCRIPTION_TRIAL_USED', 'Пробный период этой организации уже использован.')
    if (!effectiveSubscription(record).trialAvailable) throw new ApiError(409, 'SUBSCRIPTION_TRIAL_UNAVAILABLE', 'Пробный период можно включить на бесплатном тарифе или после завершения подписки.')
    const now = new Date(), until = new Date(+now + TRIAL_DAYS * 86400000)
    const saved = await db.organizationSubscription.update({ where: { organizationId }, data: { plan: 'BUSINESS', version: PLAN_VERSION, periodStart: now, periodEnd: until, trialStartedAt: now, trialEndsAt: until, nextPlan: null, nextStartsAt: null, nextEndsAt: null, revision: { increment: 1 } } })
    await db.organizationResourceBudget.update({ where: { organizationId }, data: { storageLimitBytes: plans.BUSINESS.storageBytes } })
    await db.accessAudit.create({ data: { organizationId, actorMemberId: actor.id, action: 'SUBSCRIPTION_TRIAL_STARTED', details: { until: until.toISOString() } } })
    await syncSubscriptionNotices(userId, organizationId, undefined, true, db)
    return effectiveSubscription(saved)
  })
}
export async function createCheckout(userId: string, organizationId: string, plan: PaidPlanId) {
  return prisma.$transaction(async db => {
    await lockedOwner(db, userId, organizationId)
    const record = await currentRecord(db, organizationId), now = new Date(), current = effectiveSubscription(record, now)
    if (current.scheduled) throw new ApiError(409, 'SUBSCRIPTION_CHANGE_SCHEDULED', 'Уже запланировано изменение тарифа. Сначала отмените его.')
    let start = now, end = nextMonth(now), amount = plans[plan].priceMinor, kind = 'ACTIVATE'
    if (current.phase === 'active' && current.validUntil && !current.trialEndsAt) {
      const until = new Date(current.validUntil)
      if (plan === current.plan) { start = until; end = nextMonth(until); kind = 'RENEW' }
      else if (plans[plan].priceMinor > plans[current.plan].priceMinor) {
        end = until; kind = 'UPGRADE'
        amount = Math.ceil((plans[plan].priceMinor - plans[current.plan].priceMinor) * (+until - +now) / (+nextMonth(now) - +now))
      } else { await fits(db, organizationId, plan); start = until; end = nextMonth(until); kind = 'DOWNGRADE' }
    }
    // Reuse a still valid order. Its immutable server quote binds price, tenant,
    // owner, subscription revision and period; the browser never sets money.
    const existing = await db.subscriptionPurchase.findFirst({ where: { organizationId, userId, plan, status: 'PENDING', subscriptionRevision: record.revision, expiresAt: { gt: now } } })
    const order = existing ?? await db.subscriptionPurchase.create({ data: { organizationId, userId, plan, version: PLAN_VERSION, kind, amountMinor: amount, subscriptionRevision: record.revision, periodStart: start, periodEnd: end, expiresAt: new Date(Math.min(+now + 10 * 60000, kind === 'UPGRADE' ? +end : Infinity)) } })
    return publicOrder(order)
  }, { timeout: 15000 })
}
function publicOrder(order: { id: string; plan: string; kind: string; amountMinor: number; periodStart: Date; periodEnd: Date; expiresAt: Date; status: string }) {
  return { id: order.id, plan: order.plan as PaidPlanId, kind: order.kind, amountMinor: order.amountMinor, periodStart: order.periodStart, periodEnd: order.periodEnd, expiresAt: order.expiresAt, status: order.status }
}
export async function activateTestPurchase(userId: string, organizationId: string, orderId: string, email: string) {
  return prisma.$transaction(async db => {
    await lockedOwner(db, userId, organizationId)
    const order = await db.subscriptionPurchase.findFirst({ where: { id: orderId, organizationId, userId } })
    if (!order) throw new ApiError(404, 'SUBSCRIPTION_ORDER_NOT_FOUND', 'Заказ не найден.')
    if (order.status === 'SUCCEEDED') return { order: publicOrder(order), subscription: effectiveSubscription(await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId } })) }
    const record = await currentRecord(db, organizationId), now = new Date()
    if (order.status !== 'PENDING' || order.expiresAt <= now || order.subscriptionRevision !== record.revision) throw new ApiError(409, 'SUBSCRIPTION_ORDER_EXPIRED', 'Условия покупки изменились или время заказа истекло. Выберите тариф заново.')
    const plan = order.plan as PaidPlanId
    if (order.kind === 'DOWNGRADE') await fits(db, organizationId, plan)
    const saved = await db.organizationSubscription.update({ where: { organizationId }, data: { version: order.version, revision: { increment: 1 }, ...(order.kind === 'DOWNGRADE' ? { nextPlan: plan, nextStartsAt: order.periodStart, nextEndsAt: order.periodEnd } : { plan, periodStart: order.kind === 'RENEW' ? record.periodStart : order.periodStart, periodEnd: order.periodEnd, trialEndsAt: null, nextPlan: null, nextStartsAt: null, nextEndsAt: null }) } })
    const snapshot = effectiveSubscription(saved, now)
    await db.organizationResourceBudget.update({ where: { organizationId }, data: { storageLimitBytes: snapshot.limits.storageBytes } })
    const purchased = await db.subscriptionPurchase.update({ where: { id: order.id }, data: { status: 'SUCCEEDED', activatedAt: now, email } })
    await db.accessAudit.create({ data: { organizationId, actorMemberId: (await getMembership(userId, organizationId, db)).id, action: 'SUBSCRIPTION_TEST_PURCHASE', details: { orderId, plan, kind: order.kind, amountMinor: order.amountMinor, mode: 'test' } } })
    await syncSubscriptionNotices(userId, organizationId, undefined, true, db)
    return { order: publicOrder(purchased), subscription: snapshot }
  }, { timeout: 15000 })
}
export async function selectFreePlan(userId: string, organizationId: string, immediate: boolean) {
  return prisma.$transaction(async db => {
    await lockedOwner(db, userId, organizationId)
    const record = await currentRecord(db, organizationId), current = effectiveSubscription(record)
    if (current.scheduled && current.scheduled.plan !== 'FREE') throw new ApiError(409, 'SUBSCRIPTION_CHANGE_PAID', 'Уже запланирован оплаченный переход. Дождитесь начала периода.')
    await fits(db, organizationId, 'FREE')
    const scheduled = !immediate && current.phase === 'active' && !current.trialEndsAt && record.periodEnd && record.periodEnd > new Date()
    const saved = await db.organizationSubscription.update({ where: { organizationId }, data: { revision: { increment: 1 }, ...(scheduled ? { nextPlan: 'FREE', nextStartsAt: record.periodEnd, nextEndsAt: null } : { plan: 'FREE', periodStart: null, periodEnd: null, trialEndsAt: null, nextPlan: null, nextStartsAt: null, nextEndsAt: null }) } })
    const result = effectiveSubscription(saved)
    await db.organizationResourceBudget.update({ where: { organizationId }, data: { storageLimitBytes: result.limits.storageBytes } })
    return result
  })
}
export async function cancelScheduledChange(userId: string, organizationId: string) {
  return prisma.$transaction(async db => {
    await lockedOwner(db, userId, organizationId)
    const record = await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId } })
    if (record.nextStartsAt && record.nextStartsAt <= new Date()) throw new ApiError(409, 'SUBSCRIPTION_CHANGE_APPLIED', 'Изменение тарифа уже вступило в силу.')
    if (record.nextPlan && record.nextPlan !== 'FREE') throw new ApiError(409, 'SUBSCRIPTION_CHANGE_PAID', 'Изменение уже оплачено в тестовом режиме. Дождитесь начала периода.')
    return effectiveSubscription(await db.organizationSubscription.update({ where: { organizationId }, data: { nextPlan: null, nextStartsAt: null, nextEndsAt: null, revision: { increment: 1 } } }))
  })
}
