import type { OrganizationRole } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'

export async function getMembership(userId: string, organizationId: string) {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { organization: true },
  })
  if (!membership || membership.leftAt || membership.organization.deletedAt) throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
  return membership
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
