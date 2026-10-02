import { AsyncLocalStorage } from 'node:async_hooks'
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import type { AuthenticatedRequest } from '../auth.ts'
import type { Prisma } from '../../generated/prisma/client.ts'

// A scope belongs to one HTTP request. Services still check live membership and role.
export const locationContext = new AsyncLocalStorage<{ organizationId: string; locationId: string }>()
export function scopedLocationId(organizationId: string) {
  const scope = locationContext.getStore()
  return scope?.organizationId === organizationId ? scope.locationId : undefined
}
export function locationWhere(organizationId: string) {
  const locationId = scopedLocationId(organizationId)
  return locationId ? { locationId } : {}
}
export function locationMemberWhere(organizationId: string): Prisma.OrganizationMemberWhereInput {
  const locationId = scopedLocationId(organizationId)
  return locationId ? { OR: [
    { locationMemberships: { some: { locationId, leftAt: null } } },
    { locationTransfers: { some: { toLocationId: locationId, temporary: true, endAt: { gt: new Date() } } } },
  ] } : {}
}
export const selectLocation: RequestHandler = async (request, _response, next) => {
  try {
    const organizationId = z.uuid().parse(request.params.organizationId)
    const selected = request.query.locationId ?? request.get('x-staffly-location')
    const requestedId = selected === undefined ? undefined : z.uuid().parse(selected)
    const membership = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: (request as AuthenticatedRequest).auth!.userId } }, include: { organization: true } })
    if (!membership || membership.leftAt || membership.organization.deletedAt) throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
    const location = await prisma.organizationLocation.findFirst({ where: { organizationId, ...(requestedId ? { id: requestedId } : { archivedAt: null }) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    if (!location) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
    if (location.archivedAt && membership.role !== 'OWNER') throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка закрыта.')
    locationContext.run({ organizationId, locationId: location.id }, next)
  } catch (error) {
    next(error instanceof z.ZodError ? new ApiError(400, 'VALIDATION_ERROR', 'Некорректная точка организации.') : error)
  }
}
