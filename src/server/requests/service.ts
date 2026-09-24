import type { OrganizationRole, Prisma, RequestDateMode, RequestSystemCode, RequestStatus } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from '../organizations/permissions.ts'
import { addCalendarDays, startOfZonedDate, zonedDateTimeToUtc } from '../schedule/timezone.ts'
import { assertNoApprovedAbsence } from '../schedule/service.ts'
import { deliverShiftAssignment } from '../mail.ts'
import { mediaUrl } from '../storage/image-service.ts'

export const SYSTEM_REQUEST_TYPES = [
  { systemCode: 'VACATION', name: 'Отпуск', description: 'Плановый период отсутствия', dateMode: 'RANGE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'DAY_OFF', name: 'Отгул', description: 'Отсутствие в течение одного дня', dateMode: 'SINGLE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'SICK_LEAVE', name: 'Больничный', description: 'Отсутствие по болезни', dateMode: 'RANGE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'ABSENCE', name: 'Отсутствие', description: 'Другое запланированное отсутствие', dateMode: 'RANGE', requiresComment: true, allowsAttachments: true },
  { systemCode: 'SHIFT_CHANGE', name: 'Изменение смены', description: 'Запрос на изменение назначенной смены', dateMode: 'NONE', requiresComment: true, allowsAttachments: false },
  { systemCode: 'OTHER', name: 'Другое', description: 'Организационный запрос в свободной форме', dateMode: 'NONE', requiresComment: true, allowsAttachments: true },
] as const

const absenceCodes: RequestSystemCode[] = ['VACATION', 'DAY_OFF', 'SICK_LEAVE', 'ABSENCE']
const dateValue = (value: string | null | undefined) => value ? new Date(`${value}T00:00:00.000Z`) : null
const dateText = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null
const memberName = (user: { firstName: string | null; lastName: string | null; middleName: string | null; email: string }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email.split('@')[0]

export async function seedSystemRequestTypes(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.requestType.createMany({ data: SYSTEM_REQUEST_TYPES.map((item) => ({ ...item, organizationId })), skipDuplicates: true })
}

async function ensureSystemTypes(organizationId: string) {
  await prisma.requestType.createMany({ data: SYSTEM_REQUEST_TYPES.map((item) => ({ ...item, organizationId })), skipDuplicates: true })
}

export async function listRequestTypes(userId: string, organizationId: string, includeInactive = false) {
  const actor = await getMembership(userId, organizationId)
  await ensureSystemTypes(organizationId)
  return prisma.requestType.findMany({ where: { organizationId, ...(!includeInactive || actor.role !== 'OWNER' ? { isActive: true } : {}) }, orderBy: [{ systemCode: 'asc' }, { name: 'asc' }] })
}

export async function createRequestType(userId: string, organizationId: string, input: { name: string; description?: string | null; dateMode: RequestDateMode; requiresComment: boolean; allowsAttachments: boolean }) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER'])
  return prisma.requestType.create({ data: { organizationId, name: input.name, description: input.description || null, dateMode: input.dateMode, requiresComment: input.requiresComment, allowsAttachments: input.allowsAttachments } })
}

export async function updateRequestType(userId: string, organizationId: string, typeId: string, input: { name: string; description?: string | null; dateMode: RequestDateMode; requiresComment: boolean; allowsAttachments: boolean; isActive: boolean }) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER'])
  const type = await prisma.requestType.findFirst({ where: { id: typeId, organizationId } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Тип заявки не найден.')
  if (type.systemCode) {
    if (input.name !== type.name || input.description !== type.description || input.dateMode !== type.dateMode || input.requiresComment !== type.requiresComment || input.allowsAttachments !== type.allowsAttachments) throw new ApiError(409, 'SYSTEM_REQUEST_TYPE', 'У системного типа можно менять только доступность.')
    return prisma.requestType.update({ where: { id: type.id }, data: { isActive: input.isActive } })
  }
  return prisma.requestType.update({ where: { id: type.id }, data: { ...input, description: input.description || null } })
}

type CreateInput = { requestTypeId: string; startDate?: string | null; endDate?: string | null; comment?: string | null; relatedShiftId?: string | null; proposedStartDate?: string | null; proposedStartTime?: string | null; proposedEndDate?: string | null; proposedEndTime?: string | null }

function validateTypeFields(type: { dateMode: RequestDateMode; requiresComment: boolean; systemCode: RequestSystemCode | null }, input: CreateInput) {
  if (type.requiresComment && !input.comment?.trim()) throw new ApiError(400, 'REQUEST_COMMENT_REQUIRED', 'Для этого типа заявки нужен комментарий.')
  if (type.dateMode === 'SINGLE' && !input.startDate) throw new ApiError(400, 'REQUEST_DATE_REQUIRED', 'Укажите дату заявки.')
  if (type.dateMode === 'RANGE' && (!input.startDate || !input.endDate)) throw new ApiError(400, 'REQUEST_RANGE_REQUIRED', 'Укажите начало и окончание периода.')
  if (input.startDate && input.endDate && input.startDate > input.endDate) throw new ApiError(400, 'INVALID_REQUEST_RANGE', 'Дата окончания не может быть раньше даты начала.')
  if (type.systemCode === 'SHIFT_CHANGE' && !input.relatedShiftId) throw new ApiError(400, 'SHIFT_REQUIRED', 'Выберите смену, которую нужно изменить.')
  if (type.systemCode !== 'SHIFT_CHANGE' && input.relatedShiftId) throw new ApiError(400, 'SHIFT_NOT_ALLOWED', 'Смена доступна только для заявки на изменение смены.')
  const proposal = [input.proposedStartDate, input.proposedStartTime, input.proposedEndDate, input.proposedEndTime]
  if (type.systemCode === 'SHIFT_CHANGE' && proposal.some((value) => !value)) throw new ApiError(400, 'SHIFT_PROPOSAL_REQUIRED', 'Укажите желаемые даты и время смены.')
  if (type.systemCode !== 'SHIFT_CHANGE' && proposal.some(Boolean)) throw new ApiError(400, 'SHIFT_PROPOSAL_NOT_ALLOWED', 'Новое время доступно только для изменения смены.')
}

export async function createRequest(userId: string, organizationId: string, input: CreateInput) {
  const actor = await getMembership(userId, organizationId)
  const actorUser = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, firstName: true, lastName: true, middleName: true } })
  await ensureSystemTypes(organizationId)
  const type = await prisma.requestType.findFirst({ where: { id: input.requestTypeId, organizationId, isActive: true } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Активный тип заявки не найден.')
  validateTypeFields(type, input)
  const shift = input.relatedShiftId ? await prisma.workShift.findFirst({ where: { id: input.relatedShiftId, organizationId, memberId: actor.id } }) : null
  if (input.relatedShiftId && (!shift || shift.status !== 'SCHEDULED' || shift.scheduledStartAt <= new Date())) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Выберите свою будущую смену этой организации.')
  const proposedStartAt = shift ? zonedDateTimeToUtc(input.proposedStartDate!, input.proposedStartTime!, actor.organization.timezone) : null
  const proposedEndAt = shift ? zonedDateTimeToUtc(input.proposedEndDate!, input.proposedEndTime!, actor.organization.timezone) : null
  if (shift && (proposedEndAt! <= proposedStartAt! || proposedStartAt! < new Date())) throw new ApiError(400, 'INVALID_SHIFT_PROPOSAL', 'Новое время должно быть в будущем, а окончание — позже начала.')
  if (shift && proposedStartAt!.getTime() === shift.scheduledStartAt.getTime() && proposedEndAt!.getTime() === shift.scheduledEndAt.getTime()) throw new ApiError(400, 'UNCHANGED_SHIFT_PROPOSAL', 'Укажите время, отличающееся от текущей смены.')
  const startDate = dateValue(input.startDate)
  const endDate = type.dateMode === 'SINGLE' ? startDate : dateValue(input.endDate)
  return prisma.$transaction(async (tx) => {
    const request = await tx.organizationRequest.create({ data: { organizationId, createdByMemberId: actor.id, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: type.systemCode, startDate, endDate, comment: input.comment?.trim() || null, relatedShiftId: input.relatedShiftId || null, originalStartAt: shift?.scheduledStartAt, originalEndAt: shift?.scheduledEndAt, proposedStartAt, proposedEndAt } })
    await tx.requestEvent.create({ data: { requestId: request.id, actorMemberId: actor.id, type: 'CREATED' } })
    const reviewers = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, role: { in: ['OWNER', 'ADMIN'] } }, select: { userId: true } })
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map((reviewer) => ({ userId: reviewer.userId, organizationId, requestId: request.id, type: 'REQUEST_CREATED' as const, title: 'Новая заявка', message: `${memberName(actorUser)} · ${type.name}` })) })
    return request
  })
}

