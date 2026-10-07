import { z } from 'zod'
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const parsed = new Date(`${value}T12:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }, 'Некорректная дата')
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const optionalText = (limit: number) => z.string().trim().max(limit).nullable().optional().transform(value => value || null)
export const eventBody = z.object({
  title: z.string().trim().min(1).max(160), description: optionalText(4000), typeLabel: optionalText(80),
  startDate: date, startTime: time, endDate: date.nullable().optional(), endTime: time.nullable().optional(),
  place: optionalText(300), meetingUrl: optionalText(2048).refine(value => !value || /^https?:\/\//i.test(value) && z.url().safeParse(value).success, 'Используйте ссылку http или https'),
  shared: z.boolean(), locationIds: z.array(z.uuid()).max(50).default([]),
  audienceMode: z.enum(['ALL', 'ROLES', 'SELECTED']), audienceRoles: z.array(z.enum(['ADMIN', 'MEMBER'])).max(2).default([]), memberIds: z.array(z.uuid()).max(1000).default([]),
  refreshRecipients: z.boolean().default(false), revision: z.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  if (data.shared && data.locationIds.length || !data.shared && !data.locationIds.length) ctx.addIssue({ code: 'custom', path: ['locationIds'], message: 'Выберите точки или всю организацию' })
  if (Boolean(data.endDate) !== Boolean(data.endTime)) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Укажите дату и время окончания' })
  if (data.audienceMode === 'ROLES' && !data.audienceRoles.length) ctx.addIssue({ code: 'custom', path: ['audienceRoles'], message: 'Выберите роли' })
  if (data.audienceMode === 'SELECTED' && !data.memberIds.length) ctx.addIssue({ code: 'custom', path: ['memberIds'], message: 'Выберите сотрудников' })
})
export const eventParams = z.object({ organizationId: z.uuid(), eventId: z.uuid().optional() })
export const listEventsQuery = z.object({
  pointId: z.union([z.literal('all'), z.uuid()]).default('all'), tab: z.enum(['upcoming', 'past']).default('upcoming'),
  search: z.string().trim().max(160).default(''), page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10),
  from: date.optional(), to: date.optional(),
})
export const audienceQuery = z.object({ shared: z.enum(['true', 'false']).default('false'), locationIds: z.string().max(2000).default('').transform(value => value ? value.split(',') : []).pipe(z.array(z.uuid()).max(50)) })
export type EventInput = z.infer<typeof eventBody>
export type EventListOptions = z.infer<typeof listEventsQuery>
