import { Router, type Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { ApiError } from '../api-error.ts'
import { audienceQuery, eventBody, eventParams, listEventsQuery } from './schemas.ts'
import { cancelEvent, createEvent, eventMembers, getEvent, listEvents, updateEvent } from './service.ts'
const router = Router()
const base = '/organizations/:organizationId/events'
const mutate = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false })
function user(request: Request) { return (request as AuthenticatedRequest).auth!.userId }
function parse<T>(schema: z.ZodType<T>, value: unknown) { const result = schema.safeParse(value); if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте данные события.', z.flattenError(result.error).fieldErrors); return result.data }
router.use(base, requireAuth, (_request, response, next) => { response.set('Cache-Control', 'private, no-store'); next() })
router.get(`${base}/members`, async (request, response) => { const { organizationId } = parse(eventParams, request.params), { shared, locationIds } = parse(audienceQuery, request.query); response.json(await eventMembers(user(request), organizationId, shared === 'true', locationIds)) })
router.get(base, async (request, response) => { const { organizationId } = parse(eventParams, request.params); response.json(await listEvents(user(request), organizationId, parse(listEventsQuery, request.query))) })
router.post(base, mutate, async (request, response) => { const { organizationId } = parse(eventParams, request.params); response.status(201).json({ event: await createEvent(user(request), organizationId, parse(eventBody, request.body)) }) })
router.get(`${base}/:eventId`, async (request, response) => { const { organizationId, eventId } = parse(eventParams, request.params); response.json({ event: await getEvent(user(request), organizationId, eventId!) }) })
router.patch(`${base}/:eventId`, mutate, async (request, response) => { const { organizationId, eventId } = parse(eventParams, request.params); response.json({ event: await updateEvent(user(request), organizationId, eventId!, parse(eventBody, request.body)) }) })
router.post(`${base}/:eventId/cancel`, mutate, async (request, response) => { const { organizationId, eventId } = parse(eventParams, request.params), { revision } = parse(z.object({ revision: z.number().int().positive() }), request.body); response.json({ event: await cancelEvent(user(request), organizationId, eventId!, revision) }) })
export default router
