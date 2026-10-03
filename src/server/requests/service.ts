import { requireLocationManager } from '../organizations/location-service.ts'
import { locationWhere, locationMemberWhere, scopedLocationId } from '../organizations/location-context.ts'
import { assertAbsencePeriod, absencePeriodBody, notifyAbsence } from '../schedule/absence-service.ts'
import { checkMonthlyWorkload } from '../schedule/workload.ts'
import { cancelShiftRequests, lockShift, reconcileShiftRequests } from './shift-conflicts.ts'
import type { OrganizationRole, Prisma, RequestDateMode, RequestSystemCode, RequestStatus } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from '../organizations/permissions.ts'
import { addCalendarDays, startOfZonedDate, zonedDateTimeToUtc } from '../schedule/timezone.ts'
import { activeTarget, assertNoApprovedAbsence } from '../schedule/service.ts'
import { deliverRequestDecision } from '../mail.ts'
import { recordShiftNotification } from '../organizations/notification-service.ts'
import { mediaUrl } from '../storage/image-service.ts'

export const SYSTEM_REQUEST_TYPES = [
  { systemCode: 'SICK', name: 'Сообщить об отсутствии', description: 'Сообщение без согласования. Смены сохраняются, запись остаётся в истории заявок.', dateMode: 'RANGE', requiresComment: false, allowsAttachments: false },
  { systemCode: 'VACATION', name: 'Отпуск', description: 'Плановый период отсутствия', dateMode: 'RANGE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'DAY_OFF', name: 'Отгул', description: 'Отсутствие в течение одного дня', dateMode: 'SINGLE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'ABSENCE', name: 'Отсутствие', description: 'Другое запланированное отсутствие', dateMode: 'RANGE', requiresComment: true, allowsAttachments: true },
  { systemCode: 'SHIFT_PROPOSAL', name: 'Предложить смену', description: 'Предложение новой смены для себя. Добавляется в расписание после одобрения.', dateMode: 'NONE', requiresComment: true, allowsAttachments: false },
  { systemCode: 'SHIFT_CHANGE', name: 'Изменение смены', description: 'Запрос на изменение назначенной смены', dateMode: 'NONE', requiresComment: true, allowsAttachments: false },
  { systemCode: 'STAFFING', name: 'Нужен сотрудник на подмену', description: 'Открытая смена для сотрудников других точек. Отклик подтверждает принимающая точка.', dateMode: 'NONE', requiresComment: false, allowsAttachments: false },
  { systemCode: 'STAFFING_RESPONSE', name: 'Отклик на подмену', description: 'Отклик сотрудника на открытую смену другой точки.', dateMode: 'NONE', requiresComment: false, allowsAttachments: false },
  { systemCode: 'OTHER', name: 'Другое', description: 'Организационный запрос в свободной форме', dateMode: 'NONE', requiresComment: true, allowsAttachments: true },
] as const

