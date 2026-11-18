import { hasPermission, requirePermission } from '../../organizations/access/access.ts'
import { scopedLocationId } from '../../organizations/location-context.ts'
import { mediaUrl } from '../../storage/image-service.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { getMembership } from '../../organizations/access/permissions.ts'
import { calculateWorkTime } from '../../../shared/work-time.ts'
import { statisticsShiftWhere } from './range.ts'

export type StatisticsOptions = {
  search?: string
  from?: string
  to?: string
  memberState: 'active' | 'all' | 'former'
  sort: 'name' | 'workedMinutes' | 'workedShifts' | 'averageMinutes' | 'plannedMinutes' | 'plannedShifts' | 'estimatedMinutes' | 'pendingShifts'
  direction: 'asc' | 'desc'
  page: number
  limit: number
  historyOrder?: 'asc' | 'desc'
}

type IdentityRow = {
  memberId: string;
  userId: string;
  name: string;
  avatarFileId: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: Date;
  leftAt: Date | null;
};
type Row = IdentityRow & {
  workedMinutes: number;
  workedShifts: number;
  plannedMinutes: number;
  plannedShifts: number;
  estimatedMinutes: number;
  confirmedShifts: number;
  pendingShifts: number;
  futureMinutes: number;
  firstPendingShiftId: string | null;
};

