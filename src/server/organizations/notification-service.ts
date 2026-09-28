import { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { formatNotificationPeriod } from '../../app/organizations/notification-format.ts'
import { getMembership } from './permissions.ts'
import { ApiError } from '../api-error.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { deliverShiftAssignment } from '../mail.ts'

const labels = { SHIFT_ASSIGNED: 'Назначена смена', SHIFT_CHANGED: 'Смена изменена', SHIFT_CANCELLED: 'Смена отменена' } as const
export type ShiftEventType = keyof typeof labels

type ShiftEvent = { id: string; organizationId: string; scheduledStartAt: Date; scheduledEndAt: Date; member: { userId: string } }
export async function recordShiftNotification(tx: Prisma.TransactionClient, shift: ShiftEvent, type: ShiftEventType, timezone: string) {
  return tx.accountNotification.create({ data: { userId: shift.member.userId, organizationId: shift.organizationId, shiftId: shift.id, type, title: labels[type], message: formatNotificationPeriod(shift.scheduledStartAt, shift.scheduledEndAt, timezone) } })
}

export function isUrgentShiftEmail(start: Date, end: Date, now = new Date()) {
  return end > now && start.getTime() <= now.getTime() + 24 * 60 * 60 * 1000
}

// A durable reservation makes simultaneous bulk operations share the same email limit.
export async function reserveShiftEmail(notificationId: string, userId: string, organizationId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))::text`
    const sent = await tx.accountNotification.findFirst({ where: { userId, organizationId, emailAttemptedAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } }, select: { id: true } })
    if (sent) return false
    const reserved = await tx.accountNotification.updateMany({ where: { id: notificationId, userId, organizationId, emailAttemptedAt: null }, data: { emailAttemptedAt: now } })
    return reserved.count === 1
  })
}

export async function sendImportantShiftEmail(notificationId: string, shift: ShiftEvent, email: string, organizationName: string, timezone: string, type: ShiftEventType, previous?: { scheduledStartAt: Date; scheduledEndAt: Date }) {
  if (!isUrgentShiftEmail(shift.scheduledStartAt, shift.scheduledEndAt) && !(previous && isUrgentShiftEmail(previous.scheduledStartAt, previous.scheduledEndAt))) return
  if (!await reserveShiftEmail(notificationId, shift.member.userId, shift.organizationId)) return
  await deliverShiftAssignment(email, shift.organizationId, organizationName, shift.scheduledStartAt, shift.scheduledEndAt, timezone, shift.id, type)
}

type HistoryRow = { actionable: boolean; documentId: string | null; absenceId: string | null; id: string; source: 'event' | 'invite'; type: string; title: string; message: string; createdAt: Date; readAt: Date | null; organizationId: string; organizationName: string; logoFileId: string | null; timezone: string; role: string | null; requestId: string | null; shiftId: string | null; shiftStartAt: Date | null; state: string | null; expiresAt: Date | null; inviter: string | null }

export function decodeNotificationCursor(cursor: string | undefined) {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (typeof parsed !== 'object' || !parsed || !('date' in parsed) || !('id' in parsed) || typeof parsed.date !== 'string' || typeof parsed.id !== 'string' || !/^(event|invite):[0-9a-f-]{36}$/.test(parsed.id) || !Number.isFinite(Date.parse(parsed.date))) throw new Error()
    return { date: new Date(parsed.date), id: parsed.id }
  } catch { throw new ApiError(400, 'INVALID_CURSOR', 'Некорректная страница уведомлений.') }
}

export async function listNotificationHistory(userId: string, email: string, options: { limit: number; cursor?: string; unread?: boolean; organizationId?: string; category?: string }) {
  if (options.organizationId) await getMembership(userId, options.organizationId)
  const cursor = decodeNotificationCursor(options.cursor)
  // Both sources are existing records; invitations can predate the recipient's registration.
  const historySource = Prisma.sql`
    WITH history AS (
      SELECT 'event:' || n.id AS id, 'event'::text AS source, n.type::text AS type, n.title, n.message,
        n.created_at AS "createdAt", n.read_at AS "readAt", o.id AS "organizationId", o.name AS "organizationName", o.logo_file_id AS "logoFileId", o.timezone,
        m.role::text AS role, n.request_id AS "requestId", n.shift_id AS "shiftId", n.absence_id AS "absenceId", s.scheduled_start_at AS "shiftStartAt", COALESCE(CASE WHEN n.document_id IS NOT NULL THEN CASE WHEN da.cancelled_at IS NOT NULL OR d.deleted_at IS NOT NULL THEN 'CANCELLED' WHEN da.acknowledged_at IS NOT NULL THEN 'ACKNOWLEDGED' ELSE 'REQUIRED' END END, r.status::text) AS state,
        n.document_id AS "documentId", (da.id IS NOT NULL AND da.acknowledged_at IS NULL AND da.cancelled_at IS NULL AND d.deleted_at IS NULL) AS actionable,
        NULL::timestamptz AS "expiresAt", NULL::text AS inviter
      FROM account_notifications n JOIN organizations o ON o.id = n.organization_id AND o.deleted_at IS NULL
      LEFT JOIN organization_members m ON m.organization_id = o.id AND m.user_id = ${userId}::uuid AND m.left_at IS NULL
      LEFT JOIN documents d ON d.id = n.document_id LEFT JOIN document_acknowledgements da ON da.document_id = d.id AND da.member_id = m.id
      LEFT JOIN requests r ON r.id = n.request_id LEFT JOIN work_shifts s ON s.id = n.shift_id
      WHERE n.user_id = ${userId}::uuid AND m.id IS NOT NULL AND n.hidden_at IS NULL
      AND (n.document_id IS NULL OR (d.organization_id = o.id AND (m.role IN ('OWNER', 'ADMIN') OR (d.deleted_at IS NULL AND (d.visibility = 'ORGANIZATION' OR (d.visibility = 'PRIVATE_MEMBER' AND d.target_member_id = m.id))))))
      ${options.unread ? Prisma.sql`AND n.read_at IS NULL` : Prisma.empty}
      UNION ALL
      SELECT 'invite:' || i.id, 'invite', 'ORGANIZATION_INVITATION', 'Приглашение в организацию', o.name,
        i.created_at, i.read_at, o.id, o.name, o.logo_file_id, o.timezone, m.role::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz,
        CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED' WHEN i.rejected_at IS NOT NULL THEN 'REJECTED' WHEN i.expires_at <= NOW() AND (i.revoked_at IS NULL OR i.revoked_at >= i.expires_at) THEN 'EXPIRED' WHEN i.revoked_at IS NOT NULL THEN 'REVOKED' ELSE 'ACTIVE' END,
        NULL::uuid, false, i.expires_at, COALESCE(NULLIF(trim(concat_ws(' ', u.last_name, u.first_name, u.middle_name)), ''), u.email)
      FROM organization_invites i JOIN organizations o ON o.id = i.organization_id AND o.deleted_at IS NULL JOIN users u ON u.id = i.invited_by_user_id
      LEFT JOIN organization_members m ON m.organization_id = o.id AND m.user_id = ${userId}::uuid AND m.left_at IS NULL
      WHERE i.notification_hidden_at IS NULL AND ((i.type = 'EMAIL' AND i.invited_email = ${email}) OR (i.type = 'CODE' AND i.accepted_by_user_id = ${userId}::uuid)) ${options.unread ? Prisma.sql`AND i.read_at IS NULL` : Prisma.empty}
    )`
  const rows = await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`${historySource} SELECT * FROM history
    WHERE (${options.organizationId ?? null}::uuid IS NULL OR "organizationId" = ${options.organizationId ?? null}::uuid)
    AND (${options.category ?? null}::text IS NULL OR type LIKE ${options.category ? options.category + '_%' : null})
    ${cursor ? Prisma.sql`AND ("createdAt", id) < (${cursor.date}, ${cursor.id})` : Prisma.empty}
    ORDER BY "createdAt" DESC, id DESC LIMIT ${options.limit + 1}
  `)
  const hasMore = rows.length > options.limit
  const page = rows.slice(0, options.limit)
  const notifications = page.map(row => {
    const organizationPath = `/app/organizations/${row.organizationId}`
    const month = row.shiftStartAt ? new Intl.DateTimeFormat('en-CA', { timeZone: row.timezone, year: 'numeric', month: '2-digit' }).formatToParts(row.shiftStartAt) : []
    const monthText = `${month.find(part => part.type === 'year')?.value}-${month.find(part => part.type === 'month')?.value}`
    return { actionable: row.actionable, documentId: row.documentId, id: row.id, source: row.source, type: row.type, title: row.title, message: row.message, createdAt: row.createdAt, readAt: row.readAt, state: row.state, expiresAt: row.expiresAt, inviter: row.inviter, organization: { id: row.organizationId, name: row.organizationName, logoUrl: mediaUrl(row.logoFileId) },
      href: row.role ? row.documentId ? `${organizationPath}/documents?document=${row.documentId}` : row.requestId && row.absenceId ? `${organizationPath}/requests?tab=${row.role === 'MEMBER' ? 'mine' : 'history'}&request=${row.requestId}` : row.absenceId ? `${organizationPath}/schedule?absences=1&absence=${row.absenceId}` : row.shiftId ? `${organizationPath}/schedule?view=mine&month=${monthText}&shift=${row.shiftId}` : row.requestId ? `${organizationPath}/requests?tab=${row.type === 'REQUEST_CREATED' && row.role !== 'MEMBER' ? 'incoming' : 'mine'}&request=${row.requestId}` : organizationPath : row.source === 'invite' && row.state === 'ACTIVE' ? `/app#invitation-${row.id.split(':')[1]}` : null }
  })
  const last = page.at(-1)
  const [counts] = await prisma.$queryRaw<Array<{ unread: bigint; actionable: bigint; pending: bigint }>>(Prisma.sql`${historySource} SELECT
    count(*) FILTER (WHERE "readAt" IS NULL) AS unread,
    count(*) FILTER (WHERE actionable) AS actionable,
    count(*) FILTER (WHERE "readAt" IS NULL) AS pending
    FROM history WHERE (${options.organizationId ?? null}::uuid IS NULL OR "organizationId" = ${options.organizationId ?? null}::uuid)`)

  return { notifications, unreadCount: Number(counts.unread), actionableCount: Number(counts.actionable), pendingCount: Number(counts.pending), nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ date: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null }
}

