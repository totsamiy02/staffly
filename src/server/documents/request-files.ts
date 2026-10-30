import { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { requirePermission } from '../organizations/access/access.ts'
import { permissionSql, requestReadSql } from '../access/request-policy.ts'

// A system folder is a live view over original attachments, never a second
// document/file copy. The same request + attachment permissions protect rows,
// counts and bytes. Downloads re-authorize through the existing request API.
export async function listRequestFiles(userId: string, organizationId: string, options: { page: number; search: string; pointId?: string }) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'documents.view')
  const roles = await prisma.accessRole.findMany({ where: { organizationId }, select: { id: true, systemCode: true } })
  const search = `%${options.search.replace(/[\\%_]/g, '\\$&')}%`
  const source = Prisma.sql`FROM request_attachments a JOIN stored_files f ON f.id=a.stored_file_id
    JOIN requests r ON r.id=a.request_id JOIN organization_locations l ON l.id=r.location_id AND l.organization_id=r.organization_id
    JOIN organization_members m ON m.id=r.created_by_member_id JOIN users u ON u.id=m.user_id
    WHERE r.organization_id=${organizationId}::uuid AND f.organization_id=${organizationId}::uuid
    AND f.purpose='REQUEST_ATTACHMENT' AND f.purged_at IS NULL AND f.pending_deletion_at IS NULL
    AND ${requestReadSql(actor, roles)}
    AND (r.created_by_member_id=${actor.id}::uuid OR r.author_member_id=${actor.id}::uuid OR ${permissionSql(actor, 'requests.attachments', Prisma.sql`r.location_id`)})
    AND (${options.pointId ?? null}::uuid IS NULL OR r.location_id=${options.pointId ?? null}::uuid)
    AND (${!options.search} OR a.file_name ILIKE ${search} OR r.type_name_snapshot ILIKE ${search})`
  return prisma.$transaction(async db => {
    const [count] = await db.$queryRaw<Array<{ total: bigint; bytes: bigint }>>(Prisma.sql`SELECT count(*) AS total, COALESCE(sum(f.size),0)::bigint AS bytes ${source}`)
    const pageSize = 20, pages = Math.max(1, Math.ceil(Number(count.total) / pageSize)), page = Math.min(options.page, pages)
    const rows = await db.$queryRaw<Array<{ id: string; requestId: string; fileName: string; mimeType: string; size: number; createdAt: Date; locationId: string; locationName: string; typeName: string; status: string; creatorName: string }>>(Prisma.sql`
      SELECT a.id,a.request_id AS "requestId",a.file_name AS "fileName",f.mime_type AS "mimeType",f.size,a.created_at AS "createdAt",
      r.location_id AS "locationId",l.name AS "locationName",r.type_name_snapshot AS "typeName",r.status::text AS status,
      COALESCE(NULLIF(trim(concat_ws(' ',u.last_name,u.first_name,u.middle_name)),''),u.email) AS "creatorName"
      ${source} ORDER BY a.created_at DESC,a.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    return { files: rows.map(row => ({ ...row, requestHref: `/app/organizations/${organizationId}/requests?tab=mine&request=${row.requestId}&location=${row.locationId}`, downloadPath: `/organizations/${organizationId}/requests/${row.requestId}/attachments/${row.id}?locationId=${row.locationId}` })), totalBytes: Number(count.bytes), pagination: { page, pageSize, total: Number(count.total), pages } }
  }, { isolationLevel: 'RepeatableRead' })
}
