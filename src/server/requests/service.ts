import { definitionOf, processLabel } from '../../app/requests/workflow.ts'
import { lockRequest, validateDefinition, validateAnswers, ensureReviewers, stageReviewers, notifyStage, canReadCustom } from './workflow.ts'
import { hasPermission, requirePermission, locationsFor, permissionRecipients } from '../organizations/access.ts'
import { requireLocationManager } from '../organizations/location-service.ts'
import { locationWhere, locationMemberWhere, scopedLocationId } from '../organizations/location-context.ts'
import { assertAbsencePeriod, absencePeriodBody, notifyAbsence } from '../schedule/absence-service.ts'
import { checkMonthlyWorkload } from '../schedule/workload.ts'
import { cancelShiftRequests, lockShift, reconcileShiftRequests } from './shift-conflicts.ts'
import type { OrganizationRole, Prisma, RequestDateMode, RequestSystemCode, RequestStatus } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/permissions.ts'
import { addCalendarDays, startOfZonedDate, zonedDateTimeToUtc } from '../schedule/timezone.ts'
import { activeTarget, assertNoApprovedAbsence } from '../schedule/service.ts'
import { recordShiftNotification } from '../organizations/notification-service.ts'
import { mediaUrl } from '../storage/image-service.ts'

export const SYSTEM_REQUEST_TYPES = [
  { systemCode: 'SICK', name: 'Сообщить об отсутствии', description: 'Сообщение без согласования. Смены сохраняются, запись остаётся в истории заявок.', dateMode: 'RANGE', requiresComment: false, allowsAttachments: false },
  { systemCode: 'VACATION', name: 'Отпуск', description: 'Плановый период отсутствия', dateMode: 'RANGE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'DAY_OFF', name: 'Отгул', description: 'Отсутствие в течение одного дня', dateMode: 'SINGLE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'ABSENCE', name: 'Освобождение от работы', description: 'Запрос на согласуемое освобождение от работы. Не является сообщением о невыходе или отпуском без оплаты.', dateMode: 'RANGE', requiresComment: true, allowsAttachments: true },
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

}

export async function listRequestTypes(userId: string, organizationId: string, includeInactive = false) {
  await getMembership(userId, organizationId)
  await ensureSystemTypes(organizationId)
  const types=await prisma.requestType.findMany({ where: { organizationId, deletedAt: null, OR: [{ systemCode: null }, { systemCode: { not: 'SICK_LEAVE' } }], ...(!includeInactive ? { isActive: true } : {}) }, orderBy: [{ systemCode: 'asc' }, { name: 'asc' }] })
  return types
}

export async function createRequestType(userId: string, organizationId: string, input: { name: string; description?: string | null; dateMode: RequestDateMode; requiresComment: boolean; allowsAttachments: boolean; definition?: unknown }) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'requestTypes.manage', null)
  const definition = await validateDefinition(prisma, organizationId, input.definition)
  return prisma.requestType.create({ data: { definition, organizationId, name: input.name, description: input.description || null, dateMode: input.dateMode, requiresComment: input.requiresComment, allowsAttachments: input.allowsAttachments } })
}

