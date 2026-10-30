import { Prisma } from '../../generated/prisma/client.ts'
import { applyRequestDecision } from './request-effects.ts'
import { markRequestNoticesRead,publishRequestNotices } from './request-notifications.ts'

import { definitionOf,requestOutcome } from '../../app/requests/workflow.ts'
import { hasPermission,requirePermission } from '../organizations/access/access.ts'
import { locationWhere,scopedLocationId } from '../organizations/location-context.ts'
import { requireLocationManager } from '../organizations/location-service.ts'
import { notifyAbsence } from '../schedule/absence-service.ts'
import { lockRequest } from './request-lock.ts'
import { notifyStage } from './request-notifications.ts'
import { ensureReviewers,stageReviewers } from './reviewers.ts'

import { lockShift,reconcileShiftRequests } from './shift-conflicts.ts'

import { ApiError } from '../api-error.ts'
import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'

import { requestForAccess } from './request-access.ts'
import { conflictsFor } from './request-conflicts.ts'
import { cancelStaffingResponses } from './staffing-service.ts'

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
    if(decision==='APPROVED'&&current.approvalStep+1<definition.stages.length){const next=await tx.organizationRequest.update({where:{id:requestId},data:{approvalStep:{increment:1}}});const nextReviewers=await ensureReviewers(tx,next);await tx.requestEvent.create({data:{requestId,actorMemberId:actor.id,type:'STAGE_APPROVED',comment,changes:{step:current.approvalStep}}});await tx.requestRead.deleteMany({where:{requestId}});await notifyStage(tx,next,nextReviewers);return next}
    if (scopedLocationId(organizationId)) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`; await requireLocationManager(tx, userId, organizationId, actor.locationId, resolveKey) }
    const liveConflicts = decision === 'APPROVED' ? await conflictsFor(current, actor.organization.timezone, tx) : []
    if (cancelConflictingShifts && liveConflicts.length) {
      const pointIds = [...new Set(liveConflicts.map(shift => shift.locationId))]
      const activePoints = await tx.organizationLocation.count({where:{organizationId,id:{in:pointIds},archivedAt:null}})
      if (activePoints !== pointIds.length) throw new ApiError(404,'LOCATION_NOT_FOUND','Точка не найдена.')
      for (const pointId of pointIds) requirePermission(liveActor,'schedule.cancel',pointId)
    }
    const conflictIds = liveConflicts.map(shift => shift.id)
    if (conflictIds.length) await tx.$queryRaw`SELECT id FROM work_shifts WHERE organization_id = ${organizationId}::uuid AND id = ANY(${conflictIds}::uuid[]) ORDER BY id FOR UPDATE`
    if (current.relatedShiftId) await lockShift(tx, current.relatedShiftId)
    const changed = await tx.organizationRequest.updateMany({ where: { id: requestId, organizationId, ...locationWhere(organizationId), updatedAt: current.updatedAt, status: 'PENDING' }, data: { status: decision, resolvedAt: new Date(), resolvedByMemberId: actor.id, resolutionComment: comment?.trim() || null } })
    if (!changed.count) throw new ApiError(409, 'REQUEST_ALREADY_RESOLVED', 'Заявка уже была обработана.')
    await applyRequestDecision({tx,current,actor,organizationId,requestId,decision,acknowledgeWorkload,acknowledgeAbsence,cancelConflictingShifts,liveConflicts,definition})
    
    await tx.requestEvent.create({ data: { requestId, actorMemberId: actor.id, type: decision, comment: comment?.trim() || null } })
    await markRequestNoticesRead(tx, { requestId, type: 'REQUEST_CREATED', readAt: null }, new Date())
    if (current.creator.userId !== userId) await publishRequestNotices(tx, [{ userId: current.creator.userId, organizationId, requestId, type: decision === 'APPROVED' ? 'REQUEST_APPROVED' : 'REQUEST_REJECTED', title: decision === 'APPROVED' ? 'Заявка одобрена' : 'Заявка отклонена', message: current.typeNameSnapshot }])
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
    await markRequestNoticesRead(tx, { requestId, readAt: null }, new Date())
    if (current.systemCodeSnapshot === 'SICK') {
      const absence = await tx.employeeAbsence.findUniqueOrThrow({ where: { sourceRequestId: requestId } })
      await notifyAbsence(tx, organizationId, actor.id, absence.id, 'ABSENCE_CANCELLED', absence.startDate, absence.endDate)
    }
    return true
  }, { isolationLevel: 'Serializable' })
  return changed
}

export async function returnRequest(userId:string,organizationId:string,requestId:string,comment:string,withdraw=false){
  const {actor,item}=await requestForAccess(userId,organizationId,requestId)
  if(withdraw){if(item.createdByMemberId!==actor.id)throw new ApiError(403,'NOT_AUTHOR','Отозвать может сотрудник.');requirePermission(actor,'requests.edit')}
  else {requirePermission(actor,item.systemCodeSnapshot==='VACATION'?'vacations.resolve':'requests.resolve',item.locationId);if(item.createdByMemberId===actor.id&&!actor.owner)requirePermission(actor,'requests.selfResolve');if(!(await stageReviewers(prisma,item)).some(p=>p.id===actor.id))throw new ApiError(403,'WRONG_REVIEWER','Вы не назначены на этот этап.')}
  if(item.systemCodeSnapshot&&item.systemCodeSnapshot!=='VACATION')throw new ApiError(409,'RETURN_NOT_SUPPORTED','Для этого процесса используйте отмену.')
  return prisma.$transaction(async tx=>{await lockRequest(tx,requestId);const changed=await tx.organizationRequest.updateMany({where:{id:requestId,status:'PENDING',updatedAt:item.updatedAt},data:{status:'RETURNED',resolutionComment:comment}});if(!changed.count)throw new ApiError(409,'REQUEST_CHANGED','Заявка уже изменена.');await tx.requestEvent.create({data:{requestId,actorMemberId:actor.id,type:'RETURNED',comment}});await markRequestNoticesRead(tx, {requestId,readAt:null}, new Date());await publishRequestNotices(tx, [{organizationId,userId:item.creator.userId,requestId,type:'REQUEST_CREATED',title:withdraw?'Заявка отозвана на редактирование':'Заявка возвращена на доработку',message:comment}]);return tx.organizationRequest.findUniqueOrThrow({where:{id:requestId}})})
}

export async function amendVacation(userId:string,org:string,id:string,startDate:string,endDate:string,comment:string){
  const {actor,item}=await requestForAccess(userId,org,id);requirePermission(actor,'requests.create')
  if(item.createdByMemberId!==actor.id||item.systemCodeSnapshot!=='VACATION'||item.status!=='APPROVED'||!item.absence||item.absence.cancelledAt)throw new ApiError(409,'VACATION_UNAVAILABLE','Перенос доступен автору действующего отпуска.')
  return prisma.$transaction(async tx=>{await lockRequest(tx,id);if(await tx.organizationRequest.findFirst({where:{amendmentOfId:id,status:'PENDING'}}))throw new ApiError(409,'AMENDMENT_EXISTS','Перенос уже на рассмотрении.');const r=await tx.organizationRequest.create({data:{organizationId:org,locationId:item.locationId,createdByMemberId:actor.id,authorMemberId:actor.id,requestTypeId:item.requestTypeId,typeNameSnapshot:'Перенос отпуска',systemCodeSnapshot:'VACATION',amendmentOfId:id,formSnapshot:item.formSnapshot as Prisma.InputJsonValue,startDate:new Date(startDate),endDate:new Date(endDate),comment}});await notifyStage(tx,r,await ensureReviewers(tx,r));await tx.requestEvent.create({data:{requestId:r.id,actorMemberId:actor.id,type:'SUBMITTED',changes:{originalRequestId:id}}});return r})
}

export async function completeRequestTask(userId:string,org:string,id:string){
  const {actor,item}=await requestForAccess(userId,org,id),outcome=requestOutcome.safeParse(item.outcome).data
  if(outcome?.kind!=='TASK'||!outcome.assignees?.includes(actor.id)&&!hasPermission(actor,'requests.resolve',item.locationId))throw new ApiError(403,'TASK_FORBIDDEN','Вы не назначены исполнителем.')
  return prisma.$transaction(async tx=>{await lockRequest(tx,id);await tx.organizationRequest.update({where:{id},data:{outcome:{...outcome,status:'DONE'}}});await tx.requestEvent.create({data:{requestId:id,actorMemberId:actor.id,type:'CHANGED',comment:'Задача выполнена.'}})})
}