export async function updateRequest(userId: string, organizationId: string, requestId: string, input: CreateInput) {
  const actor = await getMembership(userId, organizationId)
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, createdByMemberId: actor.id } })
  if (!current) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  if (current.status !== 'PENDING') throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Изменить можно только заявку, ожидающую решения.')
  const type = await prisma.requestType.findFirst({ where: { id: input.requestTypeId, organizationId, isActive: true } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Выберите доступный тип заявки.')
  validateTypeFields(type, input)
  const shift = input.relatedShiftId ? await prisma.workShift.findFirst({ where: { id: input.relatedShiftId, organizationId, memberId: actor.id } }) : null
  if (input.relatedShiftId && (!shift || shift.status !== 'SCHEDULED' || shift.scheduledStartAt <= new Date())) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Выберите свою будущую смену этой организации.')
  const proposedStartAt = shift ? zonedDateTimeToUtc(input.proposedStartDate!, input.proposedStartTime!, actor.organization.timezone) : null
  const proposedEndAt = shift ? zonedDateTimeToUtc(input.proposedEndDate!, input.proposedEndTime!, actor.organization.timezone) : null
  if (shift && (proposedEndAt! <= proposedStartAt! || proposedStartAt! < new Date())) throw new ApiError(400, 'INVALID_SHIFT_PROPOSAL', 'Новое время должно быть в будущем, а окончание — позже начала.')
  if (shift && proposedStartAt!.getTime() === shift.scheduledStartAt.getTime() && proposedEndAt!.getTime() === shift.scheduledEndAt.getTime()) throw new ApiError(400, 'UNCHANGED_SHIFT_PROPOSAL', 'Укажите время, отличающееся от текущей смены.')
  if (!type.allowsAttachments && current.requestTypeId !== type.id && await prisma.requestAttachment.count({ where: { requestId } })) throw new ApiError(409, 'REQUEST_HAS_ATTACHMENTS', 'Сначала удалите вложения, чтобы выбрать тип без файлов.')
  const author = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, firstName: true, lastName: true, middleName: true } })
  const startDate = dateValue(input.startDate)
  const endDate = type.dateMode === 'SINGLE' ? startDate : dateValue(input.endDate)
  return prisma.$transaction(async (tx) => {
    const changed = await tx.organizationRequest.updateMany({ where: { id: requestId, organizationId, createdByMemberId: actor.id, status: 'PENDING', updatedAt: current.updatedAt }, data: { requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: type.systemCode, startDate, endDate, comment: input.comment?.trim() || null, relatedShiftId: input.relatedShiftId || null, originalStartAt: shift?.scheduledStartAt ?? null, originalEndAt: shift?.scheduledEndAt ?? null, proposedStartAt, proposedEndAt } })
    if (!changed.count) throw new ApiError(409, 'REQUEST_CHANGED', 'Заявка уже изменилась. Откройте её заново.')
    await tx.requestEvent.create({ data: { requestId, actorMemberId: actor.id, type: 'EDITED' } })
    await tx.requestRead.deleteMany({ where: { requestId } })
    await tx.accountNotification.updateMany({ where: { requestId, type: 'REQUEST_CREATED', readAt: null }, data: { readAt: new Date() } })
    const reviewers = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, role: { in: ['OWNER', 'ADMIN'] } }, select: { userId: true } })
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map((reviewer) => ({ userId: reviewer.userId, organizationId, requestId, type: 'REQUEST_CREATED' as const, title: 'Заявка изменена', message: `${memberName(author)} · ${type.name}` })) })
    return tx.organizationRequest.findUniqueOrThrow({ where: { id: requestId } })
  }, { isolationLevel: 'Serializable' })
}

