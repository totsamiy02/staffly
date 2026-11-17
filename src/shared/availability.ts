import { z } from 'zod'
import { isCalendarDate } from './date-time.ts'

const date = z.string().refine(isCalendarDate, 'Укажите корректную дату.')
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Укажите время в формате ЧЧ:ММ.')
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))

export const availabilityRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ANY') }).strict(),
  z.object({ mode: z.literal('OFF') }).strict(),
  z.object({ mode: z.literal('TIME'), start: clock, end: clock, overnight: z.boolean() }).strict(),
]).superRefine((rule, context) => {
  if (rule.mode !== 'TIME') return
  const duration = minutes(rule.end) + (rule.overnight ? 1440 : 0) - minutes(rule.start)
  if (duration <= 0 || duration > 1440) {
    context.addIssue({ code: 'custom', message: 'Интервал должен длиться от 1 минуты до 24 часов. Для ночного времени укажите следующий день.' })
  }
})

export const availabilityWeekSchema = z.array(availabilityRuleSchema).length(7)
export const availabilityConfigSchema = z.object({
  weeks: z.array(z.object({ from: date, days: availabilityWeekSchema }).strict()).max(256),
  exceptions: z.array(z.object({ date, rule: availabilityRuleSchema }).strict()).max(1000),
}).strict().superRefine((config, context) => {
  if (new Set(config.weeks.map(week => week.from)).size !== config.weeks.length) {
    context.addIssue({ code: 'custom', message: 'Для одной даты начала можно сохранить только одно недельное правило.' })
  }
  if (new Set(config.exceptions.map(item => item.date)).size !== config.exceptions.length) {
    context.addIssue({ code: 'custom', message: 'Для одной даты можно задать только одно исключение.' })
  }
}).transform(config => ({
  weeks: [...config.weeks].sort((a, b) => a.from.localeCompare(b.from)),
  exceptions: [...config.exceptions].sort((a, b) => a.date.localeCompare(b.date)),
}))

export const availabilitySaveSchema = z.object({
  operationId: z.uuid(),
  employmentPeriodId: z.uuid(),
  revision: z.number().int().min(0),
  config: availabilityConfigSchema,
}).strict()

export const availabilityAgreementSchema = z.object({
  availabilityConfirmation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  availabilityReason: z.string().trim().max(500).optional(),
})

export type AvailabilityRule = z.infer<typeof availabilityRuleSchema>
export type AvailabilityConfig = z.infer<typeof availabilityConfigSchema>
export type AvailabilitySave = z.infer<typeof availabilitySaveSchema>
export type AvailabilityAgreement = z.infer<typeof availabilityAgreementSchema>
export type AvailabilityPeriod = { memberId: string; start: string; end: string }
export type AvailabilityIssue = AvailabilityPeriod & { date: string; message: string; timezone: string }
export type AvailabilityWarning = { availabilityConfirmation: string; availabilityConflicts: AvailabilityIssue[]; canOverrideAvailability: boolean }
export type AvailabilityOverride = {
  memberId: string
  start: string
  end: string
  reason: string
  actorMemberId: string
  actorName: string
  createdAt: string
  accountId: string
  revision: number
}

export type AvailabilityConflictShift = {
  id: string
  updatedAt: string
  locationId: string
  locationName: string
  timezone: string
  start: string
  end: string
  message: string
  canEdit: boolean
}

export type AvailabilityState = {
  memberId: string
  memberName: string
  avatarUrl: string | null
  employmentPeriodId: string
  revision: number
  timezone: string
  config: AvailabilityConfig
  canManage: boolean
  updatedAt: string | null
  updatedBy: string | null
  conflicts: AvailabilityConflictShift[]
}

export const emptyAvailabilityWeek = (): AvailabilityRule[] => Array.from({ length: 7 }, () => ({ mode: 'ANY' }))
export const emptyAvailabilityConfig = (): AvailabilityConfig => ({ weeks: [], exceptions: [] })
export function availabilityRuleLabel(rule: AvailabilityRule) {
  if (rule.mode === 'ANY') return 'Без ограничений'
  if (rule.mode === 'OFF') return 'Недоступен'
  return `Доступен с ${rule.start} до ${rule.end}${rule.overnight ? ' следующего дня' : ''}`
}

export function availabilityWarningFrom(error: unknown): AvailabilityWarning | null {
  const failure = error as { code?: string; errors?: Partial<AvailabilityWarning> } | null
  if (failure?.code !== 'AVAILABILITY_WARNING') return null
  const data = failure.errors
  if (!data?.availabilityConfirmation || !Array.isArray(data.availabilityConflicts)) return null
  return {
    availabilityConfirmation: data.availabilityConfirmation,
    availabilityConflicts: data.availabilityConflicts,
    canOverrideAvailability: data.canOverrideAvailability === true,
  }
}

export const availabilityWeekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']
