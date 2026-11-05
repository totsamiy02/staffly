import { auditSensitiveAccess } from '../../security/journal.ts'
import { Router, type Request } from 'express'
import { accountRateLimit } from '../../security/rate-limit.ts'
import { z } from 'zod'
import { requireAuth, assertActiveSession, type AuthenticatedRequest } from '../../auth.ts'
import { ApiError } from '../../api-error.ts'
import { reportBody, templateBody } from './report-schemas.ts'
import { buildReport, previewReport, reportOptions, reportMembers, saveReportTemplate, deleteReportTemplate } from './report-service.ts'
import { enqueueExport, getExport, exportForRequest } from './export-jobs.ts'
import { storage } from '../../storage/provider.ts'
import { pipeline } from 'node:stream/promises'
import { freshFileAccess, guardFileStream } from '../../storage/guarded-delivery.ts'

const router = Router()
router.use(requireAuth)
const heavyLimiter = accountRateLimit('report-preview', 60, 60000)
const exportLimiter = accountRateLimit('report-export', 6, 60000)
const mutationLimiter = accountRateLimit('report-templates', 60, 60000)
const params = z.object({ organizationId: z.uuid() })
const templateParams = params.extend({ templateId: z.uuid() })
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', result.error.issues[0]?.message ?? 'Проверьте настройки отчёта.'); return result.data }
const user = (request: Request) => (request as AuthenticatedRequest).auth!.userId
const base = '/organizations/:organizationId/statistics/reports'
router.get(base + '/options', async (request, response) => { const { organizationId } = parse(params, request.params); response.set('Cache-Control', 'no-store').json(await reportOptions(user(request), organizationId)) })
router.post(base + '/members', heavyLimiter, async (request, response) => { const { organizationId } = parse(params, request.params); response.set('Cache-Control', 'no-store').json(await reportMembers(user(request), organizationId, parse(reportBody, request.body))) })
router.post(base + '/preview', heavyLimiter, async (request, response) => { const { organizationId } = parse(params, request.params); response.set('Cache-Control', 'no-store').json(previewReport(await auditSensitiveAccess({ action: 'REPORT_PREVIEW', userId: user(request), organizationId }, () => buildReport(user(request), organizationId, parse(reportBody, request.body))))) })
router.post(base + '/export', exportLimiter, async (request, response) => {
  const { organizationId } = parse(params, request.params)
  const requestKey = parse(z.uuid().optional(), request.body?.requestKey)
  const { requestKey: _key, ...body } = request.body ?? {}
  const input = parse(reportBody, body)
  const event = { action: 'REPORT_EXPORT' as const, userId: user(request), organizationId, resourceType: 'EXPORT' as const, resourceId: undefined as string | undefined }
  const job = await auditSensitiveAccess(event, async () => { const job = await enqueueExport(user(request), organizationId, input, requestKey); event.resourceId = job.id; return job })
  response.status(202).set('Cache-Control', 'no-store').json({ job })
})
router.get(base + '/exports/request/:requestKey', async (request, response) => {
  const { organizationId, requestKey } = parse(params.extend({ requestKey: z.uuid() }), request.params)
  response.set('Cache-Control', 'no-store').json((await exportForRequest(user(request), organizationId, requestKey)).public)
})
router.get(base + '/exports/:jobId', async (request, response) => {
  const { organizationId, jobId } = parse(params.extend({ jobId: z.uuid() }), request.params)
  response.set('Cache-Control', 'no-store').json((await getExport(user(request), organizationId, jobId)).public)
})
router.get(base + '/exports/:jobId/content', async (request, response) => {
  const { organizationId, jobId } = parse(params.extend({ jobId: z.uuid() }), request.params)
  const { job } = await auditSensitiveAccess({ action: 'EXPORT_DOWNLOAD', userId: user(request), organizationId, resourceType: 'EXPORT', resourceId: jobId }, () => getExport(user(request), organizationId, jobId))
  if (job.status !== 'READY' || !job.objectKey) throw new ApiError(409, 'EXPORT_NOT_READY', 'Отчёт ещё готовится.')
  const object = await storage.stream(job.objectKey)
  const authorize = async () => { await assertActiveSession((request as AuthenticatedRequest).auth!); return getExport(user(request), organizationId, jobId) }
  const stream = guardFileStream(object.stream, authorize)
  try { await freshFileAccess(authorize) }
  catch (error) { stream.destroy(); object.stream.destroy(); throw error }
  response.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="Staffly.xlsx"', 'Content-Length': String(object.size), 'Cache-Control': 'private, no-store' })
  await pipeline(stream, response)
})
router.post(base + '/templates', mutationLimiter, async (request, response) => { const { organizationId } = parse(params, request.params); response.status(201).json(await saveReportTemplate(user(request), organizationId, null, parse(templateBody, request.body))) })
router.put(base + '/templates/:templateId', mutationLimiter, async (request, response) => { const { organizationId, templateId } = parse(templateParams, request.params); response.json(await saveReportTemplate(user(request), organizationId, templateId, parse(templateBody, request.body))) })
router.delete(base + '/templates/:templateId', mutationLimiter, async (request, response) => { const { organizationId, templateId } = parse(templateParams, request.params); await deleteReportTemplate(user(request), organizationId, templateId); response.status(204).end() })
export default router
