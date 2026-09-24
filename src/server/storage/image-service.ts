import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { deleteObject, writeObject } from './local-file-storage.ts'
import { getMembership } from '../organizations/permissions.ts'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_INPUT_PIXELS = 25_000_000
const allowedFormats = new Set(['jpeg', 'png', 'webp'])

export function mediaUrl(fileId: string | null | undefined) {
  return fileId ? `/api/media/${fileId}` : null
}

async function normalizeImage(input: unknown) {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new ApiError(400, 'EMPTY_IMAGE', 'Выберите изображение для загрузки.')
  if (input.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Изображение должно весить не больше 8 МБ.')

  try {
    const source = sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
    const metadata = await source.metadata()
    if (!metadata.format || !allowedFormats.has(metadata.format)) throw new ApiError(415, 'UNSUPPORTED_IMAGE', 'Поддерживаются только JPEG, PNG и WebP.')
    if (!metadata.width || !metadata.height) throw new ApiError(400, 'INVALID_IMAGE', 'Не удалось определить размеры изображения.')
    if ((metadata.pages ?? 1) > 1) throw new ApiError(415, 'ANIMATED_IMAGE_NOT_ALLOWED', 'Анимированные изображения не поддерживаются.')

    const output = await source
      .rotate()
      .resize(512, 512, { fit: 'cover', position: 'centre', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer()

    return { buffer: output, checksum: createHash('sha256').update(output).digest('hex') }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'INVALID_IMAGE', 'Файл повреждён или не является допустимым изображением.')
  }
}

type RemoveObject = (objectKey: string) => Promise<void>

export async function deletePendingFile(fileId: string, removeObject: RemoveObject = deleteObject) {
  const file = await prisma.storedFile.findFirst({ where: { id: fileId, pendingDeletionAt: { not: null } } })
  if (!file) return true
  try {
    await removeObject(file.objectKey)
    await prisma.storedFile.deleteMany({ where: { id: file.id, pendingDeletionAt: { not: null } } })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown storage deletion error'
    await prisma.storedFile.updateMany({
      where: { id: file.id, pendingDeletionAt: { not: null } },
      data: { deletionAttempts: { increment: 1 }, lastDeletionError: message.slice(0, 500) },
    }).catch((databaseError) => console.error('Failed to record image cleanup error:', databaseError))
    return false
  }
}

export async function cleanupPendingFiles(options: { limit?: number; removeObject?: RemoveObject } = {}) {
  const files = await prisma.storedFile.findMany({
    where: { pendingDeletionAt: { not: null } },
    orderBy: { pendingDeletionAt: 'asc' },
    take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    select: { id: true },
  })
  let deleted = 0
  for (const file of files) if (await deletePendingFile(file.id, options.removeObject)) deleted += 1
  return { checked: files.length, deleted }
}

export function startStorageCleanup() {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try { await cleanupPendingFiles() }
    catch (error) { console.error('Pending image cleanup failed:', error) }
    finally { running = false }
  }
  void run()
  const timer = setInterval(() => void run(), 10 * 60 * 1000)
  timer.unref()
  return () => clearInterval(timer)
}

export async function replaceUserAvatar(userId: string, input: unknown) {
  const image = await normalizeImage(input)
  const objectKey = `users/${userId}/avatars/${randomUUID()}.webp`
  await writeObject(objectKey, image.buffer)
  let stored: { file: { id: string }; previousId: string | null }
  try {
    stored = await prisma.$transaction(async (tx) => {
      const previous = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarFileId: true } })
      const file = await tx.storedFile.create({
        data: { objectKey, mimeType: 'image/webp', size: image.buffer.length, checksumSha256: image.checksum, purpose: 'USER_AVATAR', uploadedByUserId: userId },
      })
      await tx.user.update({ where: { id: userId }, data: { avatarFileId: file.id } })
      if (previous.avatarFileId) await tx.storedFile.updateMany({ where: { id: previous.avatarFileId }, data: { pendingDeletionAt: new Date(), lastDeletionError: null } })
      return { file, previousId: previous.avatarFileId }
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    await deleteObject(objectKey).catch(() => undefined)
    throw error
  }
  if (stored.previousId) await deletePendingFile(stored.previousId).catch((error) => console.error('Immediate avatar cleanup failed:', error))
  return mediaUrl(stored.file.id)
}

export async function removeUserAvatar(userId: string) {
  const fileId = await prisma.$transaction(async (tx) => {
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarFileId: true } })
    if (!current.avatarFileId) return null
    await tx.user.update({ where: { id: userId }, data: { avatarFileId: null } })
    await tx.storedFile.update({ where: { id: current.avatarFileId }, data: { pendingDeletionAt: new Date(), lastDeletionError: null } })
    return current.avatarFileId
  }, { isolationLevel: 'Serializable' })
  if (fileId) await deletePendingFile(fileId).catch((error) => console.error('Immediate avatar deletion failed:', error))
}

async function requireOrganizationEditor(userId: string, organizationId: string) {
  const membership = await getMembership(userId, organizationId)
  if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Изменять логотип могут владелец и администраторы.')
}

export async function replaceOrganizationLogo(userId: string, organizationId: string, input: unknown) {
  await requireOrganizationEditor(userId, organizationId)
  const image = await normalizeImage(input)
  const objectKey = `organizations/${organizationId}/logos/${randomUUID()}.webp`
  await writeObject(objectKey, image.buffer)
  let stored: { file: { id: string }; previousId: string | null }
  try {
    stored = await prisma.$transaction(async (tx) => {
      const previous = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { logoFileId: true } })
      const file = await tx.storedFile.create({
        data: { objectKey, mimeType: 'image/webp', size: image.buffer.length, checksumSha256: image.checksum, purpose: 'ORGANIZATION_LOGO', uploadedByUserId: userId, organizationId },
      })
      await tx.organization.update({ where: { id: organizationId }, data: { logoFileId: file.id } })
      if (previous.logoFileId) await tx.storedFile.updateMany({ where: { id: previous.logoFileId }, data: { pendingDeletionAt: new Date(), lastDeletionError: null } })
      return { file, previousId: previous.logoFileId }
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    await deleteObject(objectKey).catch(() => undefined)
    throw error
  }
  if (stored.previousId) await deletePendingFile(stored.previousId).catch((error) => console.error('Immediate organization logo cleanup failed:', error))
  return mediaUrl(stored.file.id)
}

export async function removeOrganizationLogo(userId: string, organizationId: string) {
  await requireOrganizationEditor(userId, organizationId)
  const fileId = await prisma.$transaction(async (tx) => {
    const current = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { logoFileId: true } })
    if (!current.logoFileId) return null
    await tx.organization.update({ where: { id: organizationId }, data: { logoFileId: null } })
    await tx.storedFile.update({ where: { id: current.logoFileId }, data: { pendingDeletionAt: new Date(), lastDeletionError: null } })
    return current.logoFileId
  }, { isolationLevel: 'Serializable' })
  if (fileId) await deletePendingFile(fileId).catch((error) => console.error('Immediate organization logo deletion failed:', error))
}
