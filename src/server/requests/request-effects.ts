import type { Prisma,RequestSystemCode } from '../../generated/prisma/client.ts'
import { publishRequestNotices } from './request-notifications.ts'

import { requirePermission } from '../organizations/access/access.ts'

import { locationWhere } from '../organizations/location-context.ts'
import { assertAbsencePeriod } from '../schedule/absence-service.ts'
import { checkMonthlyWorkload } from '../schedule/workload.ts'
import { cancelShiftRequests } from './shift-conflicts.ts'

import { ApiError } from '../api-error.ts'

import { recordShiftNotification } from '../organizations/notification-service.ts'
import { activeTarget,assertNoApprovedAbsence } from '../schedule/service.ts'
import { absenceCodes,dateText } from './request-input.ts'

import type { RequestDefinition } from '../../app/requests/workflow.ts'
import { conflictsFor } from './request-conflicts.ts'
import type { RequestActor } from './request-model.ts'
import { cancelStaffingResponses } from './staffing-service.ts'
export type DecisionContext = { tx: Prisma.TransactionClient; current: Prisma.OrganizationRequestGetPayload<{include:{creator:true}}>; actor: RequestActor; organizationId: string; requestId: string; decision: 'APPROVED' | 'REJECTED'; acknowledgeWorkload: boolean; acknowledgeAbsence: boolean; cancelConflictingShifts: boolean; liveConflicts: Awaited<ReturnType<typeof conflictsFor>>; definition: RequestDefinition }
type ApprovalHandler = (context: DecisionContext) => Promise<void>

async function approveStaffing(context: DecisionContext) {
 const {tx, current, actor, organizationId, decision, acknowledgeWorkload, acknowledgeAbsence} = context
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
}

async function approveShiftProposal(context: DecisionContext) {
 const {tx, current, actor, organizationId, requestId, decision, acknowledgeWorkload, acknowledgeAbsence} = context
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
}

async function approveShiftChange(context: DecisionContext) {
 const {tx, current, actor, organizationId, requestId, decision, acknowledgeWorkload, acknowledgeAbsence} = context
 if (decision === 'APPROVED' && ['SHIFT_CHANGE', 'SHIFT_PROPOSAL'].includes(current.systemCodeSnapshot ?? '')) {
      if (!current.proposedStartAt || !current.proposedEndAt || current.proposedStartAt <= new Date()) throw new ApiError(409, 'SHIFT_PROPOSAL_PAST', 'Предложенная смена уже началась или не указана.')
      if (current.proposedStartAt && current.proposedEndAt) await activeTarget(tx, organizationId, current.createdByMemberId, current.proposedStartAt, current.proposedEndAt)
      if (current.creator.leftAt || !await tx.organizationMember.findFirst({ where: { id: current.createdByMemberId, organizationId, leftAt: null, user: { deletedAt: null } } })) throw new ApiError(409, 'MEMBER_LEFT', 'Сотрудник больше не состоит в организации.')
      await checkMonthlyWorkload(tx, organizationId, current.createdByMemberId, actor.organization.timezone, actor.organization.monthlyWorkMinutes, [{ start: current.proposedStartAt, end: current.proposedEndAt }], current.relatedShiftId ? [current.relatedShiftId] : [], acknowledgeWorkload)
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
}

async function approveAbsence(context: DecisionContext) {
 const {tx, current, actor, organizationId, requestId, decision, cancelConflictingShifts, liveConflicts} = context
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
}

async function approveCustom(context: DecisionContext) {
 const {tx, current, organizationId, requestId, decision, definition} = context
 if(decision==='APPROVED'&&!current.systemCodeSnapshot){
      const outcome={kind:definition.action,status:definition.action==='TASK'?'OPEN':'DONE',text:current.comment??current.typeNameSnapshot,createdAt:new Date().toISOString(),assignees:definition.recipientMemberIds}
      await tx.organizationRequest.update({where:{id:requestId},data:{outcome}})
      const recipients=await tx.organizationMember.findMany({where:{organizationId,id:{in:definition.recipientMemberIds},leftAt:null}})
      if(recipients.length)await publishRequestNotices(tx, recipients.map(p=>({organizationId,userId:p.userId,requestId,type:'REQUEST_APPROVED',title:definition.action==='TASK'?'Назначена задача по обращению':'Результат обращения',message:current.typeNameSnapshot})))
    }
}

// Every system code has an explicit policy. A new code must choose its side effects.
const approvalHandlers = {
 SICK: null, SICK_LEAVE: null, VACATION: approveAbsence, DAY_OFF: approveAbsence, ABSENCE: approveAbsence,
 SHIFT_PROPOSAL: approveShiftProposal, SHIFT_CHANGE: approveShiftChange, STAFFING: null, STAFFING_RESPONSE: approveStaffing, OTHER: null,
} satisfies Record<RequestSystemCode, ApprovalHandler | null>

export async function applyRequestDecision(context: DecisionContext) {
 const {tx,current,actor,decision}=context
 if(decision==='REJECTED') { if(current.systemCodeSnapshot==='STAFFING')await cancelStaffingResponses(tx,current.id,actor.id);return }
 const handler=current.systemCodeSnapshot?approvalHandlers[current.systemCodeSnapshot]:approveCustom
 if(handler)await handler(context)
}
