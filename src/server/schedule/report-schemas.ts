import { z } from 'zod'
import { reportConfigError, reportSheets, normalizeReportConfig } from '../../app/schedule/reporting.ts'

export const reportConfigSchema = z.object({
  sheets: z.array(z.object({ key: z.enum(reportSheets), enabled: z.boolean(), columns: z.array(z.object({ key: z.string().max(40), title: z.string().trim().min(1).max(80) }).strict()).max(20) }).strict()).min(1).max(4),
  totals: z.boolean(),
  layout: z.enum(['report', 'table']).optional(),
}).strict().transform(normalizeReportConfig).superRefine((value, context) => { const error = reportConfigError(value); if (error) context.addIssue({ code: 'custom', message: error }) })
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const parsed = new Date(`${value}T00:00:00Z`); return Number(value.slice(0, 4)) >= 1900 && Number(value.slice(0, 4)) <= 9998 && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }, 'Некорректная дата.')
export const reportBody = z.object({ from: date, to: date, locationIds: z.array(z.uuid()).max(50), memberIds: z.array(z.uuid()).max(1000), includeFormer: z.boolean(), config: reportConfigSchema, templateId: z.uuid().optional() }).strict().superRefine((value, context) => {
  const days = (Date.parse(value.to) - Date.parse(value.from)) / 86400000 + 1
  if (days < 1 || days > 366) context.addIssue({ code: 'custom', message: 'Выберите включительный период от 1 до 366 дней.' })
  if (new Set(value.locationIds).size !== value.locationIds.length || new Set(value.memberIds).size !== value.memberIds.length) context.addIssue({ code: 'custom', message: 'Точки и сотрудники не должны повторяться.' })
})
export const templateBody = z.object({ name: z.string().trim().min(1).max(80), config: reportConfigSchema }).strict()
