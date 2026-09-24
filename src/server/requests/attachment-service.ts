import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { deleteObject, readObject, writeObject } from '../storage/local-file-storage.ts'
import { assertRequestFileAccess } from './service.ts'
import { deletePendingFile } from '../storage/image-service.ts'

export const MAX_REQUEST_FILE_BYTES = 10 * 1024 * 1024
const allowed = new Map([['application/pdf', 'pdf'], ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']])

function safeName(value: string | undefined, extension: string) {
  let decoded = `attachment.${extension}`
  try { if (value) decoded = decodeURIComponent(value) } catch { throw new ApiError(400, 'INVALID_FILE_NAME', 'Некорректное имя файла.') }
  const leaf = decoded.replaceAll('\0', '_').replace(/[/\\\r\n]/g, '_').trim().slice(0, 240)
  return leaf || `attachment.${extension}`
}

async function validateContents(input: Buffer, mimeType: string) {
  if (!input.length) throw new ApiError(400, 'EMPTY_ATTACHMENT', 'Выберите файл для загрузки.')
  if (input.length > MAX_REQUEST_FILE_BYTES) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Файл должен весить не больше 10 МБ.')
  if (!allowed.has(mimeType)) throw new ApiError(415, 'UNSUPPORTED_ATTACHMENT', 'Поддерживаются PDF, JPEG, PNG и WebP.')
  if (mimeType === 'application/pdf') {
    if (input.subarray(0, 5).toString('ascii') !== '%PDF-' || !input.subarray(Math.max(0, input.length - 2048)).includes(Buffer.from('%%EOF'))) throw new ApiError(400, 'INVALID_ATTACHMENT', 'PDF повреждён или имеет неверный формат.')
    return
  }
  try {
    const metadata = await sharp(input, { failOn: 'error', limitInputPixels: 25_000_000 }).metadata()
    const expected = mimeType === 'image/jpeg' ? 'jpeg' : mimeType.slice(6)
    if (metadata.format !== expected || (metadata.pages ?? 1) > 1) throw new Error('format mismatch')
  } catch { throw new ApiError(400, 'INVALID_ATTACHMENT', 'Изображение повреждено или его содержимое не соответствует формату.') }
}

export async function addRequestAttachment(userId: string, organizationId: string, requestId: string, input: unknown, mimeType: string, originalName?: string) {
  const { actor, item } = await assertRequestFileAccess(userId, organizationId, requestId)
  if (item.createdByMemberId !== actor.id || item.status !== 'PENDING') throw new ApiError(403, 'ATTACHMENT_FORBIDDEN', 'Вложения может добавлять автор до рассмотрения заявки.')
  const type = await prisma.requestType.findUniqueOrThrow({ where: { id: item.requestTypeId } })
  if (!type.allowsAttachments) throw new ApiError(400, 'ATTACHMENTS_NOT_ALLOWED', 'Этот тип заявки не поддерживает вложения.')
  const count = await prisma.requestAttachment.count({ where: { requestId } })
  if (count >= 5) throw new ApiError(409, 'ATTACHMENT_LIMIT', 'К одной заявке можно добавить не больше пяти файлов.')
  if (!Buffer.isBuffer(input)) throw new ApiError(400, 'EMPTY_ATTACHMENT', 'Выберите файл для загрузки.')
  await validateContents(input, mimeType)
  const extension = allowed.get(mimeType)!
  const objectKey = `organizations/${organizationId}/requests/${requestId}/${randomUUID()}.${extension}`
  const fileName = safeName(originalName, extension)
  await writeObject(objectKey, input)
  try {
    return await prisma.$transaction(async (tx) => {
      const file = await tx.storedFile.create({ data: { objectKey, mimeType, size: input.length, checksumSha256: createHash('sha256').update(input).digest('hex'), purpose: 'REQUEST_ATTACHMENT', uploadedByUserId: userId, organizationId } })
      return tx.requestAttachment.create({ data: { requestId, storedFileId: file.id, fileName }, include: { storedFile: true } })
    })
  } catch (error) { await deleteObject(objectKey).catch(() => undefined); throw error }
}

export async function downloadRequestAttachment(userId: string, organizationId: string, requestId: string, attachmentId: string) {
  await assertRequestFileAccess(userId, organizationId, requestId)
  const attachment = await prisma.requestAttachment.findFirst({ where: { id: attachmentId, requestId, request: { organizationId } }, include: { storedFile: true } })
  if (!attachment || attachment.storedFile.purpose !== 'REQUEST_ATTACHMENT') throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Вложение не найдено.')
  let contents: Buffer
  try { contents = await readObject(attachment.storedFile.objectKey) }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Вложение не найдено.'); throw error }
  return { attachment, contents }
}

export async function deleteRequestAttachment(userId: string, organizationId: string, requestId: string, attachmentId: string) {
  const { actor, item } = await assertRequestFileAccess(userId, organizationId, requestId)
  if (item.createdByMemberId !== actor.id || item.status !== 'PENDING') throw new ApiError(403, 'ATTACHMENT_FORBIDDEN', 'Удалить вложение может автор до рассмотрения заявки.')
  const fileId = await prisma.$transaction(async (tx) => {
    const request = await tx.organizationRequest.findFirst({ where: { id: requestId, organizationId, createdByMemberId: actor.id, status: 'PENDING' }, select: { id: true } })
    if (!request) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Обработанную заявку нельзя изменить.')
    const attachment = await tx.requestAttachment.findFirst({ where: { id: attachmentId, requestId }, select: { storedFileId: true } })
    if (!attachment) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Вложение не найдено.')
    await tx.requestAttachment.delete({ where: { id: attachmentId } })
    await tx.storedFile.update({ where: { id: attachment.storedFileId }, data: { pendingDeletionAt: new Date() } })
    return attachment.storedFileId
  }, { isolationLevel: 'Serializable' })
  await deletePendingFile(fileId)
}