const absenceCodes: RequestSystemCode[] = ['VACATION', 'DAY_OFF', 'SICK_LEAVE', 'ABSENCE', 'SICK']
const dateValue = (value: string | null | undefined) => value ? new Date(`${value}T00:00:00.000Z`) : null
const dateText = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null
const memberName = (user: { firstName: string | null; lastName: string | null; middleName: string | null; email: string }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email.split('@')[0]

export async function seedSystemRequestTypes(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.requestType.createMany({ data: SYSTEM_REQUEST_TYPES.map((item) => ({ ...item, organizationId })), skipDuplicates: true })
}

async function ensureSystemTypes(organizationId: string) {
  await prisma.requestType.createMany({ data: SYSTEM_REQUEST_TYPES.map((item) => ({ ...item, organizationId })), skipDuplicates: true })
  await prisma.requestType.updateMany({ where: { organizationId, systemCode: 'SICK', isActive: false }, data: { isActive: true } })
}

export async function listRequestTypes(userId: string, organizationId: string, includeInactive = false) {
  const actor = await getMembership(userId, organizationId)
  await ensureSystemTypes(organizationId)
  return prisma.requestType.findMany({ where: { organizationId, OR: [{ systemCode: null }, { systemCode: { not: 'SICK_LEAVE' } }], ...(!includeInactive || actor.role !== 'OWNER' ? { isActive: true } : {}) }, orderBy: [{ systemCode: 'asc' }, { name: 'asc' }] })
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
  if (type.systemCode === 'SICK' && !input.isActive) throw new ApiError(409, 'MANDATORY_REQUEST_TYPE', 'Сообщение об отсутствии — обязательный тип заявки.')
  if (type.systemCode) {
    if (input.name !== type.name || input.description !== type.description || input.dateMode !== type.dateMode || input.requiresComment !== type.requiresComment || input.allowsAttachments !== type.allowsAttachments) throw new ApiError(409, 'SYSTEM_REQUEST_TYPE', 'У системного типа можно менять только доступность.')
    return prisma.requestType.update({ where: { id: type.id }, data: { isActive: input.isActive } })
  }
  return prisma.requestType.update({ where: { id: type.id }, data: { ...input, description: input.description || null } })
}

type CreateInput = { staffingPositionId?: string | null; staffingPositionName?: string | null; requestTypeId: string; startDate?: string | null; endDate?: string | null; comment?: string | null; relatedShiftId?: string | null; proposedStartDate?: string | null; proposedStartTime?: string | null; proposedEndDate?: string | null; proposedEndTime?: string | null; absenceReason?: 'SICK' | 'PERSONAL' | 'OTHER' | null }

function validateTypeFields(type: { dateMode: RequestDateMode; requiresComment: boolean; systemCode: RequestSystemCode | null }, input: CreateInput) {
  if (type.requiresComment && !input.comment?.trim()) throw new ApiError(400, 'REQUEST_COMMENT_REQUIRED', 'Для этого типа заявки нужен комментарий.')
  if (type.dateMode === 'SINGLE' && !input.startDate) throw new ApiError(400, 'REQUEST_DATE_REQUIRED', 'Укажите дату заявки.')
  if (type.dateMode === 'RANGE' && (!input.startDate || !input.endDate)) throw new ApiError(400, 'REQUEST_RANGE_REQUIRED', 'Укажите начало и окончание периода.')
  if (input.startDate && input.endDate && input.startDate > input.endDate) throw new ApiError(400, 'INVALID_REQUEST_RANGE', 'Дата окончания не может быть раньше даты начала.')
  if (type.systemCode === 'SHIFT_CHANGE' && !input.relatedShiftId) throw new ApiError(400, 'SHIFT_REQUIRED', 'Выберите смену, которую нужно изменить.')
  if (!['SHIFT_CHANGE', 'DAY_OFF'].includes(type.systemCode ?? '') && input.relatedShiftId) throw new ApiError(400, 'SHIFT_NOT_ALLOWED', 'Смена доступна только для заявки на изменение смены.')
  const proposal = [input.proposedStartDate, input.proposedStartTime, input.proposedEndDate, input.proposedEndTime]
  if (['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') && proposal.some((value) => !value)) throw new ApiError(400, 'SHIFT_PROPOSAL_REQUIRED', 'Укажите желаемые даты и время смены.')
  if (!['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') && proposal.some(Boolean)) throw new ApiError(400, 'SHIFT_PROPOSAL_NOT_ALLOWED', 'Новое время доступно только для изменения смены.')
}

export async function createRequest(userId: string, organizationId: string, input: CreateInput) {
  const actor = await getMembership(userId, organizationId)
  const actorUser = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, firstName: true, lastName: true, middleName: true } })
  await ensureSystemTypes(organizationId)
  const type = await prisma.requestType.findFirst({ where: { id: input.requestTypeId, organizationId, isActive: true } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Активный тип заявки не найден.')
  if (type.systemCode === 'STAFFING_RESPONSE') throw new ApiError(400, 'STAFFING_RESPONSE_ONLY', 'Откликнитесь на открытую заявку на подмену.')
  if (type.systemCode === 'SICK_LEAVE') throw new ApiError(400, 'SICK_REPORT_ONLY', 'Используйте действие «Сообщить о болезни» без согласования.')
  validateTypeFields(type, input)
  if (scopedLocationId(organizationId) && !actor.assignedLocationId && actor.role !== 'OWNER') throw new ApiError(403, 'MEMBER_NOT_IN_LOCATION', 'Для этой точки используйте отклик на заявку о подмене.')
  if (type.systemCode === 'STAFFING') await requireLocationManager(prisma, userId, organizationId, actor.locationId)
  const position = input.staffingPositionId ? await prisma.organizationPosition.findFirst({ where: { id: input.staffingPositionId, organizationId, isActive: true } }) : null
  if (type.systemCode === 'STAFFING' && (input.staffingPositionId && !position || !position && !input.staffingPositionName)) throw new ApiError(400, 'STAFFING_POSITION_REQUIRED', 'Укажите требуемую должность.')
  if (type.systemCode === 'SICK') return saveAbsenceRequest(userId, organizationId, type, input)
  const shift = input.relatedShiftId ? await prisma.workShift.findFirst({ where: { id: input.relatedShiftId, organizationId, ...locationWhere(organizationId), memberId: actor.id } }) : null
  if (input.relatedShiftId && (!shift || shift.status !== 'SCHEDULED' || shift.scheduledStartAt <= new Date())) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Выберите свою будущую смену этой организации.')
  const proposedStartAt = (['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '')) ? zonedDateTimeToUtc(input.proposedStartDate!, input.proposedStartTime!, actor.organization.timezone) : null
  const proposedEndAt = (['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '')) ? zonedDateTimeToUtc(input.proposedEndDate!, input.proposedEndTime!, actor.organization.timezone) : null
  if (proposedStartAt && (proposedEndAt! <= proposedStartAt! || proposedStartAt! < new Date())) throw new ApiError(400, 'INVALID_SHIFT_PROPOSAL', 'Новое время должно быть в будущем, а окончание — позже начала.')
  if (type.systemCode === 'SHIFT_PROPOSAL' && proposedStartAt && proposedEndAt) await activeTarget(prisma, organizationId, actor.id, proposedStartAt, proposedEndAt)
  if (type.systemCode === 'SHIFT_CHANGE' && shift && proposedStartAt!.getTime() === shift.scheduledStartAt.getTime() && proposedEndAt!.getTime() === shift.scheduledEndAt.getTime()) throw new ApiError(400, 'UNCHANGED_SHIFT_PROPOSAL', 'Укажите время, отличающееся от текущей смены.')
  if (type.systemCode === 'DAY_OFF' && shift && input.startDate !== new Intl.DateTimeFormat('en-CA', { timeZone: actor.organization.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shift.scheduledStartAt)) throw new ApiError(400, 'DAY_OFF_SHIFT_DATE', 'Дата отгула должна совпадать с датой выбранной смены.')
  const startDate = dateValue(input.startDate)
  const endDate = type.dateMode === 'SINGLE' ? startDate : dateValue(input.endDate)
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    if (type.systemCode === 'STAFFING') await requireLocationManager(tx, userId, organizationId, actor.locationId)
    if (shift) {
      await lockShift(tx, shift.id)
      const fresh = await tx.workShift.findUniqueOrThrow({ where: { id: shift.id } })
      if (fresh.status !== 'SCHEDULED' || fresh.memberId !== actor.id || fresh.scheduledStartAt <= new Date() || fresh.scheduledStartAt.getTime() !== shift.scheduledStartAt.getTime() || fresh.scheduledEndAt.getTime() !== shift.scheduledEndAt.getTime()) throw new ApiError(409, 'SHIFT_CHANGED_SINCE_REQUEST', 'Смена изменилась. Выберите её заново.')
    }
    const request = await tx.organizationRequest.create({ data: { organizationId, locationId: actor.locationId, createdByMemberId: actor.id, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: type.systemCode, startDate, endDate, comment: input.comment?.trim() || null, relatedShiftId: input.relatedShiftId || null, originalStartAt: shift?.scheduledStartAt, originalEndAt: shift?.scheduledEndAt, proposedStartAt, proposedEndAt, ...(type.systemCode === 'STAFFING' ? { staffingPositionId: position?.id, staffingPositionName: position?.name ?? input.staffingPositionName } : {}) } })
    await tx.requestEvent.create({ data: { requestId: request.id, actorMemberId: actor.id, type: 'CREATED' } })
    if (type.systemCode === 'STAFFING') {
      const recipients = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null }, locationMemberships: { some: { leftAt: null, locationId: { not: actor.locationId }, location: { archivedAt: null } }, none: { locationId: actor.locationId, leftAt: null } } }, select: { userId: true } })
      if (recipients.length) await tx.accountNotification.createMany({ data: recipients.map(member => ({ organizationId, userId: member.userId, requestId: request.id, type: 'REQUEST_CREATED', title: 'Нужен сотрудник на подмену', message: `${actor.location.name} · ${position?.name ?? input.staffingPositionName}` })) })
    }
    const reviewers = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, OR: scopedLocationId(organizationId) ? [{ role: 'OWNER' }, { locationMemberships: { some: { locationId: scopedLocationId(organizationId), role: 'ADMIN', leftAt: null } } }] : [{ role: { in: ['OWNER', 'ADMIN'] } }] }, select: { userId: true } })
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map((reviewer) => ({ userId: reviewer.userId, organizationId, requestId: request.id, type: 'REQUEST_CREATED' as const, title: 'Новая заявка', message: `${memberName(actorUser)} · ${type.name}` })) })
    return request
  })
}