const requestInclude = {
  creator: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } },
  resolvedBy: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } },
  relatedShift: true,
  attachments: { include: { storedFile: { select: { mimeType: true, size: true } } }, orderBy: { createdAt: 'asc' } },
  events: { include: { actor: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } } }, orderBy: { createdAt: 'asc' } },
  reads: { orderBy: { readAt: 'asc' } },
} as const

function publicRequest(item: any, viewerMemberId?: string) {
  return { ...item, startDate: dateText(item.startDate), endDate: dateText(item.endDate), creatorName: memberName(item.creator.user), creatorRole: item.creator.role, creatorEmail: item.creator.user.email, creatorAvatarUrl: mediaUrl(item.creator.user.avatarFileId), resolvedByName: item.resolvedBy ? memberName(item.resolvedBy.user) : null, firstReadAt: item.reads?.[0]?.readAt ?? null, readByViewer: viewerMemberId ? item.reads?.some((read: { memberId: string }) => read.memberId === viewerMemberId) : false, attachments: item.attachments?.map((attachment: any) => ({ id: attachment.id, fileName: attachment.fileName, mimeType: attachment.storedFile.mimeType, size: attachment.storedFile.size, downloadUrl: `/api/organizations/${item.organizationId}/requests/${item.id}/attachments/${attachment.id}` })) ?? [], events: item.events?.map((event: any) => ({ id: event.id, type: event.type, comment: event.comment, createdAt: event.createdAt, actorName: memberName(event.actor.user) })) ?? [] }
}

