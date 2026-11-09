import type { Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { storage } from '../storage/provider.ts'
import { freshFileAccess } from '../storage/guarded-delivery.ts'
import { adminPool } from './database.ts'
import { audit, requireAdminSession } from './security.ts'

/** Elevated access is limited to attached avatars, never arbitrary stored files. */
export async function adminAvatar(request: Request, response: Response) {
  const { actor, session } = await requireAdminSession(request)
  const fileId = z.uuid().parse(request.params.fileId)
  const lookup = () => prisma.storedFile.findFirst({
    where: { id: fileId, purpose: 'USER_AVATAR', pendingDeletionAt: null, purgedAt: null,
      userAvatar: { is: { deletedAt: null } } },
    select: { id: true, objectKey: true, mimeType: true },
  })
  const file = await lookup()
  if (!file) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
  let contents: Buffer
  try { contents = await storage.read(file.objectKey) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
    throw error
  }
  if (!await freshFileAccess(lookup)) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Изображение не найдено.')
  await requireAdminSession(request)
  await audit(adminPool(), actor.userId, 'MONITOR_VIEWED', 'SUCCEEDED', session.id, 'AVATAR', file.id)
  response.set({ 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie', 'X-Content-Type-Options': 'nosniff', 'Content-Type': file.mimeType, 'Content-Length': String(contents.length) })
  response.end(contents)
}
