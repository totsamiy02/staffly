import express, { Router, type Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { ApiError } from '../api-error.ts'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { prisma } from '../db.ts'
import { organizationIdParams } from '../organizations/schemas.ts'
import { MAX_IMAGE_BYTES, removeOrganizationLogo, removeUserAvatar, replaceOrganizationLogo, replaceUserAvatar } from './image-service.ts'
import { readObject } from './local-file-storage.ts'

const router = Router()
const imageBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES })
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'TOO_MANY_UPLOADS', message: 'Слишком много загрузок. Попробуйте позже.' } })

function auth(request: Request) { return (request as AuthenticatedRequest).auth! }

router.get('/media/:fileId', async (request, response) => {
  const parsed = z.string().uuid().safeParse(request.params.fileId)
  if (!parsed.success) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
  const file = await prisma.storedFile.findFirst({ where: { id: parsed.data, purpose: { in: ['USER_AVATAR', 'ORGANIZATION_LOGO'] } } })
  if (!file) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
  let contents: Buffer
  try { contents = await readObject(file.objectKey) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
    throw error
  }
  const etag = `"${file.checksumSha256}"`
  if (request.get('if-none-match') === etag) { response.status(304).end(); return }
  response.set({ 'Content-Type': file.mimeType, 'Content-Length': String(contents.length), 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag })
  response.send(contents)
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
