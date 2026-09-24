import express, { Router, type Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { ApiError } from '../api-error.ts'
import { addRequestAttachment, deleteRequestAttachment, downloadRequestAttachment, MAX_REQUEST_FILE_BYTES } from './attachment-service.ts'
import { cancelRequest, createRequest, createRequestType, getRequest, listRequests, listRequestTypes, resolveRequest, updateRequest, updateRequestType } from './service.ts'
import { attachmentParams, createRequestBody, createRequestTypeBody, listRequestsQuery, organizationRequestParams, rejectRequestBody, requestParams, requestTypeParams, resolveRequestBody, updateRequestTypeBody } from './schemas.ts'

const router = Router()
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'TOO_MANY_REQUESTS', message: 'Слишком много изменений. Попробуйте через минуту.' } })
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'TOO_MANY_UPLOADS', message: 'Слишком много загрузок. Попробуйте позже.' } })
const fileBody = express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'], limit: MAX_REQUEST_FILE_BYTES })
router.use(requireAuth)

function auth(request: Request) { return (request as AuthenticatedRequest).auth! }
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте данные заявки.', z.flattenError(result.error).fieldErrors); return result.data }

router.get('/organizations/:organizationId/request-types', async (request, response) => { const { organizationId } = parse(organizationRequestParams, request.params); response.json({ types: await listRequestTypes(auth(request).userId, organizationId, request.query.includeInactive === 'true') }) })
router.post('/organizations/:organizationId/request-types', mutationLimiter, async (request, response) => { const { organizationId } = parse(organizationRequestParams, request.params); response.status(201).json({ type: await createRequestType(auth(request).userId, organizationId, parse(createRequestTypeBody, request.body)) }) })
router.patch('/organizations/:organizationId/request-types/:typeId', mutationLimiter, async (request, response) => { const { organizationId, typeId } = parse(requestTypeParams, request.params); response.json({ type: await updateRequestType(auth(request).userId, organizationId, typeId, parse(updateRequestTypeBody, request.body)) }) })

for (const scope of ['mine', 'incoming', 'history'] as const) router.get(`/organizations/:organizationId/requests/${scope}`, async (request, response) => { const { organizationId } = parse(organizationRequestParams, request.params); response.json(await listRequests(auth(request).userId, organizationId, scope, parse(listRequestsQuery, request.query))) })
router.post('/organizations/:organizationId/requests', mutationLimiter, async (request, response) => { const { organizationId } = parse(organizationRequestParams, request.params); response.status(201).json({ request: await createRequest(auth(request).userId, organizationId, parse(createRequestBody, request.body)) }) })
router.patch('/organizations/:organizationId/requests/:requestId', mutationLimiter, async (request, response) => { const { organizationId, requestId } = parse(requestParams, request.params); response.json({ request: await updateRequest(auth(request).userId, organizationId, requestId, parse(createRequestBody, request.body)) }) })
router.get('/organizations/:organizationId/requests/:requestId', async (request, response) => { const { organizationId, requestId } = parse(requestParams, request.params); response.json(await getRequest(auth(request).userId, organizationId, requestId)) })
router.post('/organizations/:organizationId/requests/:requestId/approve', mutationLimiter, async (request, response) => { const { organizationId, requestId } = parse(requestParams, request.params); const body = parse(resolveRequestBody, request.body); response.json({ request: await resolveRequest(auth(request).userId, organizationId, requestId, 'APPROVED', body.comment, body.cancelConflictingShifts) }) })
router.post('/organizations/:organizationId/requests/:requestId/reject', mutationLimiter, async (request, response) => { const { organizationId, requestId } = parse(requestParams, request.params); const body = parse(rejectRequestBody, request.body); response.json({ request: await resolveRequest(auth(request).userId, organizationId, requestId, 'REJECTED', body.comment) }) })
router.post('/organizations/:organizationId/requests/:requestId/cancel', mutationLimiter, async (request, response) => { const { organizationId, requestId } = parse(requestParams, request.params); await cancelRequest(auth(request).userId, organizationId, requestId); response.status(204).end() })
router.put('/organizations/:organizationId/requests/:requestId/attachments', uploadLimiter, fileBody, async (request, response) => { const { organizationId, requestId } = parse(requestParams, request.params); const attachment = await addRequestAttachment(auth(request).userId, organizationId, requestId, request.body, request.get('content-type')?.split(';')[0] ?? '', request.get('x-file-name')); response.status(201).json({ attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.storedFile.mimeType, size: attachment.storedFile.size } }) })
router.get('/organizations/:organizationId/requests/:requestId/attachments/:attachmentId', async (request, response) => { const { organizationId, requestId, attachmentId } = parse(attachmentParams, request.params); const { attachment, contents } = await downloadRequestAttachment(auth(request).userId, organizationId, requestId, attachmentId); response.set({ 'Content-Type': attachment.storedFile.mimeType, 'Content-Length': String(contents.length), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); response.send(contents) })
router.delete('/organizations/:organizationId/requests/:requestId/attachments/:attachmentId', mutationLimiter, async (request, response) => { const { organizationId, requestId, attachmentId } = parse(attachmentParams, request.params); await deleteRequestAttachment(auth(request).userId, organizationId, requestId, attachmentId); response.status(204).end() })

export default router
