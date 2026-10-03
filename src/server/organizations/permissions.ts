import type { OrganizationRole } from '../../generated/prisma/client.ts'
import { scopedLocationId } from './location-context.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'

export async function getMembership(userId: string, organizationId: string) {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { organization: true, locationMemberships: { where: { leftAt: null, location: { archivedAt: null } } } },
  })
  if (!membership || membership.leftAt || membership.organization.deletedAt) throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
  const selected = scopedLocationId(organizationId)
  const location = await prisma.organizationLocation.findFirst({ where: { organizationId, ...(selected ? { id: selected } : { archivedAt: null }) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (!location || (location.archivedAt && membership.role !== 'OWNER')) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
  const assignment = await prisma.locationMember.findUnique({ where: { locationId_memberId: { locationId: location.id, memberId: membership.id } } })
  const role: OrganizationRole = membership.role === 'OWNER' ? 'OWNER' : selected ? assignment && !assignment.leftAt ? assignment.role : 'MEMBER' : membership.role
  return { ...membership, readableLocationIds: membership.locationMemberships.map(item => item.locationId), managedLocationIds: membership.locationMemberships.filter(item => item.role === 'ADMIN').map(item => item.locationId), role, organizationRole: membership.role, locationId: location.id, assignedLocationId: assignment && !assignment.leftAt ? location.id : null, location, organization: { ...membership.organization, timezone: location.timezone, monthlyWorkMinutes: location.monthlyWorkMinutes } }
}

export function requireOrganizationRole(role: OrganizationRole, allowed: OrganizationRole[]) {
  if (!allowed.includes(role)) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для этого действия.')
}

export function assertCanChangeRole(actor: OrganizationRole, target: OrganizationRole) {
  requireOrganizationRole(actor, ['OWNER', 'ADMIN'])
  if (target === 'OWNER') throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Роль владельца изменяется только через передачу владения.')
}

export function assertCanRemoveMember(actor: OrganizationRole, target: OrganizationRole) {
  requireOrganizationRole(actor, ['OWNER', 'ADMIN'])
  if (target === 'OWNER' || (actor === 'ADMIN' && target !== 'MEMBER')) {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Этого участника нельзя удалить.')
  }
}
