import type { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { effectiveSubscription, featurePlans, plans, type PlanFeature, type PlanId } from '../../app/subscriptions/plans.ts'
type DB = Prisma.TransactionClient
export async function subscriptionSnapshot(organizationId: string, db: DB = prisma) {
  const record = await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId } })
  return effectiveSubscription(record)
}
export function planError(organizationId: string, feature: PlanFeature) {
  const requiredPlan = featurePlans[feature]
  return new ApiError(403, 'SUBSCRIPTION_FEATURE_REQUIRED', `Эта функция доступна на тарифе «${plans[requiredPlan].name}».`, { organizationId, feature, requiredPlan })
}
// Call only after the operation's ordinary access/permission check.
export async function requirePlanFeature(organizationId: string, feature: PlanFeature, db: DB = prisma) {
  const snapshot = await subscriptionSnapshot(organizationId, db)
  if (!snapshot.features.includes(feature)) throw planError(organizationId, feature)
}
export async function requireCapacity(db: DB, organizationId: string, kind: 'members' | 'locations', additional = 1) {
  // Shares the document/membership lifecycle lock. Concurrent invitations and
  // plan changes cannot both consume the last remaining seat.
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
  const snapshot = await subscriptionSnapshot(organizationId, db)
  if (snapshot.readOnly) throw new ApiError(403, 'SUBSCRIPTION_EXPIRED', 'Подписка завершилась. Продлите её или выберите бесплатный тариф.', { organizationId })
  const used = kind === 'members' ? await db.organizationMember.count({ where: { organizationId, leftAt: null, user: { deletedAt: null } } }) : await db.organizationLocation.count({ where: { organizationId, archivedAt: null } })
  const limit = snapshot.limits[kind]
  if (used + additional > limit) {
    const requiredPlan: PlanId | null = snapshot.effectivePlan === 'FREE' ? 'TEAM' : snapshot.effectivePlan === 'TEAM' ? 'BUSINESS' : null
    throw new ApiError(409, 'SUBSCRIPTION_LIMIT_REACHED', kind === 'members' ? `Все ${limit} мест заняты.` : `Доступно точек: ${limit}. Лимит достигнут.`, { organizationId, kind, used, limit, requiredPlan })
  }
}
export async function requireSubscriptionWritable(db: DB, organizationId: string) {
  const snapshot = await subscriptionSnapshot(organizationId, db)
  if (snapshot.readOnly) throw new ApiError(403, 'SUBSCRIPTION_EXPIRED', 'Подписка завершилась. Данные доступны для просмотра.', { organizationId })
  return snapshot
}
// Legacy locations remain readable after a downgrade. New staffing/access in
// locations beyond the plan needs an upgrade; existing assignments stay intact.
export async function requireLocationInPlan(db: DB, organizationId: string, locationId: string) {
  const snapshot = await requireSubscriptionWritable(db, organizationId)
  const included = await db.organizationLocation.findMany({ where: { organizationId, archivedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: snapshot.limits.locations, select: { id: true } })
  if (!included.some(location => location.id === locationId)) throw new ApiError(409, 'SUBSCRIPTION_LIMIT_REACHED', 'Точка сохранена из предыдущего тарифа. Чтобы добавлять в неё сотрудников и назначать новый доступ, выберите тариф с большим числом точек.', { organizationId, kind: 'locations', limit: snapshot.limits.locations, requiredPlan: snapshot.effectivePlan === 'FREE' ? 'TEAM' : snapshot.effectivePlan === 'TEAM' ? 'BUSINESS' : null })
}
