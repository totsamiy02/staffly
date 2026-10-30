export const planIds = ['FREE', 'TEAM', 'BUSINESS'] as const
export type PlanId = typeof planIds[number]
export type PaidPlanId = Exclude<PlanId, 'FREE'>
export type PlanFeature = 'reports' | 'customRoles' | 'planning'
export const PLAN_VERSION = '2026-10-v1'
export const GRACE_DAYS = 7
export const TRIAL_DAYS = 14
const MB = 1024 ** 2
export const plans = {
  FREE: { id: 'FREE', name: 'Бесплатный', description: 'Для небольшой команды', priceMinor: 0, members: 5, locations: 1, storageBytes: 250 * MB, storageLabel: '250 МБ', features: [] as PlanFeature[] },
  TEAM: { id: 'TEAM', name: 'Команда', description: 'Для ежедневной работы', priceMinor: 99000, members: 25, locations: 3, storageBytes: 2 * 1024 * MB, storageLabel: '2 ГБ', features: ['reports'] as PlanFeature[] },
  BUSINESS: { id: 'BUSINESS', name: 'Бизнес', description: 'Для сложных процессов и роста', priceMinor: 299000, members: 100, locations: 10, storageBytes: 10 * 1024 * MB, storageLabel: '10 ГБ', features: ['reports', 'customRoles', 'planning'] as PlanFeature[] },
} satisfies Record<PlanId, { id: PlanId; name: string; description: string; priceMinor: number; members: number; locations: number; storageBytes: number; storageLabel: string; features: PlanFeature[] }>
export const featurePlans: Record<PlanFeature, PaidPlanId> = { reports: 'TEAM', customRoles: 'BUSINESS', planning: 'BUSINESS' }
export const featureLabels: Record<PlanFeature, string> = { reports: 'Отчёты и выгрузка в Excel', customRoles: 'Свои роли и разрешения', planning: 'Потребность, черновики и обсуждение графиков' }
export const money = (minor: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100)
export const isPlanId = (value: unknown): value is PlanId => typeof value === 'string' && (planIds as readonly string[]).includes(value)
export type SubscriptionSnapshot = {
  plan: PlanId; effectivePlan: PlanId; phase: 'free' | 'trial' | 'active' | 'grace' | 'expired';
  validUntil: string | null; graceUntil: string | null; trialEndsAt: string | null; readOnly: boolean;
  trialAvailable: boolean;
  scheduled: { plan: PlanId; startsAt: string; endsAt: string | null } | null;
  limits: { members: number; locations: number; storageBytes: number }; features: PlanFeature[];
}
export type SubscriptionRecord = { plan: string; periodStart: Date | null; periodEnd: Date | null; trialEndsAt: Date | null; trialStartedAt?: Date | null; nextPlan: string | null; nextStartsAt: Date | null; nextEndsAt: Date | null }
export function effectiveSubscription(record: SubscriptionRecord, now = new Date()): SubscriptionSnapshot {
  const next = !!record.nextPlan && !!record.nextStartsAt && record.nextStartsAt <= now
  const plan = (next ? record.nextPlan : record.plan) as PlanId
  const until = next ? record.nextEndsAt : record.periodEnd
  const trialEndsAt = next ? null : record.trialEndsAt
  const graceUntil = until ? new Date(+until + GRACE_DAYS * 86400000) : null
  const phase = plan === 'FREE' ? 'free' : trialEndsAt && trialEndsAt > now ? 'trial' : until && until > now ? 'active' : graceUntil && graceUntil > now ? 'grace' : 'expired'
  const effectivePlan = phase === 'expired' ? 'FREE' : plan
  const selected = plans[effectivePlan]
  return { plan, effectivePlan, phase, validUntil: until?.toISOString() ?? null, graceUntil: graceUntil?.toISOString() ?? null, trialEndsAt: trialEndsAt?.toISOString() ?? null, readOnly: phase === 'expired', trialAvailable: !record.trialStartedAt && !record.nextPlan && (phase === 'free' || phase === 'expired'),
    scheduled: !next && record.nextPlan && record.nextStartsAt ? { plan: record.nextPlan as PlanId, startsAt: record.nextStartsAt.toISOString(), endsAt: record.nextEndsAt?.toISOString() ?? null } : null,
    limits: { members: selected.members, locations: selected.locations, storageBytes: selected.storageBytes }, features: selected.features }
}
export function nextMonth(date: Date) {
  const next = new Date(date); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1)
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()
  next.setUTCDate(Math.min(date.getUTCDate(), lastDay)); return next
}
