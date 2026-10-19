import { z } from 'zod'
import { emailCategoryKeys, normalizeEmailCategories } from '../../app/notifications/email-preferences.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { hasPermission } from '../organizations/access/access.ts'

export const emailPreferencesBody = z.object({
  enabled: z.boolean().optional(), categories: z.partialRecord(z.enum(emailCategoryKeys), z.boolean()).optional(),
  revision: z.number().int().nonnegative(), confirmDisable: z.boolean().optional(),
}).strict().refine(value => value.enabled !== undefined || value.categories !== undefined, 'Выберите настройку.')

export async function availableEmailCategories(userId: string) {
  const memberships = await prisma.organizationMember.findMany({ where: { userId, leftAt: null, organization: { deletedAt: null } }, select: { organizationId: true } })
  let absences = false, digest = false
  for (const membership of memberships) {
    const actor = await getMembership(userId, membership.organizationId)
    absences ||= hasPermission(actor, 'absences.view')
    digest ||= ['requests.resolve', 'drafts.resolve', 'offers.approve', 'vacations.resolve'].some(key => hasPermission(actor, key as 'requests.resolve'))
  }
  return emailCategoryKeys.filter(key => key !== 'urgentAbsences' && key !== 'actionDigest' || key === 'urgentAbsences' && absences || key === 'actionDigest' && digest)
}
export async function getEmailPreferences(userId: string) {
  const [user, availableCategories] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { emailNotificationsEnabled: true, emailNotificationCategories: true, emailPreferencesRevision: true } }), availableEmailCategories(userId)])
  return { enabled: user.emailNotificationsEnabled, categories: normalizeEmailCategories(user.emailNotificationCategories), revision: user.emailPreferencesRevision, availableCategories }
}
export async function saveEmailPreferences(userId: string, input: z.infer<typeof emailPreferencesBody>) {
  const available = await availableEmailCategories(userId)
  if (Object.entries(input.categories ?? {}).some(([key, value]) => value && !available.includes(key as typeof available[number]))) throw new ApiError(403, 'EMAIL_CATEGORY_UNAVAILABLE', 'Эта категория сейчас недоступна.')
  await prisma.$transaction(async tx => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (user.emailNotificationsEnabled && input.enabled === false && !input.confirmDisable) throw new ApiError(400, 'EMAIL_DISABLE_CONFIRMATION', 'Подтвердите отключение рабочих писем.')
    const categories = { ...normalizeEmailCategories(user.emailNotificationCategories), ...input.categories }
    const changed = await tx.user.updateMany({ where: { id: userId, deletedAt: null, emailPreferencesRevision: input.revision }, data: { emailNotificationsEnabled: input.enabled ?? user.emailNotificationsEnabled, emailNotificationCategories: categories, emailPreferencesRevision: { increment: 1 } } })
    if (!changed.count) throw new ApiError(409, 'EMAIL_PREFERENCES_CHANGED', 'Настройки изменились в другой вкладке. Обновите страницу и повторите выбор.')
    // A subsequent re-enable must not resurrect work missed while the category was off.
    await tx.emailDelivery.updateMany({ where: { userId, status: 'PENDING', category: input.enabled === false ? { not: null } : { in: Object.entries(categories).filter(([, enabled]) => !enabled).map(([key]) => key) } }, data: { status: 'SKIPPED' } })
  })
  return getEmailPreferences(userId)
}
