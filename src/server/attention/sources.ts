import { Prisma } from '../../generated/prisma/client.ts';
import { requestReadSql, type Actor } from '../access/request-policy.ts';
import { documentReadSql } from '../access/document-policy.ts';

export type RequestAction = {
  id: string; organizationId: string; locationId: string; createdByMemberId: string;
  formSnapshot: unknown; approvalStep: number; systemCodeSnapshot: string | null;
  status: string; dueAt: Date | null; outcome: unknown; typeNameSnapshot: string;
  person: string; locationName: string; timezone: string;
};
export async function* requestActions(db: Prisma.TransactionClient, organizationId: string, options: {
  actor?: Actor; roles?: Array<{ id: string; systemCode: string | null }>; pointId?: string; id?: string;
} = {}) {
  let cursor: string | null = null;
  for (;;) {
    const rows: RequestAction[] = await db.$queryRaw(Prisma.sql`
      SELECT r.id, r.organization_id AS "organizationId", r.location_id AS "locationId",
        r.created_by_member_id AS "createdByMemberId", r.form_snapshot AS "formSnapshot",
        r.approval_step AS "approvalStep", r.system_code_snapshot::text AS "systemCodeSnapshot",
        r.status::text, r.due_at AS "dueAt", r.outcome, r.type_name_snapshot AS "typeNameSnapshot",
        COALESCE(NULLIF(concat_ws(' ',u.last_name,u.first_name,u.middle_name),''),'Сотрудник') AS person,
        l.name AS "locationName", l.timezone
      FROM requests r JOIN organization_locations l ON l.id=r.location_id
      JOIN organization_members m ON m.id=r.created_by_member_id JOIN users u ON u.id=m.user_id
      WHERE r.organization_id=${organizationId}::uuid AND l.archived_at IS NULL
        AND ((r.status='PENDING' AND r.system_code_snapshot IS DISTINCT FROM 'STAFFING')
          OR (r.status='APPROVED' AND r.outcome->>'kind'='TASK' AND r.outcome->>'status'='OPEN'))
        ${options.actor ? Prisma.sql`AND ${requestReadSql(options.actor, options.roles ?? [])}` : Prisma.empty}
        ${options.pointId ? Prisma.sql`AND r.location_id=${options.pointId}::uuid` : Prisma.empty}
        ${options.id ? Prisma.sql`AND r.id=${options.id}::uuid` : Prisma.empty}
        ${cursor ? Prisma.sql`AND r.id>${cursor}::uuid` : Prisma.empty}
      ORDER BY r.id LIMIT 500`);
    for (const row of rows) yield row;
    if (rows.length < 500) return;
    cursor = rows.at(-1)!.id;
  }
}

export type DocumentAction = {
  id: string; documentId: string; memberId: string; userId: string; organizationId: string;
  title: string; deadline: string | null; assignedAt: Date; locationId: string | null;
  locationName: string; timezone: string;
};
export async function* documentActions(db: Prisma.TransactionClient, organizationId: string, options: {
  actor?: Actor; pointId?: string; id?: string; remindersAt?: Date;
} = {}) {
  let cursor: string | null = null;
  for (;;) {
    const rows: DocumentAction[] = await db.$queryRaw(Prisma.sql`
      SELECT a.id, a.document_id AS "documentId", a.member_id AS "memberId", m.user_id AS "userId",
        d.organization_id AS "organizationId", d.display_name AS title, a.deadline::text,
        a.assigned_at AS "assignedAt", d.location_id AS "locationId",
        COALESCE(l.name,'Общие документы') AS "locationName", COALESCE(l.timezone,o.timezone) AS timezone
      FROM document_acknowledgements a JOIN documents d ON d.id=a.document_id
      JOIN organizations o ON o.id=d.organization_id LEFT JOIN organization_locations l ON l.id=d.location_id
      JOIN organization_members m ON m.id=a.member_id JOIN users u ON u.id=m.user_id
      WHERE d.organization_id=${organizationId}::uuid AND d.deleted_at IS NULL
        AND a.cancelled_at IS NULL AND a.acknowledged_at IS NULL AND m.left_at IS NULL AND u.deleted_at IS NULL
        AND (d.location_id IS NULL OR l.archived_at IS NULL)
        ${options.actor ? Prisma.sql`AND ${documentReadSql(options.actor)}` : Prisma.empty}
        ${options.pointId ? Prisma.sql`AND d.location_id=${options.pointId}::uuid` : Prisma.empty}
        ${options.id ? Prisma.sql`AND a.id=${options.id}::uuid` : Prisma.empty}
        ${options.remindersAt ? Prisma.sql`AND a.deadline IS NOT NULL
          AND (a.deadline < (${options.remindersAt}::timestamptz AT TIME ZONE COALESCE(l.timezone,o.timezone))::date
            OR a.deadline = (${options.remindersAt}::timestamptz AT TIME ZONE COALESCE(l.timezone,o.timezone))::date + 1)
          AND NOT EXISTS (SELECT 1 FROM account_notifications n WHERE n.document_id=d.id AND n.user_id=m.user_id
            AND n.type::text='DOCUMENT_REMINDER' AND n.email_context->'attention'->>'sourceId'=a.id::text
            AND n.email_context->'attention'->>'deadline'=a.deadline::text
            AND (n.email_context->'attention'->>'assignedAt')::timestamptz=a.assigned_at
            AND n.email_context->'attention'->>'phase'=CASE WHEN a.deadline < (${options.remindersAt}::timestamptz AT TIME ZONE COALESCE(l.timezone,o.timezone))::date THEN 'OVERDUE' ELSE 'SOON' END)` : Prisma.empty}
        ${cursor ? Prisma.sql`AND a.id>${cursor}::uuid` : Prisma.empty}
      ORDER BY a.id LIMIT 500`);
    for (const row of rows) yield row;
    if (rows.length < 500) return;
    cursor = rows.at(-1)!.id;
  }
}
