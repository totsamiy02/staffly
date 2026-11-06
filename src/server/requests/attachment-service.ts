import { createHash,randomUUID } from 'node:crypto'
import { processFile } from '../file-processing/client.ts'
import { definitionOf } from '../../app/requests/workflow.ts'
import { ApiError } from '../api-error.ts'
import { prisma } from '../db.ts'
import { hasPermission, requirePermission } from '../organizations/access/access.ts'
import { deletePendingFile,stageStoredFile } from '../storage/image-service.ts'
import { storage } from '../storage/provider.ts'
import { lockRequest } from './request-lock.ts'
import { notifyStage } from './request-notifications.ts'
import { assertRequestFileAccess } from './service.ts'
import { freshFileAccess } from '../storage/guarded-delivery.ts'
import { getMembership } from '../organizations/access/permissions.ts'

export const MAX_REQUEST_FILE_BYTES = 10 * 1024 * 1024
const allowed = new Map([['application/pdf', 'pdf'], ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']])

export function canDeleteRequestAttachment(actor: Awaited<ReturnType<typeof getMembership>>, item: { createdByMemberId: string; authorMemberId: string | null; locationId: string; status: string }) {
  return ['PENDING', 'DRAFT', 'RETURNED'].includes(item.status) && (item.createdByMemberId === actor.id || item.authorMemberId === actor.id)
    && hasPermission(actor, 'requests.edit', item.locationId) && (item.createdByMemberId === actor.id || hasPermission(actor, 'requests.onBehalf', item.locationId))
}

function safeName(value: string | undefined, extension: string) {
  let decoded = `attachment.${extension}`
  try { if (value) decoded = decodeURIComponent(value) } catch { throw new ApiError(400, 'INVALID_FILE_NAME', 'Некорректное имя файла.') }
  // Strip control characters from download display names; never use them as disk paths.
  // oxlint-disable-next-line no-control-regex
  const leaf = decoded.replace(/[\x00-\x1f\x7f/\\]/g, '_').trim().slice(0, 220)
  const base = leaf.replace(/\.[^.]*$/, '').replace(/^[. ]+|[. ]+$/g, '')
  return `${base || 'attachment'}.${extension}`
}

async function validateContents(input: Buffer, mimeType: string) {
  if (!input.length) throw new ApiError(400, 'EMPTY_ATTACHMENT', 'Выберите файл для загрузки.')
  if (input.length > MAX_REQUEST_FILE_BYTES) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Файл должен весить не больше 10 МБ.')
  if (!allowed.has(mimeType)) throw new ApiError(415, 'UNSUPPORTED_ATTACHMENT', 'Поддерживаются PDF, JPEG, PNG и WebP.')
  if (mimeType === 'application/pdf') {
    if (input.subarray(0, 5).toString('ascii') !== '%PDF-' || !input.subarray(Math.max(0, input.length - 2048)).includes(Buffer.from('%%EOF'))) throw new ApiError(400, 'INVALID_ATTACHMENT', 'PDF повреждён или имеет неверный формат.')
    return
  }
  try { return await processFile('image', mimeType === 'image/jpeg' ? 'jpeg' : mimeType.slice(6), input) }
  catch (error) {
    if (error instanceof ApiError && error.code === 'INVALID_DOCUMENT_FILE') throw new ApiError(400, 'INVALID_ATTACHMENT', 'Изображение повреждено или его содержимое не соответствует формату.')
    throw error
  }
}

export async function addRequestAttachment(userId: string, organizationId: string, requestId: string, input: unknown, mimeType: string, originalName?: string) {
  const { actor, item } = await assertRequestFileAccess(userId, organizationId, requestId)
  requirePermission(actor,'requests.edit')
  if(item.createdByMemberId!==actor.id)requirePermission(actor,'requests.onBehalf',item.locationId)
  if (item.createdByMemberId !== actor.id && item.authorMemberId!==actor.id || !['PENDING','DRAFT','RETURNED'].includes(item.status)) throw new ApiError(403, 'ATTACHMENT_FORBIDDEN', 'Вложения может добавлять автор до рассмотрения заявки.')
  const type = await prisma.requestType.findUniqueOrThrow({ where: { id: item.requestTypeId } })
  if (!(definitionOf(item.formSnapshot).allowsAttachments??type.allowsAttachments)) throw new ApiError(400, 'ATTACHMENTS_NOT_ALLOWED', 'Этот тип заявки не поддерживает вложения.')
  const count = await prisma.requestAttachment.count({ where: { requestId } })
  if (count >= 5) throw new ApiError(409, 'ATTACHMENT_LIMIT', 'К одной заявке можно добавить не больше пяти файлов.')
  if (!Buffer.isBuffer(input)) throw new ApiError(400, 'EMPTY_ATTACHMENT', 'Выберите файл для загрузки.')
  const contents = await validateContents(input, mimeType) ?? input
  if (contents.length > MAX_REQUEST_FILE_BYTES) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Изображение после обработки превышает допустимый размер.')
  const extension = allowed.get(mimeType)!
  const objectKey = `organizations/${organizationId}/requests/${requestId}/${randomUUID()}.${extension}`
  const fileName = safeName(originalName, extension)
  const staged = await stageStoredFile({ objectKey, mimeType, size: contents.length, checksumSha256: createHash('sha256').update(contents).digest('hex'), purpose: 'REQUEST_ATTACHMENT', uploadedByUserId: userId, organizationId }, contents)
  try {
    return await prisma.$transaction(async (tx) => {
      await lockRequest(tx,requestId)
      const fresh=await tx.organizationRequest.findFirst({where:{id:requestId,organizationId,OR:[{createdByMemberId:actor.id},{authorMemberId:actor.id}],status:{in:['PENDING','DRAFT','RETURNED']}},include:{requestType:true}})
      if(!fresh)throw new ApiError(409,'REQUEST_ALREADY_RESOLVED','Обращение уже рассмотрено.')
      const current = await getMembership(userId, organizationId, tx)
      requirePermission(current, 'requests.edit', fresh.locationId)
      if (fresh.createdByMemberId !== current.id) requirePermission(current, 'requests.onBehalf', fresh.locationId)
      if(!(definitionOf(fresh.formSnapshot).allowsAttachments??fresh.requestType.allowsAttachments))throw new ApiError(400,'ATTACHMENTS_NOT_ALLOWED','Вложения недоступны.')
      const duplicate=await tx.requestAttachment.findFirst({where:{requestId,fileName,storedFile:{checksumSha256:staged.checksumSha256}},include:{storedFile:true}})
      if(duplicate)return duplicate
      if(await tx.requestAttachment.count({where:{requestId}})>=5)throw new ApiError(409,'ATTACHMENT_LIMIT','Можно добавить не больше пяти файлов.')
      const file = await tx.storedFile.update({ where: { id: staged.id }, data: { pendingDeletionAt: null } })
      const attachment=await tx.requestAttachment.create({ data: { requestId, storedFileId: file.id, fileName }, include: { storedFile: true } })
      const updated=await tx.organizationRequest.update({where:{id:requestId},data:{approvalStep:0,updatedAt:new Date()}})
      await tx.requestEvent.create({data:{requestId,actorMemberId:actor.id,type:'EDITED',comment:`Добавлен файл: ${fileName}`}})
      await tx.requestRead.deleteMany({where:{requestId}})
      if(updated.status==='PENDING')await notifyStage(tx,updated)
      return attachment
    })
  } catch (error) { await deletePendingFile(staged.id); throw error }
}

export async function downloadRequestAttachment(userId: string, organizationId: string, requestId: string, attachmentId: string) {
  await assertRequestFileAccess(userId, organizationId, requestId)
  const attachment = await prisma.requestAttachment.findFirst({ where: { id: attachmentId, requestId, request: { organizationId } }, include: { storedFile: true } })
  if (!attachment || attachment.storedFile.purpose !== 'REQUEST_ATTACHMENT' || attachment.storedFile.organizationId !== organizationId || attachment.storedFile.pendingDeletionAt || attachment.storedFile.purgedAt) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Вложение не найдено.')
  let contents: Buffer
  try { contents = await storage.read(attachment.storedFile.objectKey) }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Вложение не найдено.'); throw error }
  await freshFileAccess(() => assertRequestFileAccess(userId, organizationId, requestId))
  if (!await prisma.requestAttachment.count({ where: { id: attachmentId, requestId, storedFile: { organizationId, pendingDeletionAt: null, purgedAt: null } } })) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Вложение не найдено.')
  return { attachment, contents }
}

export async function deleteRequestAttachment(userId: string, organizationId: string, requestId: string, attachmentId: string) {
  const { actor, item } = await assertRequestFileAccess(userId, organizationId, requestId)
  requirePermission(actor,'requests.edit')
  if(item.createdByMemberId!==actor.id)requirePermission(actor,'requests.onBehalf',item.locationId)
  if (item.createdByMemberId !== actor.id && item.authorMemberId!==actor.id || !['PENDING','DRAFT','RETURNED'].includes(item.status)) throw new ApiError(403, 'ATTACHMENT_FORBIDDEN', 'Удалить вложение может автор до рассмотрения заявки.')
  const fileId = await prisma.$transaction(async (tx) => {
    await lockRequest(tx,requestId)
    const request = await tx.organizationRequest.findFirst({ where: { id: requestId, organizationId, OR:[{createdByMemberId:actor.id},{authorMemberId:actor.id}], status: {in:['PENDING','DRAFT','RETURNED']} }, select: { id: true } })
    if (!request) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Обработанную заявку нельзя изменить.')
    const current = await getMembership(userId, organizationId, tx)
    const fresh = await tx.organizationRequest.findUniqueOrThrow({ where: { id: request.id }, select: { createdByMemberId: true, authorMemberId: true, locationId: true, status: true } })
    if (!canDeleteRequestAttachment(current, fresh)) throw new ApiError(403, 'ATTACHMENT_FORBIDDEN', 'Недостаточно прав для удаления вложения.')
    const attachment = await tx.requestAttachment.findFirst({ where: { id: attachmentId, requestId }, select: { storedFileId: true,fileName:true } })
    if (!attachment) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Вложение не найдено.')
    await tx.requestAttachment.delete({ where: { id: attachmentId } })
    const updated=await tx.organizationRequest.update({where:{id:requestId},data:{approvalStep:0,updatedAt:new Date()}})
    await tx.requestEvent.create({data:{requestId,actorMemberId:actor.id,type:'EDITED',comment:`Удалён файл: ${attachment.fileName}`}})
    await tx.requestRead.deleteMany({where:{requestId}})
    if(updated.status==='PENDING')await notifyStage(tx,updated)
    await tx.storedFile.update({ where: { id: attachment.storedFileId }, data: { pendingDeletionAt: new Date() } })
    return attachment.storedFileId
  }, { isolationLevel: 'Serializable' })
  await deletePendingFile(fileId)
}
