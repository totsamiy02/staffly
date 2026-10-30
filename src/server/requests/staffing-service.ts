import { Prisma } from '../../generated/prisma/client.ts'
import { publishRequestNotices } from './request-notifications.ts'

import { permissionRecipients,requirePermission } from '../organizations/access/access.ts'

import { locationWhere } from '../organizations/location-context.ts'

import { ApiError } from '../api-error.ts'
import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'

import { assertNoApprovedAbsence } from '../schedule/service.ts'

import { ensureSystemTypes } from './type-service.ts'

export async function cancelStaffingResponses(tx: Prisma.TransactionClient, requestId: string, actorMemberId: string, exceptId?: string) {
  const responses = await tx.organizationRequest.findMany({ where: { staffingRequestId: requestId, status: 'PENDING', ...(exceptId ? { id: { not: exceptId } } : {}) }, include: { creator: true } })
  if (!responses.length) return
  await tx.organizationRequest.updateMany({ where: { id: { in: responses.map(item => item.id) } }, data: { status: 'CANCELLED', cancelledAt: new Date(), resolutionComment: 'Заявка на подмену закрыта.' } })
  await tx.requestEvent.createMany({ data: responses.map(item => ({ requestId: item.id, actorMemberId, type: 'CANCELLED', comment: 'Заявка на подмену закрыта.' })) })
  await publishRequestNotices(tx, responses.map(item => ({ organizationId: item.organizationId, userId: item.creator.userId, requestId: item.id, type: 'REQUEST_CANCELLED', title: 'Подмена закрыта', message: 'Ваш отклик сохранён в истории.' })))
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
    if (reviewers.length) await publishRequestNotices(tx, reviewers.map(item => ({ organizationId, userId: item.userId, requestId: response.id, type: 'REQUEST_CREATED', title: 'Отклик на подмену', message: `${offer.location.name} · ${offer.staffingPositionName}` })))
    return response
  }, { isolationLevel: 'ReadCommitted' }).catch((error: unknown) => { if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new ApiError(409, 'ALREADY_RESPONDED', 'Вы уже откликнулись на эту подмену.'); throw error })
}
