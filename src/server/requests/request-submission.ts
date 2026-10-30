import { definitionOf } from '../../app/requests/workflow.ts'
import { permissionRecipients,requirePermission } from '../organizations/access/access.ts'
import { locationWhere,scopedLocationId } from '../organizations/location-context.ts'
import { requireLocationManager } from '../organizations/location-service.ts'
import { absencePeriodBody,assertAbsencePeriod } from '../schedule/absence-service.ts'
import { lockRequest } from './request-lock.ts'
import { markRequestNoticesRead,notifyStage,publishRequestNotices } from './request-notifications.ts'
import { ensureReviewers } from './reviewers.ts'
import { validateAnswers } from './workflow-validation.ts'

import type { RequestStatus } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { activeTarget } from '../schedule/service.ts'
import { zonedDateTimeToUtc } from '../schedule/timezone.ts'
import { lockShift } from './shift-conflicts.ts'

import { dateValue,memberName,validateTypeFields,type CreateInput } from './request-input.ts'
import { ensureSystemTypes } from './type-service.ts'

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
    // Independent vacation/free-form submissions may proceed together. Shared
    // locks still exclude membership, role, folder and organization transitions.
    if (type.systemCode === 'VACATION' || type.systemCode === 'OTHER') {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${organizationId}, 1))::text`
    } else await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    if (input.submissionKey) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId + ':' + input.submissionKey}, 2))::text`
    const currentAuthor = await getMembership(userId, organizationId, tx)
    requirePermission(currentAuthor, type.systemCode === 'STAFFING' ? 'staffing.create' : 'requests.create')
    if (scopedLocationId(organizationId) && !currentAuthor.assignedLocationId && currentAuthor.role !== 'OWNER' && type.systemCode !== 'STAFFING') throw new ApiError(403, 'MEMBER_NOT_IN_LOCATION', 'Сотрудник больше не назначен в эту точку.')
    if (definition.submitRoleIds.length && !currentAuthor.owner) {
      const roles = await tx.accessRole.findMany({ where: { organizationId, id: { in: definition.submitRoleIds } } })
      if (!roles.some(role => currentAuthor.accessRoleId === role.id || currentAuthor.accessAssignments.some(assignment => assignment.locationId === currentAuthor.locationId && assignment.roleId === role.id) || !currentAuthor.accessConfigured && role.systemCode === currentAuthor.role)) throw new ApiError(403, 'SUBMISSION_FORBIDDEN', 'Роль не может подавать этот тип обращения.')
    }
    if (author.id !== actor.id) {
      requirePermission(currentAuthor, 'requests.onBehalf')
      const target = await getMembership(actor.userId, organizationId, tx)
      if (target.id !== actor.id || target.locationId !== actor.locationId || !target.assignedLocationId) throw new ApiError(409, 'MEMBER_CHANGED', 'Состав сотрудников изменился. Повторите запрос.')
    }
    await tx.$queryRaw`SELECT id FROM request_types WHERE id = ${type.id}::uuid AND organization_id = ${organizationId}::uuid FOR SHARE`
    if(input.submissionKey){const existing=await tx.organizationRequest.findFirst({where:{organizationId,submissionKey:input.submissionKey,authorMemberId:author.id}});if(existing)return existing}
    if (!await tx.requestType.findFirst({ where: { id: type.id, organizationId, version: type.version, isActive: true, deletedAt: null } })) throw new ApiError(409, 'REQUEST_TYPE_NOT_FOUND', 'Этот тип изменился или больше недоступен для новых заявок.')
    if (type.systemCode === 'STAFFING') await requireLocationManager(tx, userId, organizationId, actor.locationId, 'staffing.create')
    if (shift) {
      await lockShift(tx, shift.id)
      const fresh = await tx.workShift.findUniqueOrThrow({ where: { id: shift.id } })
      if (fresh.status !== 'SCHEDULED' || fresh.memberId !== actor.id || fresh.scheduledStartAt <= new Date() || fresh.scheduledStartAt.getTime() !== shift.scheduledStartAt.getTime() || fresh.scheduledEndAt.getTime() !== shift.scheduledEndAt.getTime()) throw new ApiError(409, 'SHIFT_CHANGED_SINCE_REQUEST', 'Смена изменилась. Выберите её заново.')
    }
    const request = await tx.organizationRequest.create({ data: { organizationId, locationId: actor.locationId, createdByMemberId: actor.id, authorMemberId:author.id, submissionKey:input.submissionKey, formSnapshot:{...definition,dateMode:type.dateMode,requiresComment:type.requiresComment,allowsAttachments:type.allowsAttachments,version:type.version}, answers, status:input.draft?"DRAFT":"PENDING", dueAt:input.draft?null:new Date(Date.now()+definition.deadlineDays*86400000), requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: type.systemCode, startDate, endDate, comment: input.comment?.trim() || null, relatedShiftId: input.relatedShiftId || null, originalStartAt: shift?.scheduledStartAt, originalEndAt: shift?.scheduledEndAt, proposedStartAt, proposedEndAt, ...(type.systemCode === 'STAFFING' ? { staffingPositionId: position?.id, staffingPositionName: position?.name ?? input.staffingPositionName } : {}) } })
    await tx.requestEvent.create({ data: { requestId: request.id, actorMemberId: actor.id, type: 'CREATED' } })
    if(input.draft)return request
    if(!type.systemCode || type.systemCode==='VACATION')await notifyStage(tx,request,await ensureReviewers(tx,request))
    if (type.systemCode === 'STAFFING') {
      const recipients = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null }, locationMemberships: { some: { leftAt: null, locationId: { not: actor.locationId }, location: { archivedAt: null } }, none: { locationId: actor.locationId, leftAt: null } } }, select: { userId: true } })
      if (recipients.length) await publishRequestNotices(tx, recipients.map(member => ({ organizationId, userId: member.userId, requestId: request.id, type: 'REQUEST_CREATED', title: 'Нужен сотрудник на подмену', message: `${actor.location.name} · ${position?.name ?? input.staffingPositionName}` })))
    }
    const reviewers = await permissionRecipients(tx, organizationId, 'requests.resolve', actor.locationId)
    if (reviewers.length) await publishRequestNotices(tx, reviewers.map((reviewer) => ({ userId: reviewer.userId, organizationId, requestId: request.id, type: 'REQUEST_CREATED' as const, title: 'Новая заявка', message: `${memberName(actorUser)} · ${type.name}` })))
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
    await markRequestNoticesRead(tx, { requestId, type: 'REQUEST_CREATED', readAt: null }, new Date())
    if(!type.systemCode||type.systemCode==='VACATION'){const updated=await tx.organizationRequest.findUniqueOrThrow({where:{id:requestId}});await notifyStage(tx,updated,await ensureReviewers(tx,updated));return updated}
    const reviewers = await permissionRecipients(tx, organizationId, 'requests.resolve', actor.locationId)
    if (reviewers.length) await publishRequestNotices(tx, reviewers.map((reviewer) => ({ userId: reviewer.userId, organizationId, requestId, type: 'REQUEST_CREATED' as const, title: 'Заявка изменена', message: `${memberName(author)} · ${type.name}` })))
    return tx.organizationRequest.findUniqueOrThrow({ where: { id: requestId } })
  }, { isolationLevel: 'Serializable' })
}

