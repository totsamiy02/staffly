import type { OrganizationRequest,Prisma } from '../../generated/prisma/client.ts'

export const requestInclude = {
  location: { select: { id: true, name: true, timezone: true } },
  _count: { select: { staffingResponses: true } },
  creator: { include: { accessRole:{select:{name:true}},accessAssignments:{include:{role:{select:{name:true}}}},locationMemberships: { where: { leftAt: null } }, user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } },
  resolvedBy: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } },
  relatedShift: true,
  absence: { select: { id:true, reason: true, startDate:true,endDate:true,cancelledAt:true,updatedAt:true } },
  attachments: { include: { storedFile: { select: { mimeType: true, size: true } } }, orderBy: { createdAt: 'asc' } },
  events: { include: { actor: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } } }, orderBy: { createdAt: 'asc' } },
  reads: { orderBy: { readAt: 'asc' } },
} as const

type RequestRow = Prisma.OrganizationRequestGetPayload<{ include: typeof requestInclude }>
type JsonRow = Record<string, unknown>
function record(value: unknown): JsonRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request SQL projection")
  return value as JsonRow
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid request SQL relation")
  return value
}

// Decode only database model columns, never user-defined form/answer/change JSON.
// UTC-model databases preserve the timestamp's actual offset. Date-only fields
// are represented at UTC midnight solely for Prisma's Date-valued API.
function model<T extends object>(value: unknown): T {
  const row = record(value)
  return Object.fromEntries(Object.entries(row).map(([column, value]) => {
    const key = column === '_count' ? column : column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    const date = column.endsWith('_at') || column === 'start_date' || column === 'end_date'
    return [key, date && typeof value === 'string'
      ? new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value) : value]
  })) as T
}

// The single assertion in model<T> describes our server-owned SQL projection.
// Relations are checked as records/arrays; user JSON is never traversed/coerced.
function hydrate(value: unknown): RequestRow {
  const row = record(value), creator = record(row.creator)
  return {
    ...model<OrganizationRequest>(row),
    location: model<RequestRow['location']>(row.location),
    _count: model<RequestRow['_count']>(row._count),
    creator: { ...model<RequestRow['creator']>(creator),
      accessAssignments: array(creator.accessAssignments).map(v => model<RequestRow['creator']['accessAssignments'][number]>(v)),
      locationMemberships: array(creator.locationMemberships).map(v => model<RequestRow['creator']['locationMemberships'][number]>(v)) },
    resolvedBy: row.resolvedBy ? model<NonNullable<RequestRow['resolvedBy']>>(row.resolvedBy) : null,
    relatedShift: row.relatedShift ? model<NonNullable<RequestRow['relatedShift']>>(row.relatedShift) : null,
    absence: row.absence ? model<NonNullable<RequestRow['absence']>>(row.absence) : null,
    attachments: array(row.attachments).map(v => model<RequestRow['attachments'][number]>(v)),
    events: array(row.events).map(v => { const event=record(v); return { ...model<RequestRow['events'][number]>(event), actor: model<RequestRow['events'][number]['actor']>(event.actor) } }),
    reads: array(row.reads).map(v => model<RequestRow['reads'][number]>(v)),
  }
}

// The caller supplies the existing permission/filter predicate and a read-only
// RepeatableRead transaction. Page IDs are selected by Prisma; a single bounded
// SQL projection loads their relation graph instead of a round trip per table.
export async function readRequestPage(tx: Prisma.TransactionClient, organizationId: string,
  where: Prisma.OrganizationRequestWhereInput, page: number, pageSize: number) {
  const total = await tx.organizationRequest.count({ where: { AND: [where, { organizationId }] } })
  const selected = await tx.organizationRequest.findMany({ where: { AND: [where, { organizationId }] },
    select: { id: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize })
  if (!selected.length) return { total, rows: [] as RequestRow[] }
  const ids = selected.map(item => item.id)
  const rows = await tx.$queryRaw<Array<{ item: JsonRow }>>`
    SELECT to_jsonb(r) || jsonb_build_object(
      'location', jsonb_build_object('id', l.id, 'name', l.name, 'timezone', l.timezone),
      '_count', jsonb_build_object('staffingResponses', (SELECT count(*) FROM requests sr WHERE sr.staffing_request_id = r.id)),
      'creator', to_jsonb(m) || jsonb_build_object(
        'user', jsonb_build_object('email', u.email, 'firstName', u.first_name, 'lastName', u.last_name,
          'middleName', u.middle_name, 'avatarFileId', u.avatar_file_id),
        'accessRole', (SELECT jsonb_build_object('name', ar.name) FROM access_roles ar WHERE ar.id = m.access_role_id),
        'accessAssignments', COALESCE((SELECT jsonb_agg(to_jsonb(aa) || jsonb_build_object('role', jsonb_build_object('name', ar.name)))
          FROM access_assignments aa JOIN access_roles ar ON ar.id = aa.role_id WHERE aa.member_id = m.id), '[]'::jsonb),
        'locationMemberships', COALESCE((SELECT jsonb_agg(to_jsonb(lm)) FROM location_members lm WHERE lm.member_id = m.id AND lm.left_at IS NULL), '[]'::jsonb)),
      'resolvedBy', (SELECT to_jsonb(rm) || jsonb_build_object('user', jsonb_build_object('email', ru.email,
        'firstName', ru.first_name, 'lastName', ru.last_name, 'middleName', ru.middle_name))
        FROM organization_members rm JOIN users ru ON ru.id = rm.user_id WHERE rm.id = r.resolved_by_member_id),
      'relatedShift', (SELECT to_jsonb(s) FROM work_shifts s WHERE s.id = r.related_shift_id),
      'absence', (SELECT jsonb_build_object('id', a.id, 'reason', a.reason, 'start_date', a.start_date,
        'end_date', a.end_date, 'cancelled_at', a.cancelled_at, 'updated_at', a.updated_at)
        FROM employee_absences a WHERE a.source_request_id = r.id),
      'attachments', COALESCE((SELECT jsonb_agg(to_jsonb(a) || jsonb_build_object('storedFile',
        jsonb_build_object('mimeType', f.mime_type, 'size', f.size)) ORDER BY a.created_at)
        FROM request_attachments a JOIN stored_files f ON f.id = a.stored_file_id WHERE a.request_id = r.id), '[]'::jsonb),
      'events', COALESCE((SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('actor', to_jsonb(em) || jsonb_build_object('user',
        jsonb_build_object('email', eu.email, 'firstName', eu.first_name, 'lastName', eu.last_name, 'middleName', eu.middle_name))) ORDER BY e.created_at)
        FROM request_events e JOIN organization_members em ON em.id = e.actor_member_id JOIN users eu ON eu.id = em.user_id
        WHERE e.request_id = r.id), '[]'::jsonb),
      'reads', COALESCE((SELECT jsonb_agg(to_jsonb(rr) ORDER BY rr.read_at) FROM request_reads rr WHERE rr.request_id = r.id), '[]'::jsonb)
    ) AS item
    FROM requests r JOIN organization_members m ON m.id = r.created_by_member_id JOIN users u ON u.id = m.user_id
    JOIN organization_locations l ON l.id = r.location_id AND l.organization_id = r.organization_id
    WHERE r.organization_id = ${organizationId}::uuid AND r.id = ANY(${ids}::uuid[])`
  const byId = new Map(rows.map(({ item }) => [item.id, hydrate(item)]))
  return { total, rows: ids.map(id => byId.get(id)!) }
}