export async function updateRequest(userId: string, organizationId: string, requestId: string, input: CreateInput) {
  const actor = await getMembership(userId, organizationId)
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId), createdByMemberId: actor.id } })
  if (!current) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  if (['STAFFING', 'STAFFING_RESPONSE'].includes(current.systemCodeSnapshot ?? '')) throw new ApiError(409, 'STAFFING_EDIT_LOCKED', 'Чтобы изменить условия подмены, отмените заявку и создайте новую. Отклики сохранятся в истории.')
  const informational = current.systemCodeSnapshot === 'SICK' && current.status === 'APPROVED'
  if (current.status !== 'PENDING' && !informational) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Изменить можно только заявку, ожидающую решения.')
  const type = await prisma.requestType.findFirst({ where: { id: input.requestTypeId, organizationId, isActive: true } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Выберите доступный тип заявки.')
  if (type.systemCode === 'STAFFING') throw new ApiError(409, 'STAFFING_EDIT_LOCKED', 'Создайте отдельную заявку на подмену.')
  if (type.systemCode === 'STAFFING_RESPONSE') throw new ApiError(400, 'STAFFING_RESPONSE_ONLY', 'Откликнитесь на открытую заявку на подмену.')
  if (type.systemCode === 'SICK_LEAVE') throw new ApiError(400, 'SICK_REPORT_ONLY', 'Используйте действие «Сообщить о болезни».')
  if (informational && type.systemCode !== 'SICK') throw new ApiError(409, 'REQUEST_TYPE_LOCKED', 'У сообщения об отсутствии нельзя изменить тип.')
  validateTypeFields(type, input)
  if (type.systemCode === 'SICK') {
    if (await prisma.requestAttachment.count({ where: { requestId } })) throw new ApiError(409, 'REQUEST_HAS_ATTACHMENTS', 'Сначала удалите вложения.')
    return saveAbsenceRequest(userId, organizationId, type, input, current)
  }
  const shift = input.relatedShiftId ? await prisma.workShift.findFirst({ where: { id: input.relatedShiftId, organizationId, ...locationWhere(organizationId), memberId: actor.id } }) : null
  if (input.relatedShiftId && (!shift || shift.status !== 'SCHEDULED' || shift.scheduledStartAt <= new Date())) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Выберите свою будущую смену этой организации.')
  const proposedStartAt = (['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '')) ? zonedDateTimeToUtc(input.proposedStartDate!, input.proposedStartTime!, actor.organization.timezone) : null
  const proposedEndAt = (['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '')) ? zonedDateTimeToUtc(input.proposedEndDate!, input.proposedEndTime!, actor.organization.timezone) : null
  if (proposedStartAt && (proposedEndAt! <= proposedStartAt! || proposedStartAt! < new Date())) throw new ApiError(400, 'INVALID_SHIFT_PROPOSAL', 'Новое время должно быть в будущем, а окончание — позже начала.')
  if (type.systemCode === 'SHIFT_PROPOSAL' && proposedStartAt && proposedEndAt) await activeTarget(prisma, organizationId, actor.id, proposedStartAt, proposedEndAt)
  if (type.systemCode === 'SHIFT_CHANGE' && shift && proposedStartAt!.getTime() === shift.scheduledStartAt.getTime() && proposedEndAt!.getTime() === shift.scheduledEndAt.getTime()) throw new ApiError(400, 'UNCHANGED_SHIFT_PROPOSAL', 'Укажите время, отличающееся от текущей смены.')
  if (!type.allowsAttachments && current.requestTypeId !== type.id && await prisma.requestAttachment.count({ where: { requestId } })) throw new ApiError(409, 'REQUEST_HAS_ATTACHMENTS', 'Сначала удалите вложения, чтобы выбрать тип без файлов.')
  const author = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, firstName: true, lastName: true, middleName: true } })
  if (type.systemCode === 'DAY_OFF' && shift && input.startDate !== new Intl.DateTimeFormat('en-CA', { timeZone: actor.organization.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shift.scheduledStartAt)) throw new ApiError(400, 'DAY_OFF_SHIFT_DATE', 'Дата отгула должна совпадать с датой выбранной смены.')
  const startDate = dateValue(input.startDate)
  const endDate = type.dateMode === 'SINGLE' ? startDate : dateValue(input.endDate)
  return prisma.$transaction(async (tx) => {
    if (shift) {
      await lockShift(tx, shift.id)
      const fresh = await tx.workShift.findUniqueOrThrow({ where: { id: shift.id } })
      if (fresh.status !== 'SCHEDULED' || fresh.memberId !== actor.id || fresh.scheduledStartAt <= new Date() || fresh.scheduledStartAt.getTime() !== shift.scheduledStartAt.getTime() || fresh.scheduledEndAt.getTime() !== shift.scheduledEndAt.getTime()) throw new ApiError(409, 'SHIFT_CHANGED_SINCE_REQUEST', 'Смена изменилась. Выберите её заново.')
    }
    const changed = await tx.organizationRequest.updateMany({ where: { id: requestId, organizationId, ...locationWhere(organizationId), createdByMemberId: actor.id, status: 'PENDING', updatedAt: current.updatedAt }, data: { requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: type.systemCode, startDate, endDate, comment: input.comment?.trim() || null, relatedShiftId: input.relatedShiftId || null, originalStartAt: shift?.scheduledStartAt ?? null, originalEndAt: shift?.scheduledEndAt ?? null, proposedStartAt, proposedEndAt } })
    if (!changed.count) throw new ApiError(409, 'REQUEST_CHANGED', 'Заявка уже изменилась. Откройте её заново.')
    await tx.requestEvent.create({ data: { requestId, actorMemberId: actor.id, type: 'EDITED' } })
    await tx.requestRead.deleteMany({ where: { requestId } })
    await tx.accountNotification.updateMany({ where: { requestId, type: 'REQUEST_CREATED', readAt: null }, data: { readAt: new Date() } })
    const reviewers = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, OR: scopedLocationId(organizationId) ? [{ role: 'OWNER' }, { locationMemberships: { some: { locationId: scopedLocationId(organizationId), role: 'ADMIN', leftAt: null } } }] : [{ role: { in: ['OWNER', 'ADMIN'] } }] }, select: { userId: true } })
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map((reviewer) => ({ userId: reviewer.userId, organizationId, requestId, type: 'REQUEST_CREATED' as const, title: 'Заявка изменена', message: `${memberName(author)} · ${type.name}` })) })
    return tx.organizationRequest.findUniqueOrThrow({ where: { id: requestId } })
  }, { isolationLevel: 'Serializable' })
}

