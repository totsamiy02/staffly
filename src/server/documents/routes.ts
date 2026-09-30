import express, { Router, type Request } from 'express'
import { z } from 'zod'
import { rateLimit } from 'express-rate-limit'
import { pipeline } from 'node:stream/promises'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { ApiError } from '../api-error.ts'
import { assignSchema, folderSchema, listSchema, metadataSchema, paramsSchema } from './schemas.ts'
import { MAX_DOCUMENT_BYTES } from './file-validation.ts'
import { acknowledgeDocument, assignAcknowledgements, cancelAcknowledgement, deleteDocument, deleteFolder, deliverDocument, documentMembers, documentProgress, getDocument, listDocuments, personalDocuments, recordDocumentOpened, saveFolder, setFolderPinned, updateDocument, uploadDocument } from './service.ts'
const router = Router()
const mutate = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false })
const upload = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false })
const body = express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES })
const base = '/organizations/:organizationId/documents'
function user(request: Request) { return (request as AuthenticatedRequest).auth!.userId }
function parse<T>(schema: z.ZodType<T>, value: unknown) { const parsed = schema.safeParse(value); if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте данные документа.', z.flattenError(parsed.error).fieldErrors); return parsed.data }
// Authentication is scoped to these endpoints; unrelated public routes stay unchanged.
router.use(['/profile/documents', '/organizations/:organizationId/documents', '/organizations/:organizationId/document-folders', '/organizations/:organizationId/documents-members'], requireAuth, (_request, response, next) => { response.set('Cache-Control', 'private, no-store'); next() })
router.get('/profile/documents', async (request, response) => { const { page, search } = parse(listSchema, request.query); const organizationId = typeof request.query.organizationId === 'string' ? parse(z.uuid(), request.query.organizationId) : undefined; response.json(await personalDocuments(user(request), page, search, organizationId)) })
router.get('/organizations/:organizationId/documents-members', async (request, response) => { const { organizationId } = parse(paramsSchema, request.params); response.json({ members: await documentMembers(user(request), organizationId) }) })
router.get(base, async (request, response) => { const { organizationId } = parse(paramsSchema, request.params); response.json(await listDocuments(user(request), organizationId, parse(listSchema, request.query))) })
router.put(base, upload, body, async (request, response) => {
  const { organizationId } = parse(paramsSchema, request.params)
  const data = parse(metadataSchema, { displayName: request.query.displayName, folderId: request.query.folderId ?? null, visibility: request.query.visibility, targetMemberId: request.query.targetMemberId ?? null })
  response.status(201).json({ document: await uploadDocument(user(request), organizationId, request.body, request.get('content-type')?.split(';')[0] ?? '', request.get('x-file-name'), data) })
})
router.get(`${base}/:documentId`, async (request, response) => { const { organizationId, documentId } = parse(paramsSchema, request.params); response.json({ document: await getDocument(user(request), organizationId, documentId!) }) })
router.patch(`${base}/:documentId`, mutate, async (request, response) => { const { organizationId, documentId } = parse(paramsSchema, request.params); await updateDocument(user(request), organizationId, documentId!, parse(metadataSchema, request.body)); response.status(204).end() })
router.delete(`${base}/:documentId`, mutate, async (request, response) => { const { organizationId, documentId } = parse(paramsSchema, request.params); await deleteDocument(user(request), organizationId, documentId!); response.status(204).end() })
router.post(`${base}/:documentId/content`, async (request, response) => {
  const { organizationId, documentId } = parse(paramsSchema, request.params)
  const { action } = parse(z.object({ action: z.enum(['preview', 'download']) }), request.query)
  const actor = user(request), file = await deliverDocument(actor, organizationId, documentId!, action)
  const ascii = file.fileName.replace(/[^a-zA-Z0-9._ -]/g, '_')
  response.set({ 'Content-Type': file.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : file.mimeType, 'Content-Length': String(file.size), 'Content-Disposition': `${action === 'preview' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16))}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" })
  // No GET/HEAD content endpoint: link prefetches cannot mark documents opened.
  try {
    await pipeline(file.stream, response)
    if (!response.destroyed || response.writableFinished) await recordDocumentOpened(actor, organizationId, documentId!).catch(error => console.error('Document delivery status failed:', error))
  } catch (error) { file.stream.destroy(); if (!response.headersSent) throw error }
})
router.post(`${base}/:documentId/assign`, mutate, async (request, response) => { const { organizationId, documentId } = parse(paramsSchema, request.params); response.json(await assignAcknowledgements(user(request), organizationId, documentId!, parse(assignSchema, request.body))) })
router.post(`${base}/:documentId/acknowledge`, mutate, async (request, response) => { const { organizationId, documentId } = parse(paramsSchema, request.params); await acknowledgeDocument(user(request), organizationId, documentId!); response.status(204).end() })
router.post(`${base}/:documentId/cancel`, mutate, async (request, response) => { const { organizationId, documentId } = parse(paramsSchema, request.params); await cancelAcknowledgement(user(request), organizationId, documentId!); response.status(204).end() })
router.post(`${base}/:documentId/acknowledgements/:acknowledgementId/cancel`, mutate, async (request, response) => { const { organizationId, documentId, acknowledgementId } = parse(paramsSchema, request.params); await cancelAcknowledgement(user(request), organizationId, documentId!, acknowledgementId!); response.status(204).end() })
router.get(`${base}/:documentId/progress`, async (request, response) => { const { organizationId, documentId } = parse(paramsSchema, request.params); const { page } = parse(listSchema, request.query); response.json(await documentProgress(user(request), organizationId, documentId!, page)) })
router.post('/organizations/:organizationId/document-folders', mutate, async (request, response) => { const { organizationId } = parse(paramsSchema, request.params); response.status(201).json({ folder: await saveFolder(user(request), organizationId, undefined, parse(folderSchema, request.body)) }) })
router.patch('/organizations/:organizationId/document-folders/:folderId', mutate, async (request, response) => { const { organizationId, folderId } = parse(paramsSchema, request.params); response.json({ folder: await saveFolder(user(request), organizationId, folderId!, parse(folderSchema, request.body)) }) })
router.put('/organizations/:organizationId/document-folders/:folderId/pin', mutate, async (request, response) => { const { organizationId, folderId } = parse(paramsSchema, request.params); await setFolderPinned(user(request), organizationId, folderId!, true); response.status(204).end() })
router.delete('/organizations/:organizationId/document-folders/:folderId/pin', mutate, async (request, response) => { const { organizationId, folderId } = parse(paramsSchema, request.params); await setFolderPinned(user(request), organizationId, folderId!, false); response.status(204).end() })
router.delete('/organizations/:organizationId/document-folders/:folderId', mutate, async (request, response) => { const { organizationId, folderId } = parse(paramsSchema, request.params); await deleteFolder(user(request), organizationId, folderId!); response.status(204).end() })
export default router
