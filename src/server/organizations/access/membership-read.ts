import type { AccessAssignment, AccessRole, LocationMember, Organization, OrganizationLocation, OrganizationMember, Prisma } from '../../../generated/prisma/client.ts'

type Row = Record<string, unknown>
// JSON timestamps contain their actual offset; calendar/answer JSON stays opaque.
function model<T>(row: Row): T {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => {
    const key = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    return [key, key.endsWith('At') && typeof value === 'string' ? new Date(value) : value]
  })) as T
}

// One statement/snapshot for read authorization. No cross-request permission
// cache: the very next request sees removals, role edits and archived locations.
export async function readMembership(db: Prisma.TransactionClient, userId: string, organizationId: string) {
  const [row] = await db.$queryRaw<Array<{ member: Row; organization: Row; assignments: Row[]; placements: Array<Row & { activeLocation: boolean }>; roles: Row[]; locations: Row[] }>>`
    SELECT to_jsonb(m) AS member, to_jsonb(o) AS organization,
      COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM access_assignments a WHERE a.organization_id = m.organization_id AND a.member_id = m.id), '[]') AS assignments,
      COALESCE((SELECT jsonb_agg(to_jsonb(lm) || jsonb_build_object('activeLocation', l.archived_at IS NULL))
        FROM location_members lm JOIN organization_locations l ON l.organization_id = lm.organization_id AND l.id = lm.location_id
        WHERE lm.organization_id = m.organization_id AND lm.member_id = m.id), '[]') AS placements,
      COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.system_code ASC, r.created_at ASC)
        FROM access_roles r WHERE r.organization_id = m.organization_id), '[]') AS roles,
      COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at ASC, l.id ASC)
        FROM organization_locations l WHERE l.organization_id = m.organization_id AND (m.role = 'OWNER' OR l.archived_at IS NULL)), '[]') AS locations
    FROM organization_members m JOIN organizations o ON o.id = m.organization_id
    WHERE m.organization_id = ${organizationId}::uuid AND m.user_id = ${userId}::uuid`
  if (!row) return null
  const placements = row.placements.map(({ activeLocation, ...item }) => ({ placement: model<LocationMember>(item), activeLocation }))
  return {
    membership: { ...model<OrganizationMember>(row.member), organization: model<Organization>(row.organization),
      accessAssignments: row.assignments.map(item => model<AccessAssignment>(item)),
      locationMemberships: placements.filter(item => item.activeLocation && !item.placement.leftAt).map(item => item.placement),
      _count: { locationMemberships: placements.length } },
    placements: placements.map(item => item.placement),
    roles: row.roles.map(item => model<AccessRole>(item)),
    locations: row.locations.map(item => model<OrganizationLocation>(item)),
  }
}