const requestInclude = {
  location: { select: { id: true, name: true, timezone: true } },
  _count: { select: { staffingResponses: true } },
  creator: { include: { locationMemberships: { where: { leftAt: null } }, user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } },
  resolvedBy: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } },
  relatedShift: true,
  absence: { select: { reason: true } },
  attachments: { include: { storedFile: { select: { mimeType: true, size: true } } }, orderBy: { createdAt: 'asc' } },
  events: { include: { actor: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } } }, orderBy: { createdAt: 'asc' } },
  reads: { orderBy: { readAt: 'asc' } },
} as const

function publicRequest(item: any, viewerMemberId?: string) {
  return { ...item, locationName: item.location?.name, timezone: item.location?.timezone, responseCount: item._count?.staffingResponses ?? 0, absenceReason: item.absence?.reason ?? null, startDate: dateText(item.startDate), endDate: dateText(item.endDate), creatorName: memberName(item.creator.user), creatorRole: item.creator.role, creatorEmail: item.creator.user.email, creatorAvatarUrl: mediaUrl(item.creator.user.avatarFileId), resolvedByName: item.resolvedBy ? memberName(item.resolvedBy.user) : null, firstReadAt: item.reads?.[0]?.readAt ?? null, readByViewer: viewerMemberId ? item.reads?.some((read: { memberId: string }) => read.memberId === viewerMemberId) : false, attachments: item.attachments?.map((attachment: any) => ({ id: attachment.id, fileName: attachment.fileName, mimeType: attachment.storedFile.mimeType, size: attachment.storedFile.size, downloadUrl: `/api/organizations/${item.organizationId}/requests/${item.id}/attachments/${attachment.id}` })) ?? [], events: item.events?.map((event: any) => ({ id: event.id, type: event.type, comment: event.comment, createdAt: event.createdAt, actorName: memberName(event.actor.user) })) ?? [] }
}

type ListOptions = { pointId?: string; page: number; pageSize: number; status?: RequestStatus; typeId?: string; memberId?: string; role?: OrganizationRole; from?: string; to?: string; search?: string }

export async function listRequests(userId: string, organizationId: string, scope: 'mine' | 'incoming' | 'history' | 'staffing', options: ListOptions) {
  const actor = await getMembership(userId, organizationId)
  if (!['mine', 'staffing'].includes(scope)) requireOrganizationRole(actor.organizationRole, ['OWNER', 'ADMIN'])
  const pointScope = scope === 'staffing' ? { location: { archivedAt: null }, ...(options.pointId && options.pointId !== 'all' ? { locationId: options.pointId } : {}) } : options.pointId ? { ...(scope === 'mine' || actor.organizationRole === 'OWNER' ? {} : { locationId: { in: actor.managedLocationIds } }), ...(options.pointId !== 'all' ? { locationId: options.pointId } : {}) } : locationWhere(organizationId)
  if (scope !== 'mine' && scope !== 'staffing' && options.pointId && options.pointId !== 'all') await requireLocationManager(prisma, userId, organizationId, options.pointId)
  if (scope !== 'mine' && scope !== 'staffing' && !options.pointId) requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  await reconcileShiftRequests(organizationId)
  const dateFilters: Prisma.OrganizationRequestWhereInput[] = []
  if (options.from || options.to) {
    const points = await prisma.organizationLocation.findMany({ where: { organizationId }, select: { id: true, timezone: true } })
    dateFilters.push({ OR: [
      { startDate: { ...(options.to ? { lte: dateValue(options.to)! } : {}) }, endDate: { ...(options.from ? { gte: dateValue(options.from)! } : {}) } },
      ...points.map(point => ({ locationId: point.id, proposedStartAt: { ...(options.to ? { lt: startOfZonedDate(addCalendarDays(options.to, 1), point.timezone) } : { not: null }) }, proposedEndAt: { ...(options.from ? { gt: startOfZonedDate(options.from, point.timezone) } : { not: null }) } })),
      { startDate: null, proposedStartAt: null, createdAt: { ...(options.from ? { gte: startOfZonedDate(options.from, actor.organization.timezone) } : {}), ...(options.to ? { lt: startOfZonedDate(addCalendarDays(options.to, 1), actor.organization.timezone) } : {}) } },
    ] })
  }
  const where: Prisma.OrganizationRequestWhereInput = { organizationId, ...pointScope,
    ...(scope === 'staffing' ? { systemCodeSnapshot: 'STAFFING', status: options.status ?? 'PENDING', proposedStartAt: { gt: new Date() } } : scope === 'mine' ? { createdByMemberId: actor.id, ...(options.status ? { status: options.status } : {}) } : scope === 'incoming' ? { status: 'PENDING' } : { status: options.status ? options.status : { in: ['APPROVED', 'REJECTED', 'CANCELLED'] } }),
    ...(options.typeId ? { requestTypeId: options.typeId } : {}), ...(options.memberId && scope !== 'mine' ? { createdByMemberId: options.memberId } : {}),
    ...(options.role && scope !== 'mine' ? { creator: { role: options.role } } : {}),
    AND: [...dateFilters, ...(options.search ? options.search.trim().split(/\s+/).map((term) => ({ creator: { user: { OR: [{ email: { contains: term, mode: 'insensitive' as const } }, { firstName: { contains: term, mode: 'insensitive' as const } }, { lastName: { contains: term, mode: 'insensitive' as const } }, { middleName: { contains: term, mode: 'insensitive' as const } }] } } })) : [])],
  }
  const [total, rows] = await prisma.$transaction([prisma.organizationRequest.count({ where }), prisma.organizationRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'desc' }, skip: (options.page - 1) * options.pageSize, take: options.pageSize })])
  const unread = scope === 'incoming' ? await prisma.organizationRequest.count({ where: { ...where, reads: { none: { memberId: actor.id } } } }) : 0
  return { requests: rows.map((item) => publicRequest(item, actor.id)), pagination: { page: options.page, pageSize: options.pageSize, total, pages: Math.max(1, Math.ceil(total / options.pageSize)) }, counters: { pending: scope === 'incoming' ? total : 0, unread } }
}