export async function updateRequestType(userId: string, organizationId: string, typeId: string, input: { name: string; description?: string | null; dateMode: RequestDateMode; requiresComment: boolean; allowsAttachments: boolean; isActive: boolean; definition?: unknown }) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'requestTypes.manage', null)
  const type = await prisma.requestType.findFirst({ where: { id: typeId, organizationId, deletedAt: null } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Тип заявки не найден.')

  if (type.systemCode) {
    if (input.name !== type.name || input.description !== type.description || input.dateMode !== type.dateMode || input.requiresComment !== type.requiresComment || input.allowsAttachments !== type.allowsAttachments) throw new ApiError(409, 'SYSTEM_REQUEST_TYPE', 'У системного типа можно менять только доступность.')
    return prisma.requestType.update({ where: { id: type.id }, data: { isActive: input.isActive } })
  }
  return prisma.requestType.update({ where: { id: type.id }, data: { ...input, definition: await validateDefinition(prisma, organizationId, input.definition ?? type.definition), version: {increment:1}, description: input.description || null } })
}

export type CreateInput = { draft?: boolean; submissionKey?: string; subjectMemberId?: string; answers?: any; staffingPositionId?: string | null; staffingPositionName?: string | null; requestTypeId: string; startDate?: string | null; endDate?: string | null; comment?: string | null; relatedShiftId?: string | null; proposedStartDate?: string | null; proposedStartTime?: string | null; proposedEndDate?: string | null; proposedEndTime?: string | null; absenceReason?: 'SICK' | 'PERSONAL' | 'OTHER' | null }

export async function deleteRequestType(userId: string, organizationId: string, typeId: string) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'requestTypes.manage', null)
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const type = await tx.requestType.findFirst({ where: { id: typeId, organizationId } })
    if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Тип заявки не найден.')
    if (type.systemCode) throw new ApiError(409, 'SYSTEM_REQUEST_TYPE', 'Системный тип нельзя удалить. Можно отключить подачу.')
    if (type.deletedAt) return { deleted: true }
    const used = await tx.organizationRequest.count({ where: { organizationId, requestTypeId: typeId } })
    if (used) await tx.requestType.update({ where: { id: typeId }, data: { isActive: false, deletedAt: new Date() } })
    else await tx.requestType.delete({ where: { id: typeId } })
    return { deleted: true }
  })
}

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
  const author = await getMembership(userId, organizationId)
  let actor = author
  if(input.subjectMemberId && input.subjectMemberId !== author.id){requirePermission(author,'requests.onBehalf');const target=await prisma.organizationMember.findFirst({where:{id:input.subjectMemberId,organizationId,leftAt:null,locationMemberships:{some:{locationId:author.locationId,leftAt:null}}}});if(!target)throw new ApiError(404,'MEMBER_NOT_FOUND','Сотрудник недоступен в этой точке.');actor=await getMembership(target.userId,organizationId)}
  if(input.submissionKey){const previous=await prisma.organizationRequest.findFirst({where:{organizationId,submissionKey:input.submissionKey,authorMemberId:author.id}});if(previous)return previous}
  const actorUser = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, firstName: true, lastName: true, middleName: true } })
  await ensureSystemTypes(organizationId)
  const type = await prisma.requestType.findFirst({ where: { id: input.requestTypeId, organizationId, isActive: true, deletedAt: null } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Активный тип заявки не найден.')
  if (type.systemCode === 'STAFFING_RESPONSE') throw new ApiError(400, 'STAFFING_RESPONSE_ONLY', 'Откликнитесь на открытую заявку на подмену.')
  if (type.systemCode === 'SICK_LEAVE') throw new ApiError(400, 'SICK_REPORT_ONLY', 'Используйте действие «Сообщить о болезни» без согласования.')
  requirePermission(author,type.systemCode==='STAFFING' ? 'staffing.create' : 'requests.create')
  if(author.id!==actor.id && type.systemCode && type.systemCode!=='VACATION')throw new ApiError(400,'ON_BEHALF_TYPE','За другого сотрудника можно оформить отпуск или пользовательское обращение.')
  const definition=definitionOf(type.definition)
  if(definition.submitRoleIds.length&&!author.owner){const roles=await prisma.accessRole.findMany({where:{organizationId,id:{in:definition.submitRoleIds}}});if(!roles.some(r=>author.accessRoleId===r.id||author.accessAssignments.some(a=>a.locationId===author.locationId&&a.roleId===r.id)||!author.accessConfigured&&r.systemCode===author.role))throw new ApiError(403,'SUBMISSION_FORBIDDEN','Роль не может подавать этот тип обращения.')}
  const answers=await validateAnswers(prisma,organizationId,actor.locationId,definition,input.answers)
  validateTypeFields(type, input)
  if (scopedLocationId(organizationId) && !actor.assignedLocationId && actor.role !== 'OWNER' && type.systemCode !== 'STAFFING') throw new ApiError(403, 'MEMBER_NOT_IN_LOCATION', 'Для этой точки используйте отклик на заявку о подмене.')
  if (type.systemCode === 'STAFFING') await requireLocationManager(prisma, userId, organizationId, actor.locationId, 'staffing.create')
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
    if(input.submissionKey){const existing=await tx.organizationRequest.findFirst({where:{organizationId,submissionKey:input.submissionKey,authorMemberId:author.id}});if(existing)return existing}
    if (!await tx.requestType.findFirst({ where: { id: type.id, organizationId, isActive: true, deletedAt: null } })) throw new ApiError(409, 'REQUEST_TYPE_NOT_FOUND', 'Этот тип больше недоступен для новых заявок.')
    if (type.systemCode === 'STAFFING') await requireLocationManager(tx, userId, organizationId, actor.locationId, 'staffing.create')
    if (shift) {
      await lockShift(tx, shift.id)
      const fresh = await tx.workShift.findUniqueOrThrow({ where: { id: shift.id } })
      if (fresh.status !== 'SCHEDULED' || fresh.memberId !== actor.id || fresh.scheduledStartAt <= new Date() || fresh.scheduledStartAt.getTime() !== shift.scheduledStartAt.getTime() || fresh.scheduledEndAt.getTime() !== shift.scheduledEndAt.getTime()) throw new ApiError(409, 'SHIFT_CHANGED_SINCE_REQUEST', 'Смена изменилась. Выберите её заново.')
    }
    const request = await tx.organizationRequest.create({ data: { organizationId, locationId: actor.locationId, createdByMemberId: actor.id, authorMemberId:author.id, submissionKey:input.submissionKey, formSnapshot:{...definition,dateMode:type.dateMode,requiresComment:type.requiresComment,allowsAttachments:type.allowsAttachments,version:type.version}, answers, status:input.draft?"DRAFT":"PENDING", dueAt:input.draft?null:new Date(Date.now()+definition.deadlineDays*86400000), requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: type.systemCode, startDate, endDate, comment: input.comment?.trim() || null, relatedShiftId: input.relatedShiftId || null, originalStartAt: shift?.scheduledStartAt, originalEndAt: shift?.scheduledEndAt, proposedStartAt, proposedEndAt, ...(type.systemCode === 'STAFFING' ? { staffingPositionId: position?.id, staffingPositionName: position?.name ?? input.staffingPositionName } : {}) } })
    await tx.requestEvent.create({ data: { requestId: request.id, actorMemberId: actor.id, type: 'CREATED' } })
    if(input.draft)return request
    if(!type.systemCode || type.systemCode==='VACATION'){await ensureReviewers(tx,request);await notifyStage(tx,request)}
    if (type.systemCode === 'STAFFING') {
      const recipients = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null }, locationMemberships: { some: { leftAt: null, locationId: { not: actor.locationId }, location: { archivedAt: null } }, none: { locationId: actor.locationId, leftAt: null } } }, select: { userId: true } })
      if (recipients.length) await tx.accountNotification.createMany({ data: recipients.map(member => ({ organizationId, userId: member.userId, requestId: request.id, type: 'REQUEST_CREATED', title: 'Нужен сотрудник на подмену', message: `${actor.location.name} · ${position?.name ?? input.staffingPositionName}` })) })
    }
    const reviewers = await permissionRecipients(tx, organizationId, 'requests.resolve', actor.locationId)
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map((reviewer) => ({ userId: reviewer.userId, organizationId, requestId: request.id, type: 'REQUEST_CREATED' as const, title: 'Новая заявка', message: `${memberName(actorUser)} · ${type.name}` })) })
    return request
  })
}

