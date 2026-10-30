import type { Prisma } from '../../generated/prisma/client.ts'
import type { Actor } from './request-policy.ts'
import { locationsFor } from '../organizations/access/access.ts'

// Profile identity is visible only within a permitted point. Historical shifts
// keep a former profile readable, but never grant access to a former avatar.
export function memberIdentityWhere(actor: Actor, points = locationsFor(actor,'members.view'), historical = true): Prisma.OrganizationMemberWhereInput {
  if (actor.owner) return { organizationId: actor.organizationId, user: { deletedAt: null } }
  return { organizationId: actor.organizationId, user: { deletedAt: null }, OR: [
    { id: actor.id }, ...(actor.owner ? [{}] : points.length ? [
      { role: 'OWNER' as const }, { accessRoleId: { not: null } },
      { locationMemberships: { some: { locationId: { in: points }, leftAt: null, location: { archivedAt: null } } } },
      { accessAssignments: { some: { locationId: { in: points } } } },
      { locationTransfers: { some: { toLocationId: { in: points }, temporary: true, revokedAt: null, endAt: { gt: new Date() } } } },
      ...(historical ? [{ workShifts: { some: { locationId: { in: points } } } }] : []),
    ] : []),
  ] }
}