type ListOptions = { page: number; pageSize: number; status?: RequestStatus; typeId?: string; memberId?: string; role?: OrganizationRole; from?: string; to?: string; search?: string }

export async function listRequests(userId: string, organizationId: string, scope: 'mine' | 'incoming' | 'history', options: ListOptions) {
  const actor = await getMembership(userId, organizationId)
  if (scope !== 'mine') requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const where: Prisma.OrganizationRequestWhereInput = { organizationId,
    ...(scope === 'mine' ? { createdByMemberId: actor.id, ...(options.status ? { status: options.status } : {}) } : scope === 'incoming' ? { status: 'PENDING' } : { status: options.status ? options.status : { in: ['APPROVED', 'REJECTED', 'CANCELLED'] } }),
    ...(options.typeId ? { requestTypeId: options.typeId } : {}), ...(options.memberId && scope !== 'mine' ? { createdByMemberId: options.memberId } : {}),
    ...(options.role && scope !== 'mine' ? { creator: { role: options.role } } : {}),
    ...(options.from || options.to ? { startDate: { ...(options.from ? { gte: dateValue(options.from)! } : {}), ...(options.to ? { lte: dateValue(options.to)! } : {}) } } : {}),
    ...(options.search ? { AND: options.search.trim().split(/\s+/).map((term) => ({ creator: { user: { OR: [{ email: { contains: term, mode: 'insensitive' } }, { firstName: { contains: term, mode: 'insensitive' } }, { lastName: { contains: term, mode: 'insensitive' } }, { middleName: { contains: term, mode: 'insensitive' } }] } } })) } : {}),
  }
  const [total, rows] = await prisma.$transaction([prisma.organizationRequest.count({ where }), prisma.organizationRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'desc' }, skip: (options.page - 1) * options.pageSize, take: options.pageSize })])
  const unread = scope === 'incoming' ? await prisma.organizationRequest.count({ where: { ...where, reads: { none: { memberId: actor.id } } } }) : 0
  return { requests: rows.map((item) => publicRequest(item, actor.id)), pagination: { page: options.page, pageSize: options.pageSize, total, pages: Math.max(1, Math.ceil(total / options.pageSize)) }, counters: { pending: scope === 'incoming' ? total : 0, unread } }
}