export async function updateRequest(userId: string, organizationId: string, requestId: string, input: CreateInput) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor,'requests.edit')
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId), OR:[{createdByMemberId:actor.id},{authorMemberId:actor.id}] } })
  if (!current) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  if (['STAFFING', 'STAFFING_RESPONSE'].includes(current.systemCodeSnapshot ?? '')) throw new ApiError(409, 'STAFFING_EDIT_LOCKED', 'Чтобы изменить условия подмены, отмените заявку и создайте новую. Отклики сохранятся в истории.')
  const informational = current.systemCodeSnapshot === 'SICK' && ['APPROVED','REGISTERED'].includes(current.status)
  if (!['PENDING','DRAFT','RETURNED'].includes(current.status) && !informational) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Изменить можно только заявку, ожидающую решения.')
  const type = await prisma.requestType.findFirst({ where: { id: input.requestTypeId, organizationId, ...(current.requestTypeId===input.requestTypeId?{}:{isActive:true,deletedAt:null}) } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Выберите доступный тип заявки.')
  if(type.id===current.requestTypeId){const snapshot=definitionOf(current.formSnapshot);type.dateMode=snapshot.dateMode??type.dateMode;type.requiresComment=snapshot.requiresComment??type.requiresComment;type.allowsAttachments=snapshot.allowsAttachments??type.allowsAttachments}
  if (type.systemCode === 'STAFFING') throw new ApiError(409, 'STAFFING_EDIT_LOCKED', 'Создайте отдельную заявку на подмену.')
  if (type.systemCode === 'STAFFING_RESPONSE') throw new ApiError(400, 'STAFFING_RESPONSE_ONLY', 'Откликнитесь на открытую заявку на подмену.')
  if (type.systemCode === 'SICK_LEAVE') throw new ApiError(400, 'SICK_REPORT_ONLY', 'Используйте действие «Сообщить о болезни».')
  if (informational && type.systemCode !== 'SICK') throw new ApiError(409, 'REQUEST_TYPE_LOCKED', 'У сообщения об отсутствии нельзя изменить тип.')
  if(current.createdByMemberId!==actor.id)requirePermission(actor,'requests.onBehalf',current.locationId)
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
    if (current.requestTypeId !== type.id) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
      if (!await tx.requestType.findFirst({ where: { id: type.id, organizationId, isActive: true, deletedAt: null } })) throw new ApiError(409, 'REQUEST_TYPE_NOT_FOUND', 'Этот тип больше недоступен. Выберите другой тип заявки.')
    }
    if (shift) {
      await lockShift(tx, shift.id)
      const fresh = await tx.workShift.findUniqueOrThrow({ where: { id: shift.id } })
      if (fresh.status !== 'SCHEDULED' || fresh.memberId !== actor.id || fresh.scheduledStartAt <= new Date() || fresh.scheduledStartAt.getTime() !== shift.scheduledStartAt.getTime() || fresh.scheduledEndAt.getTime() !== shift.scheduledEndAt.getTime()) throw new ApiError(409, 'SHIFT_CHANGED_SINCE_REQUEST', 'Смена изменилась. Выберите её заново.')
    }
    await lockRequest(tx,requestId)
    const snapshot=current.requestTypeId===type.id?definitionOf(current.formSnapshot):definitionOf(type.definition)
    const answers=await validateAnswers(tx,organizationId,current.locationId,snapshot,input.answers)
    const changed = await tx.organizationRequest.updateMany({ where: { id: requestId, organizationId, ...locationWhere(organizationId), status: current.status, updatedAt: current.updatedAt }, data: { answers, approvalStep:0, formSnapshot:snapshot, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: type.systemCode, startDate, endDate, comment: input.comment?.trim() || null, relatedShiftId: input.relatedShiftId || null, originalStartAt: shift?.scheduledStartAt ?? null, originalEndAt: shift?.scheduledEndAt ?? null, proposedStartAt, proposedEndAt } })
    if (!changed.count) throw new ApiError(409, 'REQUEST_CHANGED', 'Заявка уже изменилась. Откройте её заново.')
    await tx.requestEvent.create({ data: { requestId, actorMemberId: actor.id, type: 'EDITED', changes:{before:JSON.parse(JSON.stringify(current)),after:JSON.parse(JSON.stringify(input))} } })
    if(current.status==='DRAFT'||current.status==='RETURNED')return tx.organizationRequest.findUniqueOrThrow({where:{id:requestId}})
    await tx.requestRead.deleteMany({ where: { requestId } })
    await tx.accountNotification.updateMany({ where: { requestId, type: 'REQUEST_CREATED', readAt: null }, data: { readAt: new Date() } })
    if(!type.systemCode||type.systemCode==='VACATION'){const updated=await tx.organizationRequest.findUniqueOrThrow({where:{id:requestId}});await ensureReviewers(tx,updated);await notifyStage(tx,updated);return updated}
    const reviewers = await permissionRecipients(tx, organizationId, 'requests.resolve', actor.locationId)
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map((reviewer) => ({ userId: reviewer.userId, organizationId, requestId, type: 'REQUEST_CREATED' as const, title: 'Заявка изменена', message: `${memberName(author)} · ${type.name}` })) })
    return tx.organizationRequest.findUniqueOrThrow({ where: { id: requestId } })
  }, { isolationLevel: 'Serializable' })
}

const requestInclude = {
  location: { select: { id: true, name: true, timezone: true } },
  _count: { select: { staffingResponses: true } },
  creator: { include: { accessRole:{select:{name:true}},accessAssignments:{include:{role:{select:{name:true}}}},locationMemberships: { where: { leftAt: null } }, user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } },
  resolvedBy: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } },
  relatedShift: true,
  absence: { select: { id:true, reason: true, startDate:true,endDate:true,cancelledAt:true,updatedAt:true } },
  attachments: { include: { storedFile: { select: { mimeType: true, size: true } } }, orderBy: { createdAt: 'asc' } },
  events: { include: { actor: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } } }, orderBy: { createdAt: 'asc' } },
  reads: { orderBy: { readAt: 'asc' } },
} as const

function publicRequest(item: any, viewerMemberId?: string, actor?: Awaited<ReturnType<typeof getMembership>>) {
  const {creator:_creator,resolvedBy:_resolvedBy,absence:_absence,location:_location,reads:_reads,relatedShift:_relatedShift,requestType:_requestType,_count,...fields}=item
  if (item.requestType) {
    const snapshot = definitionOf(item.formSnapshot)
    fields.formSnapshot = { ...snapshot, dateMode: snapshot.dateMode ?? item.requestType.dateMode, requiresComment: snapshot.requiresComment ?? item.requestType.requiresComment, allowsAttachments: snapshot.allowsAttachments ?? item.requestType.allowsAttachments }
  }
  const own=item.createdByMemberId===viewerMemberId, details=item.systemCodeSnapshot!=='SICK'||own||item.authorMemberId===viewerMemberId || !actor || hasPermission(actor,'absences.details',item.locationId), contacts=own || !actor || hasPermission(actor,'members.contacts',item.locationId)
  return { ...fields, isOwn:own, isAuthor:item.authorMemberId===viewerMemberId, processLabel:item.absence?.cancelledAt?'Отменён':processLabel({...item,startDate:dateText(item.absence?.startDate??item.startDate),endDate:dateText(item.absence?.endDate??item.endDate)}), activeAbsence:item.absence?{...item.absence,reason:details?item.absence.reason:null,startDate:dateText(item.absence.startDate),endDate:dateText(item.absence.endDate)}:null, ...(!details && item.systemCodeSnapshot==='SICK' ? {comment:null,events:[]} : {}), locationName: item.location?.name, timezone: item.location?.timezone, responseCount: item._count?.staffingResponses ?? 0, absenceReason: details ? item.absence?.reason ?? null : null, startDate: dateText(item.startDate), endDate: dateText(item.endDate), creatorName: memberName(item.creator.user), creatorRole: item.creator.role, creatorRoleName:item.creator.accessAssignments?.find((a:any)=>a.locationId===item.locationId)?.role.name??item.creator.accessRole?.name, creatorEmail: contacts ? item.creator.user.email : '', creatorAvatarUrl: mediaUrl(item.creator.user.avatarFileId), resolvedByName: item.resolvedBy ? memberName(item.resolvedBy.user) : null, firstReadAt: item.reads?.[0]?.readAt ?? null, readByViewer: viewerMemberId ? item.reads?.some((read: { memberId: string }) => read.memberId === viewerMemberId) : false, attachments: actor && !own && !hasPermission(actor,'requests.attachments',item.locationId) ? [] : item.attachments?.map((attachment: any) => ({ id: attachment.id, fileName: attachment.fileName, mimeType: attachment.storedFile.mimeType, size: attachment.storedFile.size, downloadUrl: `/api/organizations/${item.organizationId}/requests/${item.id}/attachments/${attachment.id}` })) ?? [], events: item.events?.map((event: any) => ({ id: event.id, type: event.type, comment: !details && item.systemCodeSnapshot==='SICK' ? null : event.comment, changes:details?event.changes:null, createdAt: event.createdAt, actorMemberId: event.actorMemberId, actorName: memberName(event.actor.user) })) ?? [] }
}

