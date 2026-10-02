import { locationWhere, scopedLocationId } from '../organizations/location-context.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from '../organizations/permissions.ts'
import { countedMinutes } from './service.ts'
import { startOfZonedDate } from './timezone.ts'

export type StatisticsOptions = {
  from?: string
  to?: string
  memberState: 'active' | 'all' | 'former'
  sort: 'name' | 'workedMinutes' | 'workedShifts' | 'averageMinutes' | 'plannedMinutes' | 'plannedShifts'
  direction: 'asc' | 'desc'
  page: number
  limit: number
  historyOrder?: 'asc' | 'desc'
}

type Row = {
  memberId: string
  userId: string
  name: string
  avatarFileId: string | null
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  joinedAt: Date
  leftAt: Date | null
  workedMinutes: bigint
  workedShifts: bigint
  plannedMinutes: bigint
  plannedShifts: bigint
}

function numeric(value: bigint) { return Number(value) }

async function aggregate(organizationId: string, timezone: string, options: Pick<StatisticsOptions, 'from' | 'to' | 'memberState'>, memberId?: string) {
  const from = options.from ? startOfZonedDate(options.from, timezone) : null
  const to = options.to ? startOfZonedDate(options.to, timezone) : null
  return prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT
      m.id AS "memberId",
      m.user_id AS "userId",
      COALESCE(NULLIF(concat_ws(' ', u.last_name, u.first_name, u.middle_name), ''), split_part(u.email, '@', 1)) AS name,
      u.avatar_file_id AS "avatarFileId",
      CASE WHEN m.role = 'OWNER' OR ${scopedLocationId(organizationId) ?? null}::uuid IS NULL THEN m.role::text ELSE COALESCE(lm.role::text, 'MEMBER') END AS role,
      COALESCE(lm.joined_at, m.joined_at) AS "joinedAt",
      CASE WHEN ${scopedLocationId(organizationId) ?? null}::uuid IS NULL THEN m.left_at WHEN m.left_at IS NOT NULL THEN m.left_at WHEN lm.member_id IS NOT NULL THEN lm.left_at WHEN EXISTS (SELECT 1 FROM location_transfers t WHERE t.member_id = m.id AND t.to_location_id = ${scopedLocationId(organizationId) ?? null}::uuid AND t.temporary AND t.end_at > NOW()) THEN NULL ELSE m.joined_at END AS "leftAt",
      COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND s.status = 'SCHEDULED' AND COALESCE(s.actual_end_at, s.scheduled_end_at) <= NOW()
        THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(s.actual_end_at, s.scheduled_end_at) - COALESCE(s.actual_start_at, s.scheduled_start_at))) / 60)::bigint) ELSE 0 END), 0)::bigint AS "workedMinutes",
      COUNT(s.id) FILTER (WHERE s.status = 'SCHEDULED' AND COALESCE(s.actual_end_at, s.scheduled_end_at) <= NOW()
        AND COALESCE(s.actual_end_at, s.scheduled_end_at) > COALESCE(s.actual_start_at, s.scheduled_start_at))::bigint AS "workedShifts",
      COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND s.status = 'SCHEDULED' AND COALESCE(s.actual_end_at, s.scheduled_end_at) > NOW()
        THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(s.actual_end_at, s.scheduled_end_at) - COALESCE(s.actual_start_at, s.scheduled_start_at))) / 60)::bigint) ELSE 0 END), 0)::bigint AS "plannedMinutes",
      COUNT(s.id) FILTER (WHERE s.status = 'SCHEDULED' AND COALESCE(s.actual_end_at, s.scheduled_end_at) > NOW())::bigint AS "plannedShifts"
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN location_members lm ON lm.member_id = m.id AND lm.location_id = ${scopedLocationId(organizationId) ?? null}::uuid
    LEFT JOIN work_shifts s ON s.member_id = m.id
      AND (${scopedLocationId(organizationId) ?? null}::uuid IS NULL OR s.location_id = ${scopedLocationId(organizationId) ?? null}::uuid)
      AND (${from}::timestamptz IS NULL OR s.scheduled_start_at >= ${from})
      AND (${to}::timestamptz IS NULL OR s.scheduled_start_at < ${to})
    WHERE m.organization_id = ${organizationId}::uuid
      AND u.deleted_at IS NULL
      AND (${scopedLocationId(organizationId) ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM location_members lm WHERE lm.member_id = m.id AND lm.location_id = ${scopedLocationId(organizationId) ?? null}::uuid) OR EXISTS (SELECT 1 FROM work_shifts hs WHERE hs.member_id = m.id AND hs.location_id = ${scopedLocationId(organizationId) ?? null}::uuid) OR m.id = ${memberId ?? null}::uuid)
      AND (${memberId ?? null}::uuid IS NULL OR m.id = ${memberId ?? null}::uuid)
      GROUP BY m.id, u.id, lm.member_id, lm.location_id
    HAVING (${options.memberState} = 'all' OR (${options.memberState} = 'active' AND CASE WHEN ${scopedLocationId(organizationId) ?? null}::uuid IS NULL THEN m.left_at IS NULL ELSE m.left_at IS NULL AND (lm.left_at IS NULL AND lm.member_id IS NOT NULL OR EXISTS (SELECT 1 FROM location_transfers t WHERE t.member_id = m.id AND t.to_location_id = ${scopedLocationId(organizationId) ?? null}::uuid AND t.temporary AND t.end_at > NOW())) END) OR (${options.memberState} = 'former' AND CASE WHEN ${scopedLocationId(organizationId) ?? null}::uuid IS NULL THEN m.left_at IS NOT NULL ELSE m.left_at IS NOT NULL OR (lm.left_at IS NOT NULL OR lm.member_id IS NULL) AND NOT EXISTS (SELECT 1 FROM location_transfers t WHERE t.member_id = m.id AND t.to_location_id = ${scopedLocationId(organizationId) ?? null}::uuid AND t.temporary AND t.end_at > NOW()) END))
  `)
}

function present(row: Row) {
  const workedMinutes = numeric(row.workedMinutes)
  const workedShifts = numeric(row.workedShifts)
  return {
    memberId: row.memberId,
    userId: row.userId,
    name: row.name,
    avatarUrl: mediaUrl(row.avatarFileId),
    role: row.role,
    active: !row.leftAt,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
    workedMinutes,
    workedShifts,
    averageMinutes: workedShifts ? Math.floor(workedMinutes / workedShifts) : 0,
    plannedMinutes: numeric(row.plannedMinutes),
    plannedShifts: numeric(row.plannedShifts),
  }
}

export async function organizationStatistics(userId: string, organizationId: string, options: StatisticsOptions) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const rows = (await aggregate(organizationId, actor.organization.timezone, options)).map(present)
  rows.sort((left, right) => {
    const a = left[options.sort]
    const b = right[options.sort]
    const comparison = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'ru') : Number(a) - Number(b)
    return options.direction === 'asc' ? comparison : -comparison
  })
  const offset = (options.page - 1) * options.limit
  return {
    summary: {
      workedMinutes: rows.reduce((sum, row) => sum + row.workedMinutes, 0),
      workedShifts: rows.reduce((sum, row) => sum + row.workedShifts, 0),
      plannedMinutes: rows.reduce((sum, row) => sum + row.plannedMinutes, 0),
      plannedShifts: rows.reduce((sum, row) => sum + row.plannedShifts, 0),
      employees: rows.length,
    },
    members: rows.slice(offset, offset + options.limit),
    pagination: { page: options.page, limit: options.limit, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / options.limit)) },
  }
}

async function memberRows(userId: string, organizationId: string, memberId: string, options: StatisticsOptions) {
  const actor = await getMembership(userId, organizationId)
  const target = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId }, include: { user: true } })
  if (!target || target.user.deletedAt) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
  if (actor.role === 'MEMBER' && actor.id !== target.id) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Можно просматривать только своё рабочее время.')
  const period = (await aggregate(organizationId, actor.organization.timezone, { ...options, memberState: 'all' }, memberId))[0]
  const allTime = (await aggregate(organizationId, actor.organization.timezone, { memberState: 'all' }, memberId))[0]
  const from = options.from ? startOfZonedDate(options.from, actor.organization.timezone) : undefined
  const to = options.to ? startOfZonedDate(options.to, actor.organization.timezone) : undefined
  const history = await prisma.workShift.findMany({
    where: { organizationId, ...locationWhere(organizationId), memberId, ...(from && to ? { scheduledStartAt: { gte: from, lt: to } } : {}) },
    include: { _count: { select: { adjustments: true } } },
    orderBy: { scheduledStartAt: options.historyOrder ?? 'desc' },
    skip: (options.page - 1) * options.limit,
    take: options.limit,
  })
  const total = await prisma.workShift.count({ where: { organizationId, ...locationWhere(organizationId), memberId, ...(from && to ? { scheduledStartAt: { gte: from, lt: to } } : {}) } })
  const mapShift = (shift: typeof history[number]) => {
    const start = shift.actualStartAt ?? shift.scheduledStartAt
    const end = shift.actualEndAt ?? shift.scheduledEndAt
    return { id: shift.id, scheduledStartAt: shift.scheduledStartAt, scheduledEndAt: shift.scheduledEndAt, actualStartAt: shift.actualStartAt, actualEndAt: shift.actualEndAt, status: shift.status, minutes: countedMinutes(start, end), plannedMinutes: countedMinutes(shift.scheduledStartAt, shift.scheduledEndAt), actualMinutes: shift.actualStartAt && shift.actualEndAt ? countedMinutes(shift.actualStartAt, shift.actualEndAt) : null, breakMinutes: shift.breakMinutes, actualBreakMinutes: shift.actualBreakMinutes, cancellationReason: shift.cancellationReason, adjusted: shift._count.adjustments > 0, description: shift.description }
  }
  return {
    member: { avatarUrl: mediaUrl(target.user.avatarFileId), id: target.id, name: [target.user.lastName, target.user.firstName, target.user.middleName].filter(Boolean).join(' ') || target.user.email.split('@')[0], role: allTime?.role ?? target.role, active: allTime ? !allTime.leftAt : !target.leftAt },
    period: period ? present(period) : null,
    allTime: allTime ? present(allTime) : null,
    history: history.map(mapShift),
    pagination: { page: options.page, limit: options.limit, total, pages: Math.max(1, Math.ceil(total / options.limit)) },
    timezone: actor.organization.timezone,
  }
}

export function memberStatistics(userId: string, organizationId: string, memberId: string, options: StatisticsOptions) {
  return memberRows(userId, organizationId, memberId, options)
}

export async function myStatistics(userId: string, organizationId: string, options: StatisticsOptions) {
  const actor = await getMembership(userId, organizationId)
  return memberRows(userId, organizationId, actor.id, options)
}