async function requestForAccess(userId: string, organizationId: string, requestId: string) {
  const actor = await getMembership(userId, organizationId)
  const item = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId }, include: requestInclude })
  if (!item || (actor.role === 'MEMBER' && item.createdByMemberId !== actor.id)) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  return { actor, item }
}

async function conflictsFor(item: { organizationId: string; createdByMemberId: string; startDate: Date | null; endDate: Date | null; systemCodeSnapshot: RequestSystemCode | null }, timezone: string) {
  if (!item.systemCodeSnapshot || !absenceCodes.includes(item.systemCodeSnapshot) || !item.startDate || !item.endDate) return []
  const from = startOfZonedDate(dateText(item.startDate)!, timezone)
  const to = startOfZonedDate(addCalendarDays(dateText(item.endDate)!, 1), timezone)
  return prisma.workShift.findMany({ where: { organizationId: item.organizationId, memberId: item.createdByMemberId, status: 'SCHEDULED', scheduledStartAt: { lt: to }, scheduledEndAt: { gt: from } }, orderBy: { scheduledStartAt: 'asc' }, select: { id: true, scheduledStartAt: true, scheduledEndAt: true } })
}

export async function getRequest(userId: string, organizationId: string, requestId: string) {
  const { actor, item } = await requestForAccess(userId, organizationId, requestId)
  if (actor.role !== 'MEMBER') {
    const read = await prisma.requestRead.upsert({ where: { requestId_memberId: { requestId, memberId: actor.id } }, create: { requestId, memberId: actor.id }, update: {} })
    if (!item.reads.some((entry) => entry.memberId === actor.id)) item.reads.push(read)
  }
  return { request: publicRequest(item, actor.id), conflicts: await conflictsFor(item, actor.organization.timezone) }
}