type ListOptions = { pointId?: string; page: number; pageSize: number; status?: RequestStatus; typeId?: string; memberId?: string; role?: OrganizationRole; roleId?:string; from?: string; to?: string; search?: string }

export async function listRequests(userId: string, organizationId: string, scope: 'mine' | 'incoming' | 'history' | 'staffing' | 'profile', options: ListOptions) {
  const actor = await getMembership(userId, organizationId)
  const selfProfile = scope === 'profile' && options.memberId === actor.id
  if (scope === 'profile' && !options.memberId) throw new ApiError(400, 'MEMBER_REQUIRED', 'Выберите сотрудника.')
  if (scope === 'mine' || selfProfile) requirePermission(actor, 'requests.own')
  if (scope === 'staffing' && !hasPermission(actor, 'staffing.create')) requirePermission(actor, 'staffing.respond')
  if (!['mine', 'staffing'].includes(scope) && !selfProfile) requirePermission(actor, 'requests.view', options.pointId === 'all' ? undefined : options.pointId ?? actor.locationId)
  const pointScope = scope === 'staffing' ? { location: { archivedAt: null }, ...(options.pointId && options.pointId !== 'all' ? { locationId: options.pointId } : {}) } : options.pointId ? { ...(scope === 'mine' || actor.organizationRole === 'OWNER' ? {} : { locationId: { in: locationsFor(actor, 'requests.view') } }), ...(options.pointId !== 'all' ? { locationId: options.pointId } : {}) } : locationWhere(organizationId)
  if (scope !== 'mine' && scope !== 'staffing' && options.pointId && options.pointId !== 'all') await requireLocationManager(prisma, userId, organizationId, options.pointId, 'requests.view')
  if (scope !== 'mine' && scope !== 'staffing' && !selfProfile && !options.pointId) requirePermission(actor, 'requests.view')
  await reconcileShiftRequests(organizationId)
  const custom=await prisma.organizationRequest.findMany({where:{organizationId,systemCodeSnapshot:null},select:{id:true,createdByMemberId:true,authorMemberId:true,locationId:true,formSnapshot:true,outcome:true}})
  const denied:string[]=[];for(const r of custom)if(!await canReadCustom(prisma,actor,r))denied.push(r.id)
  const selectedRole=options.roleId?await prisma.accessRole.findFirst({where:{organizationId,id:options.roleId},select:{systemCode:true}}):null
  const dateFilters: Prisma.OrganizationRequestWhereInput[] = []
  if (options.from || options.to) {
    const points = await prisma.organizationLocation.findMany({ where: { organizationId }, select: { id: true, timezone: true } })
    dateFilters.push({ OR: [
      { startDate: { ...(options.to ? { lte: dateValue(options.to)! } : {}) }, endDate: { ...(options.from ? { gte: dateValue(options.from)! } : {}) } },
      ...points.map(point => ({ locationId: point.id, proposedStartAt: { ...(options.to ? { lt: startOfZonedDate(addCalendarDays(options.to, 1), point.timezone) } : { not: null }) }, proposedEndAt: { ...(options.from ? { gt: startOfZonedDate(options.from, point.timezone) } : { not: null }) } })),
      { startDate: null, proposedStartAt: null, createdAt: { ...(options.from ? { gte: startOfZonedDate(options.from, actor.organization.timezone) } : {}), ...(options.to ? { lt: startOfZonedDate(addCalendarDays(options.to, 1), actor.organization.timezone) } : {}) } },
    ] })
  }
  const where: Prisma.OrganizationRequestWhereInput = { organizationId, id:{notIn:denied}, ...pointScope,
    ...(scope === 'profile' ? { createdByMemberId: options.memberId, status: options.status ?? (selfProfile ? undefined : { notIn: ['DRAFT', 'RETURNED'] }) } : scope === 'staffing' ? { systemCodeSnapshot: 'STAFFING', status: options.status ?? 'PENDING', proposedStartAt: { gt: new Date() } } : scope === 'mine' ? { OR:[{createdByMemberId:actor.id},{authorMemberId:actor.id},{outcome:{path:['assignees'],array_contains:[actor.id]}}], ...(options.status ? { status: options.status } : {}) } : scope === 'incoming' ? { status: 'PENDING' } : { status: options.status ? options.status : { in: ['APPROVED', 'REGISTERED', 'REJECTED', 'CANCELLED','EXPIRED','INVALID'] } }),
    ...(options.typeId ? { requestTypeId: options.typeId } : {}), ...(options.memberId && scope !== 'mine' ? { createdByMemberId: options.memberId } : {}),
    ...(options.roleId&&scope!=='mine'?{OR:[{creator:{accessRoleId:options.roleId}},...((options.pointId&&options.pointId!=='all')?[options.pointId]:locationsFor(actor,'requests.view')).map(locationId=>({locationId,creator:{OR:[{accessAssignments:{some:{locationId,roleId:options.roleId}}},...(selectedRole?.systemCode==='ADMIN'||selectedRole?.systemCode==='MEMBER'?[{accessConfigured:false,locationMemberships:{some:{locationId,leftAt:null,role:selectedRole.systemCode as 'ADMIN'|'MEMBER'}}}]:[])]}}))]}:options.role && scope !== 'mine' ? { creator: { role: options.role } } : {}),
    AND: [...dateFilters, ...(scope === 'profile' && !selfProfile ? [{ status: { notIn: ['DRAFT', 'RETURNED'] as RequestStatus[] } }] : []), ...(options.search ? options.search.trim().split(/\s+/).map((term) => ({ creator: { user: { OR: [{ email: { contains: term, mode: 'insensitive' as const } }, { firstName: { contains: term, mode: 'insensitive' as const } }, { lastName: { contains: term, mode: 'insensitive' as const } }, { middleName: { contains: term, mode: 'insensitive' as const } }] } } })) : [])],
  }
  const [total, rows] = await prisma.$transaction([prisma.organizationRequest.count({ where }), prisma.organizationRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'desc' }, skip: (options.page - 1) * options.pageSize, take: options.pageSize })])
  const unread = scope === 'incoming' ? await prisma.organizationRequest.count({ where: { ...where, reads: { none: { memberId: actor.id } } } }) : 0
  return { requests: rows.map((item) => publicRequest(item, actor.id, actor)), pagination: { page: options.page, pageSize: options.pageSize, total, pages: Math.max(1, Math.ceil(total / options.pageSize)) }, counters: { pending: scope === 'incoming' ? total : 0, unread } }
}

