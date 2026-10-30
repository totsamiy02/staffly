import { canReadAvatar } from './media-access.ts'
import express, { Router, type Request } from 'express'
import { accountRateLimit } from '../security/rate-limit.ts'
import { z } from 'zod'
import { ApiError } from '../api-error.ts'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { prisma } from '../db.ts'
import { organizationIdParams } from '../organizations/schemas.ts'
import { MAX_IMAGE_BYTES, removeOrganizationLogo, removeUserAvatar, replaceOrganizationLogo, replaceUserAvatar, stageProfileImage } from './image-service.ts'
import { storage } from './provider.ts'

const router = Router()
const imageBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES })
const uploadLimiter = accountRateLimit('image-uploads', 20, 900000)

function auth(request: Request) { return (request as AuthenticatedRequest).auth! }

router.get(['/media/:fileId', '/media/v2/:fileId'], async (request, response, next) => {
  response.set({ 'Cache-Control': 'private, no-store', 'Vary': 'Authorization', 'X-Content-Type-Options': 'nosniff' })
  const parsed = z.string().uuid().safeParse(request.params.fileId)
  if (!parsed.success) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
  const file = await prisma.storedFile.findFirst({ where: { id: parsed.data, pendingDeletionAt: null, purpose: { in: ['USER_AVATAR', 'ORGANIZATION_LOGO'] } } })
  if (!file) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
  response.locals.file = file
  if (file.purpose === 'USER_AVATAR') return requireAuth(request, response, next)
  next()
}, async (request, response) => {
  const file = response.locals.file as import('../../generated/prisma/client.ts').StoredFile
  if (file.purpose === 'USER_AVATAR') {
    if (!await canReadAvatar(auth(request).userId, file.id)) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
  } else if (!await prisma.organization.count({ where: { logoFileId: file.id, deletedAt: null } })) {
    throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
  }
  let contents: Buffer
  try { contents = await storage.read(file.objectKey) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
    throw error
  }
  response.set({ 'Content-Type': file.mimeType, 'Content-Length': String(contents.length) })
  response.end(contents) // Avoid Express generating an ETag/304 for private image bytes.
})

router.put('/profile/avatar/stage', requireAuth, uploadLimiter, imageBody, async (request, response) => {
  const file = await stageProfileImage(auth(request).userId, request.body)
  response.status(201).json({ uploadId: file.id })
})
router.put('/organizations/:organizationId/logo/stage', requireAuth, uploadLimiter, imageBody, async (request, response) => {
  const { organizationId } = organizationIdParams.parse(request.params)
  const file = await stageProfileImage(auth(request).userId, request.body, organizationId)
  response.status(201).json({ uploadId: file.id })
})
router.put('/profile/avatar', requireAuth, uploadLimiter, imageBody, async (request, response) => {
  const avatarUrl = await replaceUserAvatar(auth(request).userId, request.body)
  response.json({ avatarUrl })
})

router.delete('/profile/avatar', requireAuth, async (request, response) => {
  await removeUserAvatar(auth(request).userId)
  response.status(204).end()
})

router.put('/organizations/:organizationId/logo', requireAuth, uploadLimiter, imageBody, async (request, response) => {
  const parsed = organizationIdParams.safeParse(request.params)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Некорректный идентификатор организации.')
  const logoUrl = await replaceOrganizationLogo(auth(request).userId, parsed.data.organizationId, request.body)
  response.json({ logoUrl })
})

router.delete('/organizations/:organizationId/logo', requireAuth, async (request, response) => {
  const parsed = organizationIdParams.safeParse(request.params)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Некорректный идентификатор организации.')
  await removeOrganizationLogo(auth(request).userId, parsed.data.organizationId)
  response.status(204).end()
})

export default router
