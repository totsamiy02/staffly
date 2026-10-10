import { Router, type Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { ApiError } from '../api-error.ts'
import { reportBody, templateBody, personnelBody } from './report-schemas.ts'
import { buildReport, previewReport, reportWorkbook, reportOptions, reportMembers, saveReportTemplate, deleteReportTemplate, updatePersonnelNumber } from './report-service.ts'

const router = Router()
router.use(requireAuth)
const heavyLimiter = rateLimit({ windowMs: 60000, limit: 60, keyGenerator: request => user(request), standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'TOO_MANY_REQUESTS', message: 'Слишком много запросов отчёта. Повторите через минуту.' } })
const exportLimiter = rateLimit({ windowMs: 60000, limit: 6, keyGenerator: request => user(request), standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'TOO_MANY_REQUESTS', message: 'Можно скачать до 6 отчётов за минуту. Повторите позже.' } })
const mutationLimiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false })
const params = z.object({ organizationId: z.uuid() })
const templateParams = params.extend({ templateId: z.uuid() })
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', result.error.issues[0]?.message ?? 'Проверьте настройки отчёта.'); return result.data }
const user = (request: Request) => (request as AuthenticatedRequest).auth!.userId
const base = '/organizations/:organizationId/statistics/reports'
router.get(base + '/options', async (request, response) => { const { organizationId } = parse(params, request.params); response.set('Cache-Control', 'no-store').json(await reportOptions(user(request), organizationId)) })
router.post(base + '/members', heavyLimiter, async (request, response) => { const { organizationId } = parse(params, request.params); response.set('Cache-Control', 'no-store').json(await reportMembers(user(request), organizationId, parse(reportBody, request.body))) })
router.post(base + '/preview', heavyLimiter, async (request, response) => { const { organizationId } = parse(params, request.params); response.set('Cache-Control', 'no-store').json(previewReport(await buildReport(user(request), organizationId, parse(reportBody, request.body)))) })
router.post(base + '/export', exportLimiter, async (request, response) => {
  const { organizationId } = parse(params, request.params), input = parse(reportBody, request.body)
  const report = await buildReport(user(request), organizationId, input), buffer = await reportWorkbook(report)
  response.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="Staffly_${input.from}_${input.to}.xlsx"`, 'Cache-Control': 'no-store' }).send(buffer)
})
router.post(base + '/templates', mutationLimiter, async (request, response) => { const { organizationId } = parse(params, request.params); response.status(201).json(await saveReportTemplate(user(request), organizationId, null, parse(templateBody, request.body))) })
router.put(base + '/templates/:templateId', mutationLimiter, async (request, response) => { const { organizationId, templateId } = parse(templateParams, request.params); response.json(await saveReportTemplate(user(request), organizationId, templateId, parse(templateBody, request.body))) })
router.delete(base + '/templates/:templateId', mutationLimiter, async (request, response) => { const { organizationId, templateId } = parse(templateParams, request.params); await deleteReportTemplate(user(request), organizationId, templateId); response.status(204).end() })
router.patch('/organizations/:organizationId/members/:memberId/personnel-number', mutationLimiter, async (request, response) => { const { organizationId, memberId } = parse(params.extend({ memberId: z.uuid() }), request.params); await updatePersonnelNumber(user(request), organizationId, memberId, parse(personnelBody, request.body).personnelNumber); response.status(204).end() })
export default router