async function requestForAccess(userId: string, organizationId: string, requestId: string) {
  const actor = await getMembership(userId, organizationId)
  await reconcileShiftRequests(organizationId)
  const item = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId) }, include: { ...requestInclude, requestType: { select: { dateMode: true, requiresComment: true, allowsAttachments: true } } } })
  if (!item || (!hasPermission(actor, 'requests.view') && !(item?.systemCodeSnapshot==='VACATION'&&hasPermission(actor,'vacations.view',item.locationId)) && item.createdByMemberId !== actor.id && item.authorMemberId!==actor.id && !((item.outcome as {assignees?:string[]}|null)?.assignees?.includes(actor.id)&&hasPermission(actor,'requests.own')) && item.systemCodeSnapshot !== 'STAFFING')) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  if(!item.systemCodeSnapshot&&!await canReadCustom(prisma,actor,item))throw new ApiError(404,'REQUEST_NOT_FOUND','Обращение не найдено.')
  if(item.status==='DRAFT'&&item.createdByMemberId!==actor.id&&item.authorMemberId!==actor.id)throw new ApiError(404,'REQUEST_NOT_FOUND','Заявка не найдена.')
  if (item.createdByMemberId === actor.id) requirePermission(actor, 'requests.own')
  if (item.systemCodeSnapshot==='STAFFING' && item.createdByMemberId!==actor.id && !hasPermission(actor,'requests.view')) requirePermission(actor,'staffing.respond')
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
  if (hasPermission(actor, 'requests.view')) {
    const read = await prisma.requestRead.upsert({ where: { requestId_memberId: { requestId, memberId: actor.id } }, create: { requestId, memberId: actor.id }, update: {} })
    if (!item.reads.some((entry) => entry.memberId === actor.id)) item.reads.push(read)
  }
  const staffingResponses = item.systemCodeSnapshot === 'STAFFING' && hasPermission(actor, 'requests.view') ? (await prisma.organizationRequest.findMany({ where: { organizationId, staffingRequestId: item.id }, include: requestInclude, orderBy: { createdAt: 'asc' } })).map(response => publicRequest(response, actor.id, actor)) : []
  const resolveKey=item.systemCodeSnapshot==='VACATION'?'vacations.resolve':['STAFFING','STAFFING_RESPONSE'].includes(item.systemCodeSnapshot??'')?'staffing.resolve':'requests.resolve'
  const canReview=item.status==='PENDING'&&hasPermission(actor,resolveKey,item.locationId)&&(item.createdByMemberId!==actor.id||actor.owner||hasPermission(actor,'requests.selfResolve',item.locationId))&&((!item.systemCodeSnapshot||item.systemCodeSnapshot==='VACATION')?(await stageReviewers(prisma,item)).some(p=>p.id===actor.id):true)
  const ownResponse = item.systemCodeSnapshot === 'STAFFING' ? await prisma.organizationRequest.findFirst({ where: { staffingRequestId: item.id, createdByMemberId: actor.id, status:{in:['PENDING','APPROVED']} }, select: { id: true } }) : null
  const memberships = item.systemCodeSnapshot === 'STAFFING' ? await prisma.locationMember.findMany({ where: { memberId: actor.id, leftAt: null, location: { archivedAt: null } }, select: { locationId: true } }) : []
  return { staffingResponses, viewerResponseId: ownResponse?.id ?? null, viewerCanRespond: hasPermission(actor,'staffing.respond') && !!await prisma.requestType.findFirst({where:{organizationId,systemCode:'STAFFING_RESPONSE',isActive:true}}) && item.status === 'PENDING' && !!item.proposedStartAt && item.proposedStartAt > new Date() && !ownResponse && memberships.some(point => point.locationId !== item.locationId) && !memberships.some(point => point.locationId === item.locationId), request: { ...publicRequest(item, actor.id, actor), canReview, ...(!hasPermission(actor, 'requests.attachments') && item.createdByMemberId !== actor.id ? {attachments:[]} : {}), ...(!hasPermission(actor,'absences.details') && item.createdByMemberId !== actor.id ? {absenceReason:null} : {}) }, conflicts: (await conflictsFor(item, actor.organization.timezone)).filter(shift=>hasPermission(actor,item.createdByMemberId===actor.id?'schedule.own':'schedule.view',shift.locationId)), absenceConflicts: item.status === 'PENDING' && item.systemCodeSnapshot && absenceCodes.includes(item.systemCodeSnapshot) && item.startDate && item.endDate ? (await prisma.employeeAbsence.findMany({ where: { organizationId, memberId: item.createdByMemberId, cancelledAt: null, startDate: { lte: item.endDate }, endDate: { gte: item.startDate } }, select: { id: true, type: true, startDate: true, endDate: true } })).map(a => ({ ...a,type:item.createdByMemberId===actor.id||hasPermission(actor,'absences.details',item.locationId)?a.type:'ABSENCE', startDate: dateText(a.startDate), endDate: dateText(a.endDate) })) : [], otherAbsentEmployees: hasPermission(actor, 'requests.view') && item.startDate && item.endDate ? (await prisma.employeeAbsence.findMany({ where: { organizationId, member: locationMemberWhere(organizationId), memberId: { not: item.createdByMemberId }, cancelledAt: null, startDate: { lte: item.endDate }, endDate: { gte: item.startDate } }, distinct: ['memberId'], select: { memberId: true } })).length : 0 }
}