export async function resolveRequest(userId: string, organizationId: string, requestId: string, decision: 'APPROVED' | 'REJECTED', comment: string | null | undefined, cancelConflictingShifts = false) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId }, include: { creator: true } })
  if (!current) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  if (decision === 'REJECTED' && !comment?.trim()) throw new ApiError(400, 'RESOLUTION_COMMENT_REQUIRED', 'Укажите причину отклонения.')
  const conflicts = decision === 'APPROVED' ? await conflictsFor(current, actor.organization.timezone) : []
  if (conflicts.length && !cancelConflictingShifts) throw new ApiError(409, 'REQUEST_SHIFT_CONFLICTS', `На период заявки назначено смен: ${conflicts.length}. Подтвердите их отмену.`, { conflicts })
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.organizationRequest.updateMany({ where: { id: requestId, organizationId, status: 'PENDING' }, data: { status: decision, resolvedAt: new Date(), resolvedByMemberId: actor.id, resolutionComment: comment?.trim() || null } })
    if (!changed.count) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Заявка уже была обработана.')
    if (decision === 'APPROVED' && current.systemCodeSnapshot === 'SHIFT_CHANGE') {
      if (!current.relatedShiftId || !current.originalStartAt || !current.originalEndAt || !current.proposedStartAt || !current.proposedEndAt) throw new ApiError(409, 'SHIFT_PROPOSAL_MISSING', 'В этой заявке нет нового времени смены. Попросите подать её заново.')
      if (current.proposedStartAt <= new Date()) throw new ApiError(409, 'SHIFT_PROPOSAL_PAST', 'Предложенное время уже прошло. Попросите подать новую заявку.')
      const shift = await tx.workShift.findFirst({ where: { id: current.relatedShiftId, organizationId, memberId: current.createdByMemberId } })
      if (!shift || shift.status !== 'SCHEDULED' || shift.scheduledStartAt <= new Date() || shift.scheduledStartAt.getTime() !== current.originalStartAt.getTime() || shift.scheduledEndAt.getTime() !== current.originalEndAt.getTime()) throw new ApiError(409, 'SHIFT_CHANGED_SINCE_REQUEST', 'Исходная смена уже началась или изменилась. Попросите подать новую заявку.')
      await assertNoApprovedAbsence(organizationId, shift.memberId, current.proposedStartAt, current.proposedEndAt, actor.organization.timezone, tx)
      const overlap = await tx.workShift.findFirst({ where: { id: { not: shift.id }, organizationId, memberId: shift.memberId, status: 'SCHEDULED', scheduledStartAt: { lt: current.proposedEndAt }, scheduledEndAt: { gt: current.proposedStartAt } }, select: { id: true } })
      if (overlap) throw new ApiError(409, 'SHIFT_OVERLAP', 'В предложенное время у сотрудника уже есть смена.')
      await tx.workShift.update({ where: { id: shift.id }, data: { scheduledStartAt: current.proposedStartAt, scheduledEndAt: current.proposedEndAt, assignmentReadAt: null } })
    }
    if (decision === 'APPROVED' && current.systemCodeSnapshot && absenceCodes.includes(current.systemCodeSnapshot) && current.startDate && current.endDate) {
      await tx.employeeAbsence.create({ data: { organizationId, memberId: current.createdByMemberId, sourceRequestId: current.id, type: current.systemCodeSnapshot, startDate: current.startDate, endDate: current.endDate } })
      if (conflicts.length) await tx.workShift.updateMany({ where: { id: { in: conflicts.map((shift) => shift.id) }, status: 'SCHEDULED', scheduledEndAt: { gt: new Date() } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByMemberId: actor.id, cancellationReason: `Одобрено отсутствие по заявке ${requestId}` } })
    }
    await tx.requestEvent.create({ data: { requestId, actorMemberId: actor.id, type: decision, comment: comment?.trim() || null } })
    await tx.accountNotification.updateMany({ where: { requestId, type: 'REQUEST_CREATED', readAt: null }, data: { readAt: new Date() } })
    if (current.creator.userId !== userId) await tx.accountNotification.create({ data: { userId: current.creator.userId, organizationId, requestId, type: decision === 'APPROVED' ? 'REQUEST_APPROVED' : 'REQUEST_REJECTED', title: decision === 'APPROVED' ? 'Заявка одобрена' : 'Заявка отклонена', message: current.typeNameSnapshot } })
    return tx.organizationRequest.findUniqueOrThrow({ where: { id: requestId } })
  }, { isolationLevel: 'Serializable' }).catch((error: unknown) => {
    if (error instanceof ApiError) throw error
    const detail = String(error)
    if (detail.includes('23P01') || detail.includes('work_shifts_no_overlap')) throw new ApiError(409, 'SHIFT_OVERLAP', 'В предложенное время у сотрудника уже есть смена.')
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') throw new ApiError(409, 'REQUEST_CONFLICT', 'Расписание изменилось одновременно с решением. Проверьте заявку и повторите действие.')
    throw error
  })
  if (decision === 'APPROVED' && current.systemCodeSnapshot === 'SHIFT_CHANGE' && current.proposedStartAt && current.proposedEndAt) {
    const creator = await prisma.user.findUnique({ where: { id: current.creator.userId }, select: { email: true } })
    if (creator) void deliverShiftAssignment(creator.email, organizationId, actor.organization.name, current.proposedStartAt, current.proposedEndAt, actor.organization.timezone).catch((error) => console.error('Shift-assignment email failed:', error))
  }
  return result
}

export async function cancelRequest(userId: string, organizationId: string, requestId: string, systemReason?: string) {
  const actor = await getMembership(userId, organizationId)
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId } })
  if (!current || current.createdByMemberId !== actor.id) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.organizationRequest.updateMany({ where: { id: requestId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date(), resolutionComment: systemReason || null } })
    if (!updated.count) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Обработанную заявку нельзя отменить.')
    await tx.requestEvent.create({ data: { requestId, actorMemberId: actor.id, type: 'CANCELLED', comment: systemReason || null } })
    await tx.accountNotification.updateMany({ where: { requestId, type: 'REQUEST_CREATED', readAt: null }, data: { readAt: new Date() } })
    return true
  }, { isolationLevel: 'Serializable' })
  return changed
}

export async function assertRequestFileAccess(userId: string, organizationId: string, requestId: string) {
  return requestForAccess(userId, organizationId, requestId)
}
