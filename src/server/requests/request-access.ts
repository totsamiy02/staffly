import { Prisma } from '../../generated/prisma/client.ts'
import { requestReadSql } from '../access/request-policy.ts'
import { requestInclude } from './request-read.ts'

import { requirePermission } from '../organizations/access/access.ts'

import { locationWhere } from '../organizations/location-context.ts'

import { reconcileShiftRequests } from './shift-conflicts.ts'

import { ApiError } from '../api-error.ts'
import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'

export async function requestForAccess(userId: string, organizationId: string, requestId: string) {
  const actor = await getMembership(userId, organizationId)
  await reconcileShiftRequests(organizationId)
  const item = await prisma.organizationRequest.findFirst({ where: { id: requestId, organizationId, ...locationWhere(organizationId) }, include: { ...requestInclude, requestType: { select: { dateMode: true, requiresComment: true, allowsAttachments: true } } } })
  const roles = await prisma.accessRole.findMany({ where: { organizationId }, select: { id: true, systemCode: true } })
  if (!item || !(await prisma.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT r.id FROM requests r WHERE r.id = ${requestId}::uuid AND ${requestReadSql(actor, roles)}`)).length) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  return { actor, item }
}

export async function assertRequestFileAccess(userId: string, organizationId: string, requestId: string) {
  const result = await requestForAccess(userId, organizationId, requestId)
  if (result.item.createdByMemberId !== result.actor.id && result.item.authorMemberId!==result.actor.id) requirePermission(result.actor, 'requests.attachments', result.item.locationId)
  return result
}