async function requestForAccess(userId: string, organizationId: string, requestId: string) {
  const actor = await getMembership(userId, organizationId)
  await reconcileShiftRequests(organizationId)
  const item = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId) }, include: requestInclude })
  if (!item || (actor.role === 'MEMBER' && item.createdByMemberId !== actor.id && item.systemCodeSnapshot !== 'STAFFING')) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  return { actor, item }
}

async function conflictsFor(item: { organizationId: string; createdByMemberId: string; startDate: Date | null; endDate: Date | null; systemCodeSnapshot: RequestSystemCode | null }, timezone: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  if (!item.systemCodeSnapshot || !absenceCodes.includes(item.systemCodeSnapshot) || !item.startDate || !item.endDate) return []
  const from = startOfZonedDate(dateText(item.startDate)!, timezone)
  const to = startOfZonedDate(addCalendarDays(dateText(item.endDate)!, 1), timezone)
  return client.workShift.findMany({ where: { organizationId: item.organizationId, memberId: item.createdByMemberId, status: 'SCHEDULED', scheduledStartAt: { lt: to }, scheduledEndAt: { gt: from }, AND: [{ scheduledEndAt: { gt: new Date() } }] }, orderBy: { scheduledStartAt: 'asc' }, select: { id: true, locationId: true, scheduledStartAt: true, scheduledEndAt: true } })
}

export async function getRequest(userId: string, organizationId: string, requestId: string) {
  const { actor, item } = await requestForAccess(userId, organizationId, requestId)
  if (actor.role !== 'MEMBER') {
    const read = await prisma.requestRead.upsert({ where: { requestId_memberId: { requestId, memberId: actor.id } }, create: { requestId, memberId: actor.id }, update: {} })
    if (!item.reads.some((entry) => entry.memberId === actor.id)) item.reads.push(read)
  }
  const staffingResponses = item.systemCodeSnapshot === 'STAFFING' && actor.role !== 'MEMBER' ? (await prisma.organizationRequest.findMany({ where: { organizationId, staffingRequestId: item.id }, include: requestInclude, orderBy: { createdAt: 'asc' } })).map(response => publicRequest(response, actor.id)) : []
  const ownResponse = item.systemCodeSnapshot === 'STAFFING' ? await prisma.organizationRequest.findFirst({ where: { staffingRequestId: item.id, createdByMemberId: actor.id }, select: { id: true } }) : null
  const memberships = item.systemCodeSnapshot === 'STAFFING' ? await prisma.locationMember.findMany({ where: { memberId: actor.id, leftAt: null, location: { archivedAt: null } }, select: { locationId: true } }) : []
  return { staffingResponses, viewerResponseId: ownResponse?.id ?? null, viewerCanRespond: item.status === 'PENDING' && !!item.proposedStartAt && item.proposedStartAt > new Date() && !ownResponse && memberships.some(point => point.locationId !== item.locationId) && !memberships.some(point => point.locationId === item.locationId), request: publicRequest(item, actor.id), conflicts: await conflictsFor(item, actor.organization.timezone), absenceConflicts: item.status === 'PENDING' && item.systemCodeSnapshot && absenceCodes.includes(item.systemCodeSnapshot) && item.startDate && item.endDate ? (await prisma.employeeAbsence.findMany({ where: { organizationId, memberId: item.createdByMemberId, cancelledAt: null, startDate: { lte: item.endDate }, endDate: { gte: item.startDate } }, select: { id: true, type: true, startDate: true, endDate: true } })).map(a => ({ ...a, startDate: dateText(a.startDate), endDate: dateText(a.endDate) })) : [], otherAbsentEmployees: actor.role !== 'MEMBER' && item.startDate && item.endDate ? (await prisma.employeeAbsence.findMany({ where: { organizationId, member: locationMemberWhere(organizationId), memberId: { not: item.createdByMemberId }, cancelledAt: null, startDate: { lte: item.endDate }, endDate: { gte: item.startDate } }, distinct: ['memberId'], select: { memberId: true } })).length : 0 }
}