export async function resolveRequest(userId: string, organizationId: string, requestId: string, decision: 'APPROVED' | 'REJECTED', comment: string | null | undefined, cancelConflictingShifts = false, acknowledgeWorkload = false, acknowledgeAbsence = false) {
  const actor = await getMembership(userId, organizationId)
  if (!hasPermission(actor,'requests.resolve') && !hasPermission(actor,'staffing.resolve')&&!hasPermission(actor,'vacations.resolve')) requirePermission(actor,'requests.resolve')
  await reconcileShiftRequests(organizationId)
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId) }, include: { creator: true } })
  if (!current) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  const resolveKey = current.systemCodeSnapshot==='VACATION'?'vacations.resolve' as const:['STAFFING','STAFFING_RESPONSE'].includes(current.systemCodeSnapshot??'') ? 'staffing.resolve' as const : 'requests.resolve' as const
  requirePermission(actor,resolveKey,current.locationId)
  if(current.createdByMemberId===actor.id&&!actor.owner)requirePermission(actor,'requests.selfResolve',current.locationId)
  if((!current.systemCodeSnapshot||current.systemCodeSnapshot==='VACATION')&&!(await stageReviewers(prisma,current)).some(p=>p.id===actor.id))throw new ApiError(403,'WRONG_REVIEWER','Этот этап должен рассмотреть назначенный согласующий.')
  if (current.systemCodeSnapshot === 'SICK') throw new ApiError(409, 'INFORMATIONAL_REQUEST', 'Сообщение об отсутствии не требует решения.')
  if (decision === 'REJECTED' && !comment?.trim()) throw new ApiError(400, 'RESOLUTION_COMMENT_REQUIRED', 'Укажите причину отклонения.')
  if (decision === 'APPROVED' && current.systemCodeSnapshot === 'STAFFING') throw new ApiError(409, 'STAFFING_RESPONSE_REQUIRED', 'Подтвердите отклик сотрудника, чтобы назначить подмену.')
  if (decision === 'APPROVED' && current.systemCodeSnapshot === 'SICK_LEAVE') throw new ApiError(409, 'SICK_REPORT_ONLY', 'Болезнь больше не требует одобрения. Сотруднику нужно сообщить о болезни через новое действие; старая заявка остаётся в истории.')
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    const liveActor=await getMembership(userId,organizationId,tx);requirePermission(liveActor,resolveKey,current.locationId)
    await lockRequest(tx,requestId)
    const fresh=await tx.organizationRequest.findUniqueOrThrow({where:{id:requestId}})
    if(fresh.status!=='PENDING')throw new ApiError(409,'REQUEST_ALREADY_RESOLVED','Заявка уже была обработана.');if(fresh.updatedAt.getTime()!==current.updatedAt.getTime())throw new ApiError(409,'REQUEST_CHANGED','Обращение уже изменилось.')
    const definition=definitionOf(current.formSnapshot)
    if(decision==='APPROVED'&&current.approvalStep+1<definition.stages.length){const next=await tx.organizationRequest.update({where:{id:requestId},data:{approvalStep:{increment:1}}});await ensureReviewers(tx,next);await tx.requestEvent.create({data:{requestId,actorMemberId:actor.id,type:'STAGE_APPROVED',comment,changes:{step:current.approvalStep}}});await tx.requestRead.deleteMany({where:{requestId}});await notifyStage(tx,next);return next}
    if (scopedLocationId(organizationId)) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`; await requireLocationManager(tx, userId, organizationId, actor.locationId, resolveKey) }
    const liveConflicts = decision === 'APPROVED' ? await conflictsFor(current, actor.organization.timezone, tx) : []
    if (cancelConflictingShifts) for (const locationId of new Set(liveConflicts.map(shift => shift.locationId))) await requireLocationManager(tx, userId, organizationId, locationId, 'schedule.cancel')
    for (const id of liveConflicts.map(shift => shift.id).sort()) await lockShift(tx, id)
    if (current.relatedShiftId) await lockShift(tx, current.relatedShiftId)
    const changed = await tx.organizationRequest.updateMany({ where: { id: requestId, organizationId, ...locationWhere(organizationId), updatedAt: current.updatedAt, status: 'PENDING' }, data: { status: decision, resolvedAt: new Date(), resolvedByMemberId: actor.id, resolutionComment: comment?.trim() || null } })
    if (!changed.count) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Заявка уже была обработана.')
    if (decision === 'REJECTED' && current.systemCodeSnapshot === 'STAFFING') await cancelStaffingResponses(tx, current.id, actor.id)
    if (decision==='APPROVED' && ['SHIFT_PROPOSAL','STAFFING_RESPONSE'].includes(current.systemCodeSnapshot??'')) requirePermission(actor,'schedule.create',current.locationId)
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
    if (decision==='APPROVED' && current.systemCodeSnapshot==='SHIFT_CHANGE') requirePermission(actor,'schedule.edit',current.locationId)
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
      if(current.systemCodeSnapshot==='VACATION'&&liveConflicts.length&&!cancelConflictingShifts)throw new ApiError(409,'UNRESOLVED_SHIFTS','Сначала освободите пересекающиеся смены или подтвердите их отмену.')
      const previous=current.amendmentOfId?await tx.employeeAbsence.findUnique({where:{sourceRequestId:current.amendmentOfId}}):null
      if(current.amendmentOfId&&(!previous||previous.cancelledAt))throw new ApiError(409,'VACATION_CHANGED','Исходный отпуск уже отменён.')
      if(previous&&previous.startDate<=new Date())throw new ApiError(409,'VACATION_STARTED','Перенос начавшегося отпуска оформляет руководитель отдельным действием.')
      await assertAbsencePeriod(tx, organizationId, current.createdByMemberId, current.startDate, current.endDate,previous?.id)
      if(previous){await tx.employeeAbsence.update({where:{id:previous.id},data:{startDate:current.startDate,endDate:current.endDate,updatedByMemberId:actor.id}});await tx.requestEvent.create({data:{requestId:current.amendmentOfId!,actorMemberId:actor.id,type:'CHANGED',comment:current.comment,changes:{before:{startDate:dateText(previous.startDate),endDate:dateText(previous.endDate)},after:{startDate:dateText(current.startDate),endDate:dateText(current.endDate)},requestId:current.id,employeeConsent:true}}})}
      else await tx.employeeAbsence.create({ data: { organizationId, memberId: current.createdByMemberId, sourceRequestId: current.id, updatedByMemberId: actor.id, type: current.systemCodeSnapshot, startDate: current.startDate, endDate: current.endDate } })
      if (cancelConflictingShifts && liveConflicts.length) await tx.workShift.updateMany({ where: { id: { in: liveConflicts.map((shift) => shift.id) }, status: 'SCHEDULED', scheduledEndAt: { gt: new Date() } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByMemberId: actor.id, cancellationReason: `Одобрено отсутствие по заявке ${requestId}` } })
      for (const conflict of cancelConflictingShifts ? liveConflicts : []) {
        const cancelled = await tx.workShift.findUniqueOrThrow({ where: { id: conflict.id }, include: { member: true } })
        await recordShiftNotification(tx, cancelled, 'SHIFT_CANCELLED', actor.organization.timezone)
      }
      if (cancelConflictingShifts) await cancelShiftRequests(tx, organizationId, liveConflicts.map(shift => shift.id), actor.id, 'Исходная смена отменена из-за одобренного отсутствия.', requestId)
    }
    if(decision==='APPROVED'&&!current.systemCodeSnapshot){
      const outcome={kind:definition.action,status:definition.action==='TASK'?'OPEN':'DONE',text:current.comment??current.typeNameSnapshot,createdAt:new Date().toISOString(),assignees:definition.recipientMemberIds}
      await tx.organizationRequest.update({where:{id:requestId},data:{outcome}})
      const recipients=await tx.organizationMember.findMany({where:{organizationId,id:{in:definition.recipientMemberIds},leftAt:null}})
      if(recipients.length)await tx.accountNotification.createMany({data:recipients.map(p=>({organizationId,userId:p.userId,requestId,type:'REQUEST_APPROVED',title:definition.action==='TASK'?'Назначена задача по обращению':'Результат обращения',message:current.typeNameSnapshot}))})
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

  return result
}

export async function cancelRequest(userId: string, organizationId: string, requestId: string, systemReason?: string) {
  const actor = await getMembership(userId, organizationId); requirePermission(actor, 'requests.edit')
  const current = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId) } })
  if (!current || current.createdByMemberId !== actor.id) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.organizationRequest.updateMany({ where: { id: requestId, updatedAt: current.updatedAt, status: current.systemCodeSnapshot === 'SICK' ? {in:['APPROVED','REGISTERED']} : {in:['PENDING','DRAFT','RETURNED']} }, data: { status: 'CANCELLED', cancelledAt: new Date(), resolutionComment: systemReason || null } })
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
  const result = await requestForAccess(userId, organizationId, requestId)
  if (result.item.createdByMemberId !== result.actor.id && result.item.authorMemberId!==result.actor.id) requirePermission(result.actor, 'requests.attachments')
  return result
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
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    if(input.submissionKey&&!current){const saved=await tx.organizationRequest.findFirst({where:{organizationId,submissionKey:input.submissionKey,createdByMemberId:actor.id}});if(saved)return saved}
    const existing = current ? await tx.employeeAbsence.findUnique({ where: { sourceRequestId: current.id } }) : null
    if (current && ((['APPROVED','REGISTERED'].includes(current.status) && !existing) || existing?.cancelledAt)) throw new ApiError(409, 'ABSENCE_CHANGED', 'Отсутствие уже изменено или отменено.')
    await assertAbsencePeriod(tx, organizationId, actor.id, startDate, endDate, existing?.id)
    const data = { startDate, endDate, comment: input.comment?.trim() || null }
    let request
    if (current) {
      const changed = await tx.organizationRequest.updateMany({ where: { id: current.id, organizationId, createdByMemberId: actor.id, status: current.status, updatedAt: current.updatedAt }, data: { ...data, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'SICK', status: 'REGISTERED', resolvedAt: current.status === 'PENDING' ? new Date() : undefined, relatedShiftId: null, originalStartAt: null, originalEndAt: null, proposedStartAt: null, proposedEndAt: null } })
      if (!changed.count) throw new ApiError(409, 'REQUEST_CHANGED', 'Сообщение уже изменилось. Откройте его заново.')
      request = await tx.organizationRequest.findUniqueOrThrow({ where: { id: current.id } })
      if (existing) await tx.employeeAbsence.update({ where: { id: existing.id }, data: { ...data, reason, type: reason === 'SICK' ? 'SICK' : 'ABSENCE', updatedByMemberId: actor.id } })
      else await tx.employeeAbsence.create({ data: { ...data, organizationId, memberId: actor.id, sourceRequestId: request.id, type: reason === 'SICK' ? 'SICK' : 'ABSENCE', reason, updatedByMemberId: actor.id } })
    } else {
      request = await tx.organizationRequest.create({ data: { ...data, organizationId, locationId: actor.locationId, createdByMemberId: actor.id,authorMemberId:actor.id,submissionKey:input.submissionKey, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'SICK', status: 'REGISTERED', resolvedAt: new Date() } })
      await tx.employeeAbsence.create({ data: { ...data, organizationId, memberId: actor.id, sourceRequestId: request.id, type: reason === 'SICK' ? 'SICK' : 'ABSENCE', reason, updatedByMemberId: actor.id } })
    }
    await tx.requestEvent.create({ data: { requestId: request.id, actorMemberId: actor.id, type: current ? 'EDITED' : 'CREATED', changes:current?{after:{startDate:parsed.data.startDate,endDate:parsed.data.endDate,reason,comment:input.comment??null}}:undefined } })
    const absence = await tx.employeeAbsence.findUniqueOrThrow({ where: { sourceRequestId: request.id } })
    const reviewers = await permissionRecipients(tx, organizationId, 'absences.view', actor.locationId)
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
  const actor = await getMembership(userId, organizationId); requirePermission(actor, 'staffing.respond')
  await ensureSystemTypes(organizationId)
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const offer = await tx.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId), systemCodeSnapshot: 'STAFFING', status: 'PENDING', location: { archivedAt: null } }, include: { location: true } })
    if (!offer || !offer.proposedStartAt || !offer.proposedEndAt || offer.proposedStartAt <= new Date()) throw new ApiError(409, 'STAFFING_CLOSED', 'Заявка уже закрыта или смена началась.')
    const memberships = await tx.locationMember.findMany({ where: { memberId: actor.id, organizationId, leftAt: null, location: { archivedAt: null }, member: { leftAt: null, user: { deletedAt: null } } } })
    if (!memberships.some(item => item.locationId !== offer.locationId) || memberships.some(item => item.locationId === offer.locationId)) throw new ApiError(403, 'STAFFING_OTHER_LOCATION', 'Эта заявка предназначена для сотрудников других точек.')
    await assertNoApprovedAbsence(organizationId, actor.id, offer.proposedStartAt, offer.proposedEndAt, offer.location.timezone, tx)
    if (await tx.workShift.findFirst({ where: { organizationId, memberId: actor.id, status: 'SCHEDULED', scheduledStartAt: { lt: offer.proposedEndAt }, scheduledEndAt: { gt: offer.proposedStartAt } } })) throw new ApiError(409, 'SHIFT_OVERLAP', 'В это время у вас уже есть смена.')
    if(await tx.organizationRequest.findFirst({where:{staffingRequestId:requestId,createdByMemberId:actor.id,status:{in:['PENDING','APPROVED']}}}))throw new ApiError(409,'ALREADY_RESPONDED','У вас уже есть активный отклик.')
    const type = await tx.requestType.findFirstOrThrow({ where: { organizationId, systemCode: 'STAFFING_RESPONSE' } })
    if(!type.isActive)throw new ApiError(409,'REQUEST_TYPE_DISABLED','Новые отклики отключены в настройках.')
    const response = await tx.organizationRequest.create({ data: { organizationId, locationId: offer.locationId, createdByMemberId: actor.id, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'STAFFING_RESPONSE', staffingRequestId: offer.id, staffingPositionId: offer.staffingPositionId, staffingPositionName: offer.staffingPositionName, proposedStartAt: offer.proposedStartAt, proposedEndAt: offer.proposedEndAt, comment: comment?.trim() || null } })
    await tx.requestEvent.create({ data: { requestId: response.id, actorMemberId: actor.id, type: 'CREATED' } })
    const reviewers = await permissionRecipients(tx, organizationId, 'staffing.resolve', offer.locationId)
    if (reviewers.length) await tx.accountNotification.createMany({ data: reviewers.map(item => ({ organizationId, userId: item.userId, requestId: response.id, type: 'REQUEST_CREATED', title: 'Отклик на подмену', message: `${offer.location.name} · ${offer.staffingPositionName}` })) })
    return response
  }, { isolationLevel: 'ReadCommitted' }).catch(error => { if (error?.code === 'P2002') throw new ApiError(409, 'ALREADY_RESPONDED', 'Вы уже откликнулись на эту подмену.'); throw error })
}

export async function submitRequest(userId:string,organizationId:string,requestId:string){
  const actor=await getMembership(userId,organizationId);requirePermission(actor,'requests.edit')
  return prisma.$transaction(async tx=>{
    await lockRequest(tx,requestId)
    const item=await tx.organizationRequest.findFirst({where:{id:requestId,organizationId,...locationWhere(organizationId),OR:[{createdByMemberId:actor.id},{authorMemberId:actor.id}]},include:{requestType:true,attachments:true}})
    if(!item)throw new ApiError(404,'REQUEST_NOT_FOUND','Обращение не найдено.')
    if(item.createdByMemberId!==actor.id)requirePermission(actor,'requests.onBehalf',item.locationId)
    if(item.status==='PENDING')return item
    if(!['DRAFT','RETURNED'].includes(item.status))throw new ApiError(409,'REQUEST_CLOSED','Обращение уже закрыто.')
    const d=definitionOf(item.formSnapshot)
    await validateAnswers(tx,organizationId,item.locationId,d,item.answers)
    if(d.fields.some(f=>f.kind==='FILE'&&f.required)&&!item.attachments.length)throw new ApiError(400,'FILE_REQUIRED','Добавьте обязательное вложение.')
    const result=await tx.organizationRequest.update({where:{id:requestId},data:{status:'PENDING',approvalStep:0,dueAt:new Date(Date.now()+d.deadlineDays*86400000),remindedAt:null}})
    if(!item.systemCodeSnapshot||item.systemCodeSnapshot==='VACATION'){await ensureReviewers(tx,result);await notifyStage(tx,result)}
    else {const people=await permissionRecipients(tx,organizationId,item.systemCodeSnapshot==='STAFFING'?'staffing.resolve':'requests.resolve',item.locationId);if(people.length)await tx.accountNotification.createMany({data:people.map(p=>({organizationId,userId:p.userId,requestId,type:'REQUEST_CREATED',title:'Новая заявка',message:item.typeNameSnapshot}))})}
    await tx.requestRead.deleteMany({where:{requestId}})
    await tx.requestEvent.create({data:{requestId,actorMemberId:actor.id,type:'SUBMITTED'}})
    return result
  },{isolationLevel:'Serializable'})
}
export async function returnRequest(userId:string,organizationId:string,requestId:string,comment:string,withdraw=false){
  const {actor,item}=await requestForAccess(userId,organizationId,requestId)
  if(withdraw){if(item.createdByMemberId!==actor.id)throw new ApiError(403,'NOT_AUTHOR','Отозвать может сотрудник.');requirePermission(actor,'requests.edit')}
  else {requirePermission(actor,item.systemCodeSnapshot==='VACATION'?'vacations.resolve':'requests.resolve',item.locationId);if(item.createdByMemberId===actor.id&&!actor.owner)requirePermission(actor,'requests.selfResolve');if(!(await stageReviewers(prisma,item)).some(p=>p.id===actor.id))throw new ApiError(403,'WRONG_REVIEWER','Вы не назначены на этот этап.')}
  if(item.systemCodeSnapshot&&item.systemCodeSnapshot!=='VACATION')throw new ApiError(409,'RETURN_NOT_SUPPORTED','Для этого процесса используйте отмену.')
  return prisma.$transaction(async tx=>{await lockRequest(tx,requestId);const changed=await tx.organizationRequest.updateMany({where:{id:requestId,status:'PENDING',updatedAt:item.updatedAt},data:{status:'RETURNED',resolutionComment:comment}});if(!changed.count)throw new ApiError(409,'REQUEST_CHANGED','Заявка уже изменена.');await tx.requestEvent.create({data:{requestId,actorMemberId:actor.id,type:'RETURNED',comment}});await tx.accountNotification.updateMany({where:{requestId,readAt:null},data:{readAt:new Date()}});await tx.accountNotification.create({data:{organizationId,userId:item.creator.userId,requestId,type:'REQUEST_CREATED',title:withdraw?'Заявка отозвана на редактирование':'Заявка возвращена на доработку',message:comment}});return tx.organizationRequest.findUniqueOrThrow({where:{id:requestId}})})
}

export async function amendVacation(userId:string,org:string,id:string,startDate:string,endDate:string,comment:string){
  const {actor,item}=await requestForAccess(userId,org,id);requirePermission(actor,'requests.create')
  if(item.createdByMemberId!==actor.id||item.systemCodeSnapshot!=='VACATION'||item.status!=='APPROVED'||!item.absence||item.absence.cancelledAt)throw new ApiError(409,'VACATION_UNAVAILABLE','Перенос доступен автору действующего отпуска.')
  return prisma.$transaction(async tx=>{await lockRequest(tx,id);if(await tx.organizationRequest.findFirst({where:{amendmentOfId:id,status:'PENDING'}}))throw new ApiError(409,'AMENDMENT_EXISTS','Перенос уже на рассмотрении.');const r=await tx.organizationRequest.create({data:{organizationId:org,locationId:item.locationId,createdByMemberId:actor.id,authorMemberId:actor.id,requestTypeId:item.requestTypeId,typeNameSnapshot:'Перенос отпуска',systemCodeSnapshot:'VACATION',amendmentOfId:id,formSnapshot:item.formSnapshot as Prisma.InputJsonValue,startDate:new Date(startDate),endDate:new Date(endDate),comment}});await ensureReviewers(tx,r);await notifyStage(tx,r);await tx.requestEvent.create({data:{requestId:r.id,actorMemberId:actor.id,type:'SUBMITTED',changes:{originalRequestId:id}}});return r})
}
export async function completeRequestTask(userId:string,org:string,id:string){
  const {actor,item}=await requestForAccess(userId,org,id),outcome=item.outcome as {kind?:string;status?:string;assignees?:string[]}|null
  if(outcome?.kind!=='TASK'||!outcome.assignees?.includes(actor.id)&&!hasPermission(actor,'requests.resolve',item.locationId))throw new ApiError(403,'TASK_FORBIDDEN','Вы не назначены исполнителем.')
  return prisma.$transaction(async tx=>{await lockRequest(tx,id);await tx.organizationRequest.update({where:{id},data:{outcome:{...outcome,status:'DONE'}}});await tx.requestEvent.create({data:{requestId:id,actorMemberId:actor.id,type:'CHANGED',comment:'Задача выполнена.'}})})
}
