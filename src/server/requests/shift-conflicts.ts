import type { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { locationWhere } from '../organizations/location-context.ts'
import { markRequestNoticesRead,publishRequestNotices } from './request-notifications.ts'

export async function lockShift(tx: Prisma.TransactionClient, shiftId: string) {
  await tx.$queryRaw`SELECT id FROM work_shifts WHERE id = ${shiftId}::uuid FOR UPDATE`
}

async function cancelProposal(tx: Prisma.TransactionClient, request: { id: string; organizationId: string; createdByMemberId: string; updatedAt: Date }, actorMemberId: string | null, reason: string) {
  const now = new Date()
  const status=reason.includes('истекло')?'EXPIRED':reason.includes('отменена')||reason.includes('отменён')?'CANCELLED':'INVALID'
  const changed = await tx.organizationRequest.updateMany({ where: { id: request.id, status: 'PENDING', updatedAt: request.updatedAt }, data: { status, cancelledAt: now, resolutionComment: reason } })
  if (!changed.count) return
  await tx.requestEvent.create({ data: { requestId: request.id, actorMemberId: actorMemberId ?? request.createdByMemberId, type: status, comment: reason,changes:{automatic:true,before:{status:'PENDING'},after:{status}} } })
  await markRequestNoticesRead(tx, { requestId: request.id, type: 'REQUEST_CREATED', readAt: null }, now)
  const creator = await tx.organizationMember.findUniqueOrThrow({ where: { id: request.createdByMemberId }, select: { userId: true } })
  await publishRequestNotices(tx, [{ userId: creator.userId, organizationId: request.organizationId, requestId: request.id, type: 'REQUEST_CANCELLED', title: 'Заявка автоматически отменена', message: reason }])
}

// Same transaction as the schedule mutation: snapshots and event history remain intact.
export async function cancelShiftRequests(tx: Prisma.TransactionClient, organizationId: string, shiftIds: string[], actorMemberId: string | null, reason: string, exceptRequestId?: string) {
  if (!shiftIds.length) return
  const pending = await tx.organizationRequest.findMany({ where: { organizationId, relatedShiftId: { in: shiftIds }, status: 'PENDING', ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}) }, orderBy: { id: 'asc' } })
  for (const request of pending) await cancelProposal(tx, request, actorMemberId, reason)
}

type Proposal = Prisma.OrganizationRequestGetPayload<{ include: { relatedShift: true } }>
function invalidReason(request: Proposal) {
  const shift = request.relatedShift
  const now = new Date()
  if (!shift || shift.status !== 'SCHEDULED') return 'Исходная смена отменена или недоступна.'
  if (shift.memberId !== request.createdByMemberId || !request.originalStartAt || !request.originalEndAt || shift.scheduledStartAt.getTime() !== request.originalStartAt.getTime() || shift.scheduledEndAt.getTime() !== request.originalEndAt.getTime()) return 'Исходная смена изменена. Создайте новую заявку при необходимости.'
  if (shift.scheduledStartAt <= now || !request.proposedStartAt || !request.proposedEndAt || request.proposedStartAt <= now) return 'Время изменения смены истекло. Создайте новую заявку при необходимости.'
  return null
}

// Catch expiry/legacy changes on reads. Valid proposals need neither row locks nor N+1 queries.
export async function reconcileShiftRequests(organizationId: string, bounded = false) {
  const where = { organizationId, ...locationWhere(organizationId), status: 'PENDING' as const, systemCodeSnapshot: 'SHIFT_CHANGE' as const }
  const budget = bounded ? await prisma.organizationResourceBudget.findUniqueOrThrow({where:{organizationId}}) : null
  const pending = await prisma.organizationRequest.findMany({ where: {...where,...(budget?.requestCheckCursor?{id:{gt:budget.requestCheckCursor}}:{})}, include: { relatedShift: true }, ...(bounded?{orderBy:{id:'asc' as const},take:100}:{}) })
  const advance = () => bounded ? prisma.organizationResourceBudget.update({where:{organizationId},data:{requestCheckCursor:pending.length===100?pending.at(-1)!.id:null}}) : Promise.resolve()
  const shiftIds = [...new Set(pending.filter(request => invalidReason(request)).map(request => request.relatedShiftId))].sort()
  if (!shiftIds.length) { await advance(); return }
  await prisma.$transaction(async tx => {
    for (const shiftId of shiftIds) {
      if (shiftId) await lockShift(tx, shiftId)
      const requests = await tx.organizationRequest.findMany({ where: { ...where, relatedShiftId: shiftId, ...(bounded?{id:{in:pending.map(r=>r.id)}}:{}) }, include: { relatedShift: true } })
      for (const request of requests) {
        const reason = invalidReason(request)
        if (reason) await cancelProposal(tx, request, null, reason)
      }
    }
  })
  await advance()
}