async function aggregate(organizationId: string, _timezone: string, options: Pick<StatisticsOptions, 'from' | 'to' | 'memberState' | 'search'>, memberId?: string) {
  const asOf = new Date();
  const search = options.search?.trim().replace(/[\\%_]/g, '\\$&');
  return prisma.$transaction(async db => {
    const identities = await db.$queryRaw<IdentityRow[]>(Prisma.sql`
    SELECT
      m.id AS "memberId",
      m.user_id AS "userId",
      COALESCE(NULLIF(concat_ws(' ', u.last_name, u.first_name, u.middle_name), ''), split_part(u.email, '@', 1)) AS name,
      u.avatar_file_id AS "avatarFileId",
      CASE WHEN m.role = 'OWNER' OR ${scopedLocationId(organizationId) ?? null}::uuid IS NULL THEN m.role::text ELSE COALESCE(lm.role::text, 'MEMBER') END AS role,
      COALESCE(lm.joined_at, m.joined_at) AS "joinedAt",
      CASE WHEN ${scopedLocationId(organizationId) ?? null}::uuid IS NULL THEN m.left_at WHEN m.left_at IS NOT NULL THEN m.left_at WHEN lm.member_id IS NOT NULL THEN lm.left_at WHEN EXISTS (SELECT 1 FROM location_transfers t WHERE t.member_id = m.id AND t.to_location_id = ${scopedLocationId(organizationId) ?? null}::uuid AND t.temporary AND t.end_at > NOW()) THEN NULL ELSE m.joined_at END AS "leftAt"
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN location_members lm ON lm.member_id = m.id AND lm.location_id = ${scopedLocationId(organizationId) ?? null}::uuid
    WHERE m.organization_id = ${organizationId}::uuid
      AND u.deleted_at IS NULL
      AND (${search ?? null}::text IS NULL OR concat_ws(' ', u.last_name, u.first_name, u.middle_name, u.email) ILIKE ${`%${search ?? ''}%`})
      AND (${scopedLocationId(organizationId) ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM location_members lm WHERE lm.member_id = m.id AND lm.location_id = ${scopedLocationId(organizationId) ?? null}::uuid) OR EXISTS (SELECT 1 FROM work_shifts hs WHERE hs.member_id = m.id AND hs.location_id = ${scopedLocationId(organizationId) ?? null}::uuid) OR m.id = ${memberId ?? null}::uuid)
      AND (${memberId ?? null}::uuid IS NULL OR m.id = ${memberId ?? null}::uuid)
      AND (${options.memberState} = 'all' OR (${options.memberState} = 'active' AND CASE WHEN ${scopedLocationId(organizationId) ?? null}::uuid IS NULL THEN m.left_at IS NULL ELSE m.left_at IS NULL AND (lm.left_at IS NULL AND lm.member_id IS NOT NULL OR EXISTS (SELECT 1 FROM location_transfers t WHERE t.member_id = m.id AND t.to_location_id = ${scopedLocationId(organizationId) ?? null}::uuid AND t.temporary AND t.end_at > NOW())) END) OR (${options.memberState} = 'former' AND CASE WHEN ${scopedLocationId(organizationId) ?? null}::uuid IS NULL THEN m.left_at IS NOT NULL ELSE m.left_at IS NOT NULL OR (lm.left_at IS NOT NULL OR lm.member_id IS NULL) AND NOT EXISTS (SELECT 1 FROM location_transfers t WHERE t.member_id = m.id AND t.to_location_id = ${scopedLocationId(organizationId) ?? null}::uuid AND t.temporary AND t.end_at > NOW()) END))
    `);
    const rows = new Map<string, Row>(identities.map(identity => [identity.memberId, {
      ...identity, workedMinutes: 0, workedShifts: 0, plannedMinutes: 0, plannedShifts: 0,
      estimatedMinutes: 0, confirmedShifts: 0, pendingShifts: 0, futureMinutes: 0, firstPendingShiftId: null,
    }]));
    if (!rows.size) return [];
    const where = await statisticsShiftWhere(db, organizationId, options.from, options.to);
    let cursor: string | undefined;
    // Bound memory for all-time statistics while keeping one consistent snapshot.
    for (;;) {
      const shifts = await db.workShift.findMany({
        where: { ...where, memberId: { in: [...rows.keys()] }, status: 'SCHEDULED', cancelledAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, memberId: true, status: true, attendance: true, scheduledStartAt: true, scheduledEndAt: true, actualStartAt: true, actualEndAt: true },
        orderBy: { id: 'asc' }, take: 5000,
      });
      for (const shift of shifts) {
        const row = rows.get(shift.memberId)!;
        const time = calculateWorkTime(shift, asOf);
        row.plannedMinutes += time.plannedMinutes;
        row.estimatedMinutes += time.estimatedMinutes;
        if (time.confirmedMinutes !== null) {
          row.workedMinutes += time.confirmedMinutes;
          row.confirmedShifts++;
          if (time.state !== 'NO_SHOW') row.workedShifts++;
        }
        if (time.pending) {
          row.pendingShifts++;
          row.firstPendingShiftId ??= shift.id;
        }
        if (time.state === 'FUTURE' || !time.completed) {
          row.plannedShifts++;
          row.futureMinutes += time.plannedMinutes;
        }
      }
      if (shifts.length < 5000) break;
      cursor = shifts.at(-1)!.id;
    }
    return [...rows.values()];
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
}

function present(row: Row) {
  const { avatarFileId, leftAt, ...values } = row;
  return {
    ...values,
    avatarUrl: mediaUrl(avatarFileId),
    active: !leftAt,
    leftAt,
    averageMinutes: row.workedShifts ? Math.floor(row.workedMinutes / row.workedShifts) : 0,
  };
}

export async function organizationStatistics(userId: string, organizationId: string, options: StatisticsOptions) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'statistics.view')
  const rows = (await aggregate(organizationId, actor.organization.timezone, options)).map(present)
  rows.sort((left, right) => {
    const a = left[options.sort]
    const b = right[options.sort]
    const comparison = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'ru') : Number(a) - Number(b)
    if (comparison === 0) return left.memberId.localeCompare(right.memberId)
    return options.direction === 'asc' ? comparison : -comparison
  })
  const offset = (options.page - 1) * options.limit
  return {
    summary: {
      estimatedMinutes: rows.reduce((sum, row) => sum + row.estimatedMinutes, 0),
      confirmedShifts: rows.reduce((sum, row) => sum + row.confirmedShifts, 0),
      pendingShifts: rows.reduce((sum, row) => sum + row.pendingShifts, 0),
      futureMinutes: rows.reduce((sum, row) => sum + row.futureMinutes, 0),
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
  if (!hasPermission(actor, 'statistics.view') && actor.id !== target.id) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Можно просматривать только своё рабочее время.')
  requirePermission(actor, actor.id === target.id ? 'statistics.own' : 'statistics.view')
  const period = (await aggregate(organizationId, actor.organization.timezone, { ...options, memberState: 'all' }, memberId))[0]
  const allTime = (await aggregate(organizationId, actor.organization.timezone, { memberState: 'all' }, memberId))[0]
  const where = { ...await statisticsShiftWhere(prisma, organizationId, options.from, options.to), memberId }
  const history = await prisma.workShift.findMany({
    where: where,
    include: { location: { select: { timezone: true } }, _count: { select: { adjustments: true } } },
    orderBy: { scheduledStartAt: options.historyOrder ?? 'desc' },
    skip: (options.page - 1) * options.limit,
    take: options.limit,
  })
  const total = await prisma.workShift.count({ where: where })
  const mapShift = (shift: typeof history[number]) => {
    const accounting = calculateWorkTime(shift)
    return { id: shift.id, accounting, timezone: shift.location.timezone, locationId: shift.locationId, scheduledStartAt: shift.scheduledStartAt, scheduledEndAt: shift.scheduledEndAt, actualStartAt: shift.actualStartAt, actualEndAt: shift.actualEndAt, status: shift.status, attendance:shift.attendance, minutes: accounting.estimatedMinutes, plannedMinutes: accounting.plannedMinutes, actualMinutes: accounting.confirmedMinutes, breakMinutes: shift.breakMinutes, actualBreakMinutes: shift.actualBreakMinutes, cancellationReason: shift.cancellationReason, adjusted: shift._count.adjustments > 0, description: shift.description }
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
