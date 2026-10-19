import { ensureAccessRoles, resolveAccess } from './access.ts'
import type { OrganizationRole, Prisma } from '../../../generated/prisma/client.ts'
import { scopedLocationId } from '../location-context.ts'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'

export async function getMembership(userId: string, organizationId: string, db: Prisma.TransactionClient = prisma) {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { organization: true, _count: {select:{locationMemberships:true}}, accessAssignments: true, locationMemberships: { where: { leftAt: null, location: { archivedAt: null } } } },
  })
  if (!membership || membership.leftAt || membership.organization.deletedAt) throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
  const roles = await ensureAccessRoles(db, organizationId)
  const allLocations = await db.organizationLocation.findMany({ where: { organizationId, ...(membership.role === 'OWNER' ? {} : { archivedAt: null }) }, select: { id: true } })
  const selected = scopedLocationId(organizationId)
  const location = await db.organizationLocation.findFirst({ where: { organizationId, ...(selected ? { id: selected } : { archivedAt: null }) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (!location || (location.archivedAt && membership.role !== 'OWNER')) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
  const assignment = await db.locationMember.findUnique({ where: { locationId_memberId: { locationId: location.id, memberId: membership.id } } })
  const role: OrganizationRole = membership.role === 'OWNER' ? 'OWNER' : selected ? assignment && !assignment.leftAt ? assignment.role : 'MEMBER' : membership.role
  const access = resolveAccess(membership, roles, allLocations.map(l => l.id), selected)
  // Legacy memberships follow the current standard role, including after an invitation
  // or a point transfer. Seeded assignment rows must not freeze an old placement.
  const accessAssignments = membership.accessConfigured ? membership.accessAssignments : membership.locationMemberships.map(item => ({ organizationId, memberId: membership.id, locationId: item.locationId, roleId: roles.find(r => r.systemCode === item.role)!.id }))
  return { ...membership, accessAssignments, ...access, readableLocationIds: [...new Set([...membership.locationMemberships.map(item => item.locationId), ...accessAssignments.map(item => item.locationId), ...(membership.accessRoleId ? allLocations.map(l => l.id) : [])])], managedLocationIds: allLocations.filter(l => roles.some(r => r.systemCode === 'ADMIN' && (membership.accessRoleId === r.id || (membership.accessConfigured ? membership.accessAssignments.some(a => a.locationId === l.id && a.roleId === r.id) : membership.locationMemberships.some(a => a.locationId === l.id && a.role === 'ADMIN'))))).map(l => l.id), role, organizationRole: membership.role, locationId: location.id, assignedLocationId: assignment && !assignment.leftAt ? location.id : null, location, organization: { ...membership.organization, timezone: location.timezone, monthlyWorkMinutes: location.monthlyWorkMinutes } }
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