export async function resolveRequest(userId: string, organizationId: string, requestId: string, decision: 'APPROVED' | 'REJECTED', comment: string | null | undefined, cancelConflictingShifts = false, acknowledgeWorkload = false, acknowledgeAbsence = false) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  await reconcileShiftRequests(organizationId)
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId) }, include: { creator: true } })
  if (!current) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  if (current.systemCodeSnapshot === 'SICK') throw new ApiError(409, 'INFORMATIONAL_REQUEST', 'Сообщение об отсутствии не требует решения.')
  if (decision === 'REJECTED' && !comment?.trim()) throw new ApiError(400, 'RESOLUTION_COMMENT_REQUIRED', 'Укажите причину отклонения.')
  if (decision === 'APPROVED' && current.systemCodeSnapshot === 'STAFFING') throw new ApiError(409, 'STAFFING_RESPONSE_REQUIRED', 'Подтвердите отклик сотрудника, чтобы назначить подмену.')
  if (decision === 'APPROVED' && current.systemCodeSnapshot === 'SICK_LEAVE') throw new ApiError(409, 'SICK_REPORT_ONLY', 'Болезнь больше не требует одобрения. Сотруднику нужно сообщить о болезни через новое действие; старая заявка остаётся в истории.')
  const result = await prisma.$transaction(async (tx) => {
    if (scopedLocationId(organizationId)) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`; await requireLocationManager(tx, userId, organizationId, actor.locationId) }
    const liveConflicts = decision === 'APPROVED' ? await conflictsFor(current, actor.organization.timezone, tx) : []
    if (cancelConflictingShifts && scopedLocationId(organizationId)) for (const locationId of new Set(liveConflicts.map(shift => shift.locationId))) await requireLocationManager(tx, userId, organizationId, locationId)
    for (const id of liveConflicts.map(shift => shift.id).sort()) await lockShift(tx, id)
    if (current.relatedShiftId) await lockShift(tx, current.relatedShiftId)
    const changed = await tx.organizationRequest.updateMany({ where: { id: requestId, organizationId, ...locationWhere(organizationId), updatedAt: current.updatedAt, status: 'PENDING' }, data: { status: decision, resolvedAt: new Date(), resolvedByMemberId: actor.id, resolutionComment: comment?.trim() || null } })
    if (!changed.count) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Заявка уже была обработана.')
    if (decision === 'REJECTED' && current.systemCodeSnapshot === 'STAFFING') await cancelStaffingResponses(tx, current.id, actor.id)
    if (decision === 'APPROVED' && current.systemCodeSnapshot === 'STAFFING_RESPONSE') {
      const offer = await tx.organizationRequest.findFirst({ where: { id: current.staffingRequestId!, organizationId, locationId: current.locationId, status: 'PENDING', systemCodeSnapshot: 'STAFFING' } })
      if (!offer || !offer.proposedStartAt || !offer.proposedEndAt || offer.proposedStartAt <= new Date()) throw new ApiError(409, 'STAFFING_CLOSED', 'Подмена уже закрыта или смена началась.')
      const source = await tx.locationMember.findFirst({ where: { memberId: current.createdByMemberId, organizationId, leftAt: null, locationId: { not: current.locationId }, location: { archivedAt: null }, member: { leftAt: null, user: { deletedAt: null } } }, orderBy: { joinedAt: 'asc' } })
      if (!source) throw new ApiError(409, 'STAFFING_MEMBER_UNAVAILABLE', 'Сотрудник больше не состоит в другой действующей точке.')
      await tx.locationTransfer.create({ data: { organizationId, memberId: current.createdByMemberId, createdByMemberId: actor.id, fromLocationId: source.locationId, toLocationId: current.locationId, temporary: true, startAt: offer.proposedStartAt, endAt: offer.proposedEndAt } })
      await activeTarget(tx, organizationId, current.createdByMemberId, offer.proposedStartAt, offer.proposedEndAt)
      await assertNoApprovedAbsence(organizationId, current.createdByMemberId, offer.proposedStartAt, offer.proposedEndAt, actor.organization.timezone, tx, acknowledgeAbsence)
      await checkMonthlyWorkload(tx, organizationId, current.createdByMemberId, actor.organization.timezone, actor.organization.monthlyWorkMinutes, [{ start: offer.proposedStartAt, end: offer.proposedEndAt }], [], acknowledgeWorkload)
      if (await tx.workShift.findFirst({ where: { organizationId, memberId: current.createdByMemberId, status: 'SCHEDULED', scheduledStartAt: { lt: offer.proposedEndAt }, scheduledEndAt: { gt: offer.proposedStartAt } } })) throw new ApiError(409, 'SHIFT_OVERLAP', 'В это время у сотрудника уже есть смена в одной из точек.')
      const shift = await tx.workShift.create({ data: { organizationId, locationId: current.locationId, memberId: current.createdByMemberId, createdByMemberId: actor.id, scheduledStartAt: offer.proposedStartAt, scheduledEndAt: offer.proposedEndAt, positionId: offer.staffingPositionId, positionNameSnapshot: offer.staffingPositionName, description: offer.comment?.slice(0, 500) }, include: { member: true } })
      await tx.organizationRequest.update({ where: { id: current.id }, data: { relatedShiftId: shift.id } })
      await tx.organizationRequest.update({ where: { id: offer.id }, data: { status: 'APPROVED', resolvedAt: new Date(), resolvedByMemberId: actor.id, relatedShiftId: shift.id } })
      await tx.requestEvent.create({ data: { requestId: offer.id, actorMemberId: actor.id, type: 'APPROVED', comment: 'Подмена назначена по подтверждённому отклику.' } })
      await cancelStaffingResponses(tx, offer.id, actor.id, current.id)
      await recordShiftNotification(tx, shift, 'SHIFT_ASSIGNED', actor.organization.timezone)
    }
    if (decision === 'APPROVED' && ['SHIFT_CHANGE', 'SHIFT_PROPOSAL'].includes(current.systemCodeSnapshot ?? '')) {
      if (!current.proposedStartAt || !current.proposedEndAt || current.proposedStartAt <= new Date()) throw new ApiError(409, 'SHIFT_PROPOSAL_PAST', 'Предложенная смена уже началась или не указана.')
      if (current.proposedStartAt && current.proposedEndAt) await activeTarget(tx, organizationId, current.createdByMemberId, current.proposedStartAt, current.proposedEndAt)
      if (current.creator.leftAt || !await tx.organizationMember.findFirst({ where: { id: current.createdByMemberId, organizationId, leftAt: null, user: { deletedAt: null } } })) throw new ApiError(409, 'MEMBER_LEFT', 'Сотрудник больше не состоит в организации.')
      await checkMonthlyWorkload(tx, organizationId, current.createdByMemberId, actor.organization.timezone, actor.organization.monthlyWorkMinutes, [{ start: current.proposedStartAt, end: current.proposedEndAt }], current.relatedShiftId ? [current.relatedShiftId] : [], acknowledgeWorkload)
    }
    if (decision === 'APPROVED' && current.systemCodeSnapshot === 'SHIFT_PROPOSAL') {
      await assertNoApprovedAbsence(organizationId, current.createdByMemberId, current.proposedStartAt!, current.proposedEndAt!, actor.organization.timezone, tx, acknowledgeAbsence)
      if (await tx.workShift.findFirst({ where: { organizationId, memberId: current.createdByMemberId, status: 'SCHEDULED', scheduledStartAt: { lt: current.proposedEndAt! }, scheduledEndAt: { gt: current.proposedStartAt! } } })) throw new ApiError(409, 'SHIFT_OVERLAP', 'В предложенное время уже есть смена.')
      const createdShift = await tx.workShift.create({ data: { organizationId, locationId: current.locationId, memberId: current.createdByMemberId, createdByMemberId: actor.id, scheduledStartAt: current.proposedStartAt!, scheduledEndAt: current.proposedEndAt!, description: current.comment?.slice(0, 500) }, include: { member: true } })
      await tx.organizationRequest.update({ where: { id: requestId }, data: { relatedShiftId: createdShift.id } })
      await recordShiftNotification(tx, createdShift, 'SHIFT_ASSIGNED', actor.organization.timezone)
    }
    if (decision === 'APPROVED' && current.systemCodeSnapshot === 'SHIFT_CHANGE') {
      if (!current.relatedShiftId || !current.originalStartAt || !current.originalEndAt || !current.proposedStartAt || !current.proposedEndAt) throw new ApiError(409, 'SHIFT_PROPOSAL_MISSING', 'В этой заявке нет нового времени смены. Попросите подать её заново.')
      if (current.proposedStartAt <= new Date()) throw new ApiError(409, 'SHIFT_PROPOSAL_PAST', 'Предложенное время уже прошло. Попросите подать новую заявку.')
      const shift = await tx.workShift.findFirst({ where: { id: current.relatedShiftId, organizationId, ...locationWhere(organizationId), memberId: current.createdByMemberId } })
      if (!shift || shift.status !== 'SCHEDULED' || shift.scheduledStartAt <= new Date() || shift.scheduledStartAt.getTime() !== current.originalStartAt.getTime() || shift.scheduledEndAt.getTime() !== current.originalEndAt.getTime()) throw new ApiError(409, 'SHIFT_CHANGED_SINCE_REQUEST', 'Исходная смена уже началась или изменилась. Попросите подать новую заявку.')
      await assertNoApprovedAbsence(organizationId, shift.memberId, current.proposedStartAt, current.proposedEndAt, actor.organization.timezone, tx, acknowledgeAbsence)
      const overlap = await tx.workShift.findFirst({ where: { id: { not: shift.id }, organizationId, memberId: shift.memberId, status: 'SCHEDULED', scheduledStartAt: { lt: current.proposedEndAt }, scheduledEndAt: { gt: current.proposedStartAt } }, select: { id: true } })
      if (overlap) throw new ApiError(409, 'SHIFT_OVERLAP', 'В предложенное время у сотрудника уже есть смена.')
      const changedShift = await tx.workShift.update({ where: { id: shift.id }, data: { scheduledStartAt: current.proposedStartAt, scheduledEndAt: current.proposedEndAt, assignmentReadAt: null }, include: { member: true } })
      await recordShiftNotification(tx, changedShift, 'SHIFT_CHANGED', actor.organization.timezone)
      await cancelShiftRequests(tx, organizationId, [shift.id], actor.id, 'Исходная смена перенесена по другой заявке.', requestId)
    }
    if (decision === 'APPROVED' && current.systemCodeSnapshot && absenceCodes.includes(current.systemCodeSnapshot) && current.startDate && current.endDate) {
      await assertAbsencePeriod(tx, organizationId, current.createdByMemberId, current.startDate, current.endDate)
      await tx.employeeAbsence.create({ data: { organizationId, memberId: current.createdByMemberId, sourceRequestId: current.id, updatedByMemberId: actor.id, type: current.systemCodeSnapshot, startDate: current.startDate, endDate: current.endDate } })
      if (cancelConflictingShifts && liveConflicts.length) await tx.workShift.updateMany({ where: { id: { in: liveConflicts.map((shift) => shift.id) }, status: 'SCHEDULED', scheduledEndAt: { gt: new Date() } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByMemberId: actor.id, cancellationReason: `Одобрено отсутствие по заявке ${requestId}` } })
      for (const conflict of cancelConflictingShifts ? liveConflicts : []) {
        const cancelled = await tx.workShift.findUniqueOrThrow({ where: { id: conflict.id }, include: { member: true } })
        await recordShiftNotification(tx, cancelled, 'SHIFT_CANCELLED', actor.organization.timezone)
      }
      if (cancelConflictingShifts) await cancelShiftRequests(tx, organizationId, liveConflicts.map(shift => shift.id), actor.id, 'Исходная смена отменена из-за одобренного отсутствия.', requestId)
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
  if (current.creator.userId !== userId) {
    const creator = await prisma.user.findUnique({ where: { id: current.creator.userId }, select: { email: true } })
    if (creator) void deliverRequestDecision(creator.email, organizationId, actor.organization.name, requestId, current.typeNameSnapshot, decision, comment, current.locationId).catch(error => console.error('Request-decision email failed:', error))
  }
  return result
}

export async function cancelRequest(userId: string, organizationId: string, requestId: string, systemReason?: string) {
  const actor = await getMembership(userId, organizationId)
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId) } })
  if (!current || current.createdByMemberId !== actor.id) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.organizationRequest.updateMany({ where: { id: requestId, updatedAt: current.updatedAt, status: current.systemCodeSnapshot === 'SICK' ? 'APPROVED' : 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date(), resolutionComment: systemReason || null } })
    if (!updated.count) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Обработанную заявку нельзя отменить.')
    if (current.systemCodeSnapshot === 'SICK') await tx.employeeAbsence.updateMany({ where: { sourceRequestId: requestId, organizationId, cancelledAt: null }, data: { cancelledAt: new Date(), cancelledByMemberId: actor.id, updatedByMemberId: actor.id, cancellationReason: systemReason || 'Сообщение отменено автором' } })
    if (current.systemCodeSnapshot === 'STAFFING') await cancelStaffingResponses(tx, requestId, actor.id)
    await tx.requestEvent.create({ data: { requestId, actorMemberId: actor.id, type: 'CANCELLED', comment: systemReason || null } })
    await tx.accountNotification.updateMany({ where: { requestId, readAt: null }, data: { readAt: new Date() } })
    if (current.systemCodeSnapshot === 'SICK') {
      const absence = await tx.employeeAbsence.findUniqueOrThrow({ where: { sourceRequestId: requestId } })
      await notifyAbsence(tx, organizationId, actor.id, absence.id, 'ABSENCE_CANCELLED', absence.startDate, absence.endDate)
    }
    return true
  }, { isolationLevel: 'Serializable' })
  return changed
}

export async function assertRequestFileAccess(userId: string, organizationId: string, requestId: string) {
  return requestForAccess(userId, organizationId, requestId)
}

async function saveAbsenceRequest(userId: string, organizationId: string, type: { id: string; name: string }, input: CreateInput, current?: { id: string; status: RequestStatus; updatedAt: Date }) {
  const actor = await getMembership(userId, organizationId)
  const employee = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, firstName: true, lastName: true, middleName: true } })
  const parsed = absencePeriodBody.safeParse({ startDate: input.startDate, endDate: input.endDate })
  if (!parsed.success) throw new ApiError(400, 'INVALID_ABSENCE_PERIOD', parsed.error.issues[0].message)
  if (input.comment && input.comment.length > 500) throw new ApiError(400, 'ABSENCE_COMMENT_TOO_LONG', 'Комментарий не должен превышать 500 символов.')
  const startDate = dateValue(parsed.data.startDate)!, endDate = dateValue(parsed.data.endDate)!
  const reason = input.absenceReason ?? 'SICK'
  return prisma.$transaction(async tx => {
    const existing = current ? await tx.employeeAbsence.findUnique({ where: { sourceRequestId: current.id } }) : null
    if (current && ((current.status === 'APPROVED' && !existing) || existing?.cancelledAt)) throw new ApiError(409, 'ABSENCE_CHANGED', 'Отсутствие уже изменено или отменено.')
    await assertAbsencePeriod(tx, organizationId, actor.id, startDate, endDate, existing?.id)
    const data = { startDate, endDate, comment: input.comment?.trim() || null }
    let request
    if (current) {
      const changed = await tx.organizationRequest.updateMany({ where: { id: current.id, organizationId, createdByMemberId: actor.id, status: current.status, updatedAt: current.updatedAt }, data: { ...data, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'SICK', status: 'APPROVED', resolvedAt: current.status === 'PENDING' ? new Date() : undefined, relatedShiftId: null, originalStartAt: null, originalEndAt: null, proposedStartAt: null, proposedEndAt: null } })
      if (!changed.count) throw new ApiError(409, 'REQUEST_CHANGED', 'Сообщение уже изменилось. Откройте его заново.')
      request = await tx.organizationRequest.findUniqueOrThrow({ where: { id: current.id } })
      if (existing) await tx.employeeAbsence.update({ where: { id: existing.id }, data: { ...data, reason, type: reason === 'SICK' ? 'SICK' : 'ABSENCE', updatedByMemberId: actor.id } })
      else await tx.employeeAbsence.create({ data: { ...data, organizationId, memberId: actor.id, sourceRequestId: request.id, type: reason === 'SICK' ? 'SICK' : 'ABSENCE', reason, updatedByMemberId: actor.id } })
    } else {
      request = await tx.organizationRequest.create({ data: { ...data, organizationId, locationId: actor.locationId, createdByMemberId: actor.id, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'SICK', status: 'APPROVED', resolvedAt: new Date() } })
      await tx.employeeAbsence.create({ data: { ...data, organizationId, memberId: actor.id, sourceRequestId: request.id, type: reason === 'SICK' ? 'SICK' : 'ABSENCE', reason, updatedByMemberId: actor.id } })
    }
    await tx.requestEvent.create({ data: { requestId: request.id, actorMemberId: actor.id, type: current ? 'EDITED' : 'CREATED' } })
    const absence = await tx.employeeAbsence.findUniqueOrThrow({ where: { sourceRequestId: request.id } })
    const reviewers = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, OR: [{ role: 'OWNER' }, { role: 'ADMIN' }, { locationMemberships: { some: { role: 'ADMIN', leftAt: null, location: { archivedAt: null, members: { some: { memberId: actor.id, leftAt: null } } } } } }], user: { deletedAt: null } }, select: { userId: true } })
    await tx.accountNotification.updateMany({ where: { requestId: request.id, readAt: null }, data: { readAt: new Date() } })
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map(({ userId: recipient }) => ({ userId: recipient, organizationId, requestId: request.id, absenceId: absence.id, type: current ? 'ABSENCE_CHANGED' as const : 'ABSENCE_REPORTED' as const, title: current ? 'Сообщение об отсутствии изменено' : 'Сотрудник сообщил об отсутствии', message: `${memberName(employee)} · ${parsed.data.startDate}–${parsed.data.endDate}` })) })
    return request
  }, { isolationLevel: 'Serializable' }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') throw new ApiError(409, 'ABSENCE_CONFLICT', 'Отсутствие изменилось одновременно с другим действием. Обновите данные и повторите.')
    throw error
  })
}

async function cancelStaffingResponses(tx: Prisma.TransactionClient, requestId: string, actorMemberId: string, exceptId?: string) {
  const responses = await tx.organizationRequest.findMany({ where: { staffingRequestId: requestId, status: 'PENDING', ...(exceptId ? { id: { not: exceptId } } : {}) }, include: { creator: true } })
  if (!responses.length) return
  await tx.organizationRequest.updateMany({ where: { id: { in: responses.map(item => item.id) } }, data: { status: 'CANCELLED', cancelledAt: new Date(), resolutionComment: 'Заявка на подмену закрыта.' } })
  await tx.requestEvent.createMany({ data: responses.map(item => ({ requestId: item.id, actorMemberId, type: 'CANCELLED', comment: 'Заявка на подмену закрыта.' })) })
  await tx.accountNotification.createMany({ data: responses.map(item => ({ organizationId: item.organizationId, userId: item.creator.userId, requestId: item.id, type: 'REQUEST_CANCELLED', title: 'Подмена закрыта', message: 'Ваш отклик сохранён в истории.' })) })
}
export async function respondToStaffing(userId: string, organizationId: string, requestId: string, comment?: string) {
  const actor = await getMembership(userId, organizationId)
  await ensureSystemTypes(organizationId)
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const offer = await tx.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId), systemCodeSnapshot: 'STAFFING', status: 'PENDING', location: { archivedAt: null } }, include: { location: true } })
    if (!offer || !offer.proposedStartAt || !offer.proposedEndAt || offer.proposedStartAt <= new Date()) throw new ApiError(409, 'STAFFING_CLOSED', 'Заявка уже закрыта или смена началась.')
    const memberships = await tx.locationMember.findMany({ where: { memberId: actor.id, organizationId, leftAt: null, location: { archivedAt: null }, member: { leftAt: null, user: { deletedAt: null } } } })
    if (!memberships.some(item => item.locationId !== offer.locationId) || memberships.some(item => item.locationId === offer.locationId)) throw new ApiError(403, 'STAFFING_OTHER_LOCATION', 'Эта заявка предназначена для сотрудников других точек.')
    await assertNoApprovedAbsence(organizationId, actor.id, offer.proposedStartAt, offer.proposedEndAt, offer.location.timezone, tx)
    if (await tx.workShift.findFirst({ where: { organizationId, memberId: actor.id, status: 'SCHEDULED', scheduledStartAt: { lt: offer.proposedEndAt }, scheduledEndAt: { gt: offer.proposedStartAt } } })) throw new ApiError(409, 'SHIFT_OVERLAP', 'В это время у вас уже есть смена.')
    const type = await tx.requestType.findFirstOrThrow({ where: { organizationId, systemCode: 'STAFFING_RESPONSE' } })
    const response = await tx.organizationRequest.create({ data: { organizationId, locationId: offer.locationId, createdByMemberId: actor.id, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'STAFFING_RESPONSE', staffingRequestId: offer.id, staffingPositionId: offer.staffingPositionId, staffingPositionName: offer.staffingPositionName, proposedStartAt: offer.proposedStartAt, proposedEndAt: offer.proposedEndAt, comment: comment?.trim() || null } })
    await tx.requestEvent.create({ data: { requestId: response.id, actorMemberId: actor.id, type: 'CREATED' } })
    const reviewers = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, OR: [{ role: 'OWNER' }, { locationMemberships: { some: { locationId: offer.locationId, role: 'ADMIN', leftAt: null } } }] }, select: { userId: true } })
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map(item => ({ organizationId, userId: item.userId, requestId: response.id, type: 'REQUEST_CREATED', title: 'Отклик на подмену', message: `${offer.location.name} · ${offer.staffingPositionName}` })) })
    return response
  }, { isolationLevel: 'ReadCommitted' }).catch(error => { if (error?.code === 'P2002') throw new ApiError(409, 'ALREADY_RESPONDED', 'Вы уже откликнулись на эту подмену.'); throw error })
}
