import { safeError } from '../security/safe-error.ts'
import { storageQuotaError } from '../resources/quotas.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { requirePermission } from '../organizations/access/access.ts'
import { createHash, randomUUID } from 'node:crypto'
import { processFile } from '../file-processing/client.ts'
import { prisma } from '../db.ts'
import { startBackgroundTask } from '../background-task.ts'
import { ApiError } from '../api-error.ts'
import type { StoredFilePurpose } from '../../generated/prisma/enums.ts'
import { storage } from './provider.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { freshFileAccess } from './guarded-delivery.ts'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function mediaUrl(fileId: string | null | undefined) {
  return fileId ? `/api/media/v2/${fileId}` : null
}

async function normalizeImage(input: unknown) {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new ApiError(400, 'EMPTY_IMAGE', 'Выберите изображение для загрузки.')
  if (input.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Изображение должно весить не больше 8 МБ.')

  let output: Buffer
  try { output = await processFile('avatar', 'auto', input) }
  catch (error) {
    if (error instanceof ApiError && error.code === 'INVALID_DOCUMENT_FILE') throw new ApiError(400, 'INVALID_IMAGE', 'Файл повреждён или не является допустимым изображением.')
    throw error
  }
  return { buffer: output, checksum: createHash('sha256').update(output).digest('hex') }
}

type RemoveObject = (objectKey: string) => Promise<void>

export async function deletePendingFile(fileId: string, removeObject: RemoveObject = storage.delete) {
  const file = await prisma.storedFile.findFirst({ where: { id: fileId, pendingDeletionAt: { not: null }, purgedAt: null }, include: { document: { select: { deletedAt: true } } } })
  if (!file) return true
  // A bound active document must never lose its content through the cleanup queue.
  if (file.document && !file.document.deletedAt) return false
  try {
    await removeObject(file.objectKey)
    if (file.document) {
      await prisma.$transaction(async tx => {
        const now = new Date()
        const changed = await tx.storedFile.updateMany({ where: { id: file.id, pendingDeletionAt: { not: null }, purgedAt: null }, data: { purgedAt: now, pendingDeletionAt: null, lastDeletionError: null } })
        // The document update also emits its existing live hint, including worker retries.
        if (changed.count) await tx.document.updateMany({ where: { storedFileId: file.id, deletedAt: { not: null } }, data: { updatedAt: now } })
      })
    } else await prisma.storedFile.deleteMany({ where: { id: file.id, pendingDeletionAt: { not: null } } })
    return true
  } catch (error) {
    const message = JSON.stringify(safeError(error))
    await prisma.storedFile.updateMany({
      where: { id: file.id, pendingDeletionAt: { not: null } },
      data: { deletionAttempts: { increment: 1 }, lastDeletionError: message },
    }).catch((databaseError) => console.error('Failed to record image cleanup error:', safeError(databaseError)))
    return false
  }
}

export async function cleanupPendingFiles(options: { limit?: number; removeObject?: RemoveObject } = {}) {
  const files = await prisma.storedFile.findMany({
    where: { pendingDeletionAt: { lte: new Date() } },
    orderBy: { pendingDeletionAt: 'asc' },
    take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    select: { id: true },
  })
  let deleted = 0
  for (const file of files) if (await deletePendingFile(file.id, options.removeObject)) deleted += 1
  return { checked: files.length, deleted }
}

// Register an upload intent before disk writes. A crashed process leaves a durable
// cleanup record; successful binding clears it atomically with the owning object.
export async function stageStoredFile(data: { objectKey: string; mimeType: string; size: number; checksumSha256: string; purpose: StoredFilePurpose; uploadedByUserId: string; organizationId?: string }, contents: Buffer) {
  if (!Number.isSafeInteger(data.size) || data.size !== contents.length) throw new Error('Stored file size must match its bytes')
  const file = await prisma.storedFile.create({ data: { ...data, pendingDeletionAt: new Date(Date.now() + 60 * 60 * 1000) } }).catch(storageQuotaError)
  try { await storage.put(file.objectKey, contents); return file }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') await prisma.storedFile.delete({ where: { id: file.id } })
    else await deletePendingFile(file.id)
    throw error
  }
}

export function startStorageCleanup() {
  return startBackgroundTask({ name: 'Pending image cleanup', intervalMs: 10 * 60_000, run: () => cleanupPendingFiles() })
}

