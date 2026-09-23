import { Router, type Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { ApiError } from '../api-error.ts'
import { actualShiftBody, cancelShiftBody, historyPaginationQuery, memberWorkTimeParams, organizationParams, scheduleRangeQuery, shiftBody, shiftParams, statisticsQuery } from './schemas.ts'
import { cancelShift, correctActualTime, createShift, getShift, listMyUpcomingShifts, listSchedule, listShiftNotifications, readShiftNotification, updateShift } from './service.ts'
import { memberStatistics, myStatistics, organizationStatistics } from './statistics.ts'

const router = Router()
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'TOO_MANY_REQUESTS', message: 'Слишком много изменений. Попробуйте через минуту.' } })
router.use(requireAuth)

router.get('/shift-notifications', async (request, response) => response.json({ notifications: await listShiftNotifications(auth(request).userId) }))
router.post('/shift-notifications/:shiftId/read', async (request, response) => {
  const { shiftId } = parse(z.object({ shiftId: z.string().uuid() }), request.params)
  await readShiftNotification(auth(request).userId, shiftId)
  response.status(204).end()
})

function auth(request: Request) { return (request as AuthenticatedRequest).auth! }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте данные расписания.', z.flattenError(result.error).fieldErrors)
  return result.data
}

router.get('/organizations/:organizationId/schedule', async (request, response) => {
  const { organizationId } = parse(organizationParams, request.params)
  const { from, to } = parse(scheduleRangeQuery, request.query)
  response.json(await listSchedule(auth(request).userId, organizationId, from, to))
})

router.get('/organizations/:organizationId/schedule/mine/upcoming', async (request, response) => {
  const { organizationId } = parse(organizationParams, request.params)
  response.json(await listMyUpcomingShifts(auth(request).userId, organizationId))
})

router.post('/organizations/:organizationId/shifts', mutationLimiter, async (request, response) => {
  const { organizationId } = parse(organizationParams, request.params)
  response.status(201).json({ shift: await createShift(auth(request).userId, organizationId, parse(shiftBody, request.body)) })
})

router.get('/organizations/:organizationId/shifts/:shiftId', async (request, response) => {
  const { organizationId, shiftId } = parse(shiftParams, request.params)
  const { page, limit } = parse(historyPaginationQuery, request.query)
  response.json({ shift: await getShift(auth(request).userId, organizationId, shiftId, page, limit) })
})

router.patch('/organizations/:organizationId/shifts/:shiftId', mutationLimiter, async (request, response) => {
  const { organizationId, shiftId } = parse(shiftParams, request.params)
  response.json({ shift: await updateShift(auth(request).userId, organizationId, shiftId, parse(shiftBody, request.body)) })
})

router.post('/organizations/:organizationId/shifts/:shiftId/cancel', mutationLimiter, async (request, response) => {
  const { organizationId, shiftId } = parse(shiftParams, request.params)
  const { reason } = parse(cancelShiftBody, request.body)
  response.json({ shift: await cancelShift(auth(request).userId, organizationId, shiftId, reason) })
})

router.post('/organizations/:organizationId/shifts/:shiftId/actual', mutationLimiter, async (request, response) => {
  const { organizationId, shiftId } = parse(shiftParams, request.params)
  response.json({ shift: await correctActualTime(auth(request).userId, organizationId, shiftId, parse(actualShiftBody, request.body)) })
})

router.get('/organizations/:organizationId/statistics/work-time', async (request, response) => {
  const { organizationId } = parse(organizationParams, request.params)
  response.json(await organizationStatistics(auth(request).userId, organizationId, parse(statisticsQuery, request.query)))
})

router.get('/organizations/:organizationId/members/:memberId/work-time', async (request, response) => {
  const { organizationId, memberId } = parse(memberWorkTimeParams, request.params)
  response.json(await memberStatistics(auth(request).userId, organizationId, memberId, parse(statisticsQuery, request.query)))
})

router.get('/organizations/:organizationId/me/work-time', async (request, response) => {
  const { organizationId } = parse(organizationParams, request.params)
  response.json(await myStatistics(auth(request).userId, organizationId, parse(statisticsQuery, request.query)))
})

export default router