export async function readHistoryNotification(userId: string, email: string, id: string, unread: boolean, organizationId?: string) {
  if (organizationId) await getMembership(userId, organizationId)
  const [source, recordId] = id.split(':')
  const data = { readAt: unread ? null : new Date() }
  const result = source === 'event'
    ? await prisma.accountNotification.updateMany({ where: { id: recordId, userId, organizationId, hiddenAt: null, organization: { deletedAt: null, members: { some: { userId, leftAt: null } } } }, data })
    : await prisma.organizationInvite.updateMany({ where: { id: recordId, organizationId, notificationHiddenAt: null, organization: { deletedAt: null }, OR: [{ type: 'EMAIL', invitedEmail: email }, { type: 'CODE', acceptedByUserId: userId }] }, data })
  if (!result.count) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Уведомление не найдено.')
}

export async function updateAllNotifications(userId: string, email: string, options: { organizationId?: string }, removeId?: string) {
  if (options.organizationId) await getMembership(userId, options.organizationId)
  const [source, recordId] = removeId?.split(':') ?? []
  const organizationId = options.organizationId
  const now = new Date()
  if (removeId && source === 'event') {
    const active = await prisma.accountNotification.findFirst({ where: { id: recordId, userId, organizationId, document: { deletedAt: null, acknowledgements: { some: { member: { userId, leftAt: null }, acknowledgedAt: null, cancelledAt: null } } } } })
    if (active) throw new ApiError(409, 'ACTION_REQUIRED', 'Сначала ознакомьтесь с документом или дождитесь отмены требования.')
  }
  const results = await prisma.$transaction([
    prisma.accountNotification.updateMany({ where: { userId, organizationId, hiddenAt: null, ...(removeId ? { id: source === 'event' ? recordId : '00000000-0000-0000-0000-000000000000' } : { readAt: null }), organization: { deletedAt: null, members: { some: { userId, leftAt: null } } } }, data: removeId ? { hiddenAt: now } : { readAt: now } }),
    prisma.organizationInvite.updateMany({ where: { organizationId, notificationHiddenAt: null, ...(removeId ? { id: source === 'invite' ? recordId : '00000000-0000-0000-0000-000000000000' } : { readAt: null }), OR: [{ type: 'EMAIL', invitedEmail: email }, { type: 'CODE', acceptedByUserId: userId }], organization: { deletedAt: null } }, data: removeId ? { notificationHiddenAt: now } : { readAt: now } }),
  ])
  if (removeId && !results.some(result => result.count)) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Уведомление не найдено.')
}