export async function stageProfileImage(userId: string, input: unknown, organizationId?: string) {
  if (organizationId) await requireOrganizationEditor(userId, organizationId)
  const image = await normalizeImage(input)
  if (organizationId) await freshFileAccess(() => requireOrganizationEditor(userId, organizationId))
  const purpose = organizationId ? 'ORGANIZATION_LOGO' : 'USER_AVATAR'
  const objectKey = organizationId ? `organizations/${organizationId}/logos/${randomUUID()}.webp` : `users/${userId}/avatars/${randomUUID()}.webp`
  return stageStoredFile({ objectKey, mimeType: 'image/webp', size: image.buffer.length, checksumSha256: image.checksum, purpose, uploadedByUserId: userId, organizationId }, image.buffer)
}

// The owning profile row must be locked by the caller. Binding and profile fields
// commit together; an abandoned upload retains the existing cleanup deadline.
export async function bindProfileImage(tx: Prisma.TransactionClient, userId: string, previousId: string | null, uploadId: string | null, organizationId?: string) {
  if (uploadId) {
    const changed = await tx.storedFile.updateMany({ where: { id: uploadId, uploadedByUserId: userId, organizationId: organizationId ?? null,
      purpose: organizationId ? 'ORGANIZATION_LOGO' : 'USER_AVATAR', pendingDeletionAt: { gt: new Date() } }, data: { pendingDeletionAt: null } })
    if (!changed.count) throw new ApiError(409, 'IMAGE_UPLOAD_UNAVAILABLE', 'Выбранное фото больше недоступно. Выберите его заново.')
  }
  if (previousId && previousId !== uploadId) await tx.storedFile.updateMany({ where: { id: previousId }, data: { pendingDeletionAt: new Date(), lastDeletionError: null } })
  return uploadId
}

export async function replaceUserAvatar(userId: string, input: unknown) {
  const image = await normalizeImage(input)
  const objectKey = `users/${userId}/avatars/${randomUUID()}.webp`
  const staged = await stageStoredFile({ objectKey, mimeType: 'image/webp', size: image.buffer.length, checksumSha256: image.checksum, purpose: 'USER_AVATAR', uploadedByUserId: userId }, image.buffer)
  let stored: { file: { id: string }; previousId: string | null }
  try {
    stored = await prisma.$transaction(async (tx) => {
      const previous = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarFileId: true } })
      const file = await tx.storedFile.update({ where: { id: staged.id }, data: { pendingDeletionAt: null } })
      await tx.user.update({ where: { id: userId }, data: { avatarFileId: file.id } })
      if (previous.avatarFileId) await tx.storedFile.updateMany({ where: { id: previous.avatarFileId }, data: { pendingDeletionAt: new Date(), lastDeletionError: null } })
      return { file, previousId: previous.avatarFileId }
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    await deletePendingFile(staged.id)
    throw error
  }
  if (stored.previousId) await deletePendingFile(stored.previousId).catch((error) => console.error('Immediate avatar cleanup failed:', safeError(error)))
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
  if (fileId) await deletePendingFile(fileId).catch((error) => console.error('Immediate avatar deletion failed:', safeError(error)))
}

async function requireOrganizationEditor(userId: string, organizationId: string) {
  const membership = await getMembership(userId, organizationId)
  requirePermission(membership, 'organization.edit', null)
}

export async function replaceOrganizationLogo(userId: string, organizationId: string, input: unknown) {
  await requireOrganizationEditor(userId, organizationId)
  const image = await normalizeImage(input)
  const objectKey = `organizations/${organizationId}/logos/${randomUUID()}.webp`
  const staged = await stageStoredFile({ objectKey, mimeType: 'image/webp', size: image.buffer.length, checksumSha256: image.checksum, purpose: 'ORGANIZATION_LOGO', uploadedByUserId: userId, organizationId }, image.buffer)
  let stored: { file: { id: string }; previousId: string | null }
  try {
    stored = await prisma.$transaction(async (tx) => {
      requirePermission(await getMembership(userId, organizationId, tx), 'organization.edit', null)
      const previous = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { logoFileId: true } })
      const file = await tx.storedFile.update({ where: { id: staged.id }, data: { pendingDeletionAt: null } })
      await tx.organization.update({ where: { id: organizationId }, data: { logoFileId: file.id } })
      if (previous.logoFileId) await tx.storedFile.updateMany({ where: { id: previous.logoFileId }, data: { pendingDeletionAt: new Date(), lastDeletionError: null } })
      return { file, previousId: previous.logoFileId }
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    await deletePendingFile(staged.id)
    throw error
  }
  if (stored.previousId) await deletePendingFile(stored.previousId).catch((error) => console.error('Immediate organization logo cleanup failed:', safeError(error)))
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
  if (fileId) await deletePendingFile(fileId).catch((error) => console.error('Immediate organization logo deletion failed:', safeError(error)))
}
