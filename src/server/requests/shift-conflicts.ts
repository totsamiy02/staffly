import type { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'

export async function lockShift(tx: Prisma.TransactionClient, shiftId: string) {
  await tx.$queryRaw`SELECT id FROM work_shifts WHERE id = ${shiftId}::uuid FOR UPDATE`
}

async function cancelProposal(tx: Prisma.TransactionClient, request: { id: string; organizationId: string; createdByMemberId: string; updatedAt: Date }, actorMemberId: string | null, reason: string) {
  const now = new Date()
  const changed = await tx.organizationRequest.updateMany({ where: { id: request.id, status: 'PENDING', updatedAt: request.updatedAt }, data: { status: 'CANCELLED', cancelledAt: now, resolutionComment: reason } })
  if (!changed.count) return
  await tx.requestEvent.create({ data: { requestId: request.id, actorMemberId: actorMemberId ?? request.createdByMemberId, type: 'CANCELLED', comment: reason } })
  await tx.accountNotification.updateMany({ where: { requestId: request.id, type: 'REQUEST_CREATED', readAt: null }, data: { readAt: now } })
  const creator = await tx.organizationMember.findUniqueOrThrow({ where: { id: request.createdByMemberId }, select: { userId: true } })
  await tx.accountNotification.create({ data: { userId: creator.userId, organizationId: request.organizationId, requestId: request.id, type: 'REQUEST_CANCELLED', title: 'Заявка автоматически отменена', message: reason } })
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
export async function reconcileShiftRequests(organizationId: string) {
  const where = { organizationId, status: 'PENDING' as const, systemCodeSnapshot: 'SHIFT_CHANGE' as const }
  const pending = await prisma.organizationRequest.findMany({ where, include: { relatedShift: true } })
  const shiftIds = [...new Set(pending.filter(request => invalidReason(request)).map(request => request.relatedShiftId))].sort()
  if (!shiftIds.length) return
  await prisma.$transaction(async tx => {
    for (const shiftId of shiftIds) {
      if (shiftId) await lockShift(tx, shiftId)
      const requests = await tx.organizationRequest.findMany({ where: { ...where, relatedShiftId: shiftId }, include: { relatedShift: true } })
      for (const request of requests) {
        const reason = invalidReason(request)
        if (reason) await cancelProposal(tx, request, null, reason)
      }
    }
  })
}