export async function saveAbsenceRequest(userId: string, organizationId: string, type: { id: string; name: string }, input: CreateInput, current?: { id: string; status: RequestStatus; updatedAt: Date }) {
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
    await markRequestNoticesRead(tx, { requestId: request.id, readAt: null }, new Date())
    if (reviewers.length) await publishRequestNotices(tx, reviewers.map(({ userId: recipient }) => ({ userId: recipient, organizationId, requestId: request.id, absenceId: absence.id, type: current ? 'ABSENCE_CHANGED' as const : 'ABSENCE_REPORTED' as const, title: current ? 'Сообщение об отсутствии изменено' : 'Сотрудник сообщил об отсутствии', message: `${memberName(employee)} · ${parsed.data.startDate}–${parsed.data.endDate}` })))
    return request
  }, { isolationLevel: 'Serializable' }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') throw new ApiError(409, 'ABSENCE_CONFLICT', 'Отсутствие изменилось одновременно с другим действием. Обновите данные и повторите.')
    throw error
  })
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
    if(!item.systemCodeSnapshot||item.systemCodeSnapshot==='VACATION'){await notifyStage(tx,result,await ensureReviewers(tx,result))}
    else {const people=await permissionRecipients(tx,organizationId,item.systemCodeSnapshot==='STAFFING'?'staffing.resolve':'requests.resolve',item.locationId);if(people.length)await publishRequestNotices(tx, people.map(p=>({organizationId,userId:p.userId,requestId,type:'REQUEST_CREATED',title:'Новая заявка',message:item.typeNameSnapshot})))}
    await tx.requestRead.deleteMany({where:{requestId}})
    await tx.requestEvent.create({data:{requestId,actorMemberId:actor.id,type:'SUBMITTED'}})
    return result
  },{isolationLevel:'Serializable'})
}
