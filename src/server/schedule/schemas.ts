import { z } from 'zod'

export const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}, 'Некорректная дата.')
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Некорректное время.')
const breakMinutes = z.coerce.number().int().min(0).max(10_080)
const description = z.union([z.string().trim().min(1).max(500), z.literal(''), z.null()]).transform((value) => value || null)

export const organizationParams = z.object({ organizationId: uuid })
export const shiftParams = organizationParams.extend({ shiftId: uuid })
export const memberWorkTimeParams = organizationParams.extend({ memberId: uuid })

export const scheduleRangeQuery = z.object({ from: date, to: date }).superRefine((value, context) => {
  const days = (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000
  if (days <= 0 || days > 62) context.addIssue({ code: 'custom', message: 'Диапазон расписания должен содержать от 1 до 62 дней.' })
})

export const shiftBody = z.object({
  memberId: uuid,
  startDate: date,
  startTime: time,
  endDate: date,
  endTime: time,
  breakMinutes: breakMinutes.optional().default(0),
  description,
})

export const cancelShiftBody = z.object({ reason: z.string().trim().min(3).max(500) })
export const actualShiftBody = z.object({
  startDate: date,
  startTime: time,
  endDate: date,
  endTime: time,
  breakMinutes: breakMinutes.optional().default(0),
  reason: z.string().trim().min(3).max(500),
})

export const historyPaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const statisticsQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  memberState: z.enum(['active', 'all', 'former']).default('active'),
  sort: z.enum(['name', 'workedMinutes', 'workedShifts', 'averageMinutes', 'plannedMinutes', 'plannedShifts']).default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).superRefine((value, context) => {
  if (Boolean(value.from) !== Boolean(value.to)) context.addIssue({ code: 'custom', message: 'Укажите обе границы периода.' })
  if (value.from && value.to && value.from >= value.to) context.addIssue({ code: 'custom', message: 'Конец периода должен быть позже начала.' })
})
