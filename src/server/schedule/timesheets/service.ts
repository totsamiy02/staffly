import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../db.ts';
import type { Prisma } from '../../../generated/prisma/client.ts';
import { ApiError } from '../../api-error.ts';
import { getMembership } from '../../organizations/access/permissions.ts';
import { hasPermission, requirePermission } from '../../organizations/access/access.ts';
import { scopedLocationId } from '../../organizations/location-context.ts';
import { requirePlanFeature, requireSubscriptionWritable, subscriptionSnapshot } from '../../subscriptions/access.ts';
import { buildTimesheet, monthBounds } from './snapshot.ts';
import { assertPartialShiftBounds } from '../partial-shift-bounds.ts';
import type { TimesheetSnapshot } from '../../../app/schedule/timesheets/types.ts';
import { stableJson } from '../../../shared/stable-json.ts';
export const monthSchema = z.string().regex(/^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/);
export const actionBody = z.object({
  action: z.enum(['CLOSE', 'REOPEN', 'CONFIRM']),
  revision: z.number().int().nonnegative(),
  snapshotToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reason: z.string().trim().min(3).max(1000).optional(),
}).refine(input => input.action !== 'CLOSE' || !!input.snapshotToken, {
  message: 'Обновите данные перед фиксацией табеля.',
  path: ['snapshotToken'],
});
export type ActionInput = z.infer<typeof actionBody>;
type DB = Prisma.TransactionClient;
function snapshotToken(snapshot: TimesheetSnapshot) {
  const { generatedAt: _generatedAt, approval: _approval, closure: _closure, ...content } = snapshot;
  return createHash('sha256').update(stableJson({
    ...content,
    // Reading an assignment changes updatedAt, but does not change the tabulated facts.
    shifts: content.shifts.map(({ updatedAt: _updatedAt, ...shift }) => shift),
  })).digest('hex');
}
async function access(db: DB, userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId, db);
  const locationId = scopedLocationId(organizationId) ?? actor.locationId;
  if (!locationId)
    throw new ApiError(400, 'LOCATION_REQUIRED', 'Выберите точку для табеля.');
  requirePermission(actor, 'timesheets.view', locationId);
  requirePermission(actor, 'absences.details', locationId);
  requirePermission(actor, 'members.personnel.view', locationId);
  const location = await db.organizationLocation.findFirst({ where: { id: locationId, organizationId } });
  if (!location)
    throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.');
  return { actor, location };
}
export async function readTimesheet(userId: string, organizationId: string, month: string, eventPage = 1) {
  monthSchema.parse(month);
  eventPage = z.number().int().min(1).max(1000000).parse(eventPage);
  return prisma.$transaction(async (db) => {
    const { actor, location } = await access(db, userId, organizationId);
    await requirePlanFeature(organizationId, 'timesheets', db);
    const period = await db.timesheetPeriod.findUnique({ where: { organizationId_locationId_month: { organizationId, locationId: location.id, month } } });
    const subscription = await subscriptionSnapshot(organizationId, db);
    const current = await buildTimesheet(db, organizationId, location.id, month, period?.timezone ?? location.timezone);
    const versions = period ? await db.timesheetVersion.findMany({
      where: { periodId: period.id },
      orderBy: { version: 'desc' },
      select: { version: true, closedAt: true, closedByMemberId: true }
    }) : [];
    const latest = period?.version ? await db.timesheetVersion.findUnique({ where: { periodId_version: { periodId: period.id, version: period.version } } }) : null;
    const saved = latest?.snapshot as unknown as TimesheetSnapshot | undefined;
    const active = subscription.features.includes('timesheets') && !subscription.readOnly;
    const content = (snapshot: TimesheetSnapshot) => ({
      shifts: snapshot.shifts.map(({ updatedAt: _updatedAt, name: _name, number: _number, accounting: _accounting, ...accounting }) => accounting),
      absences: snapshot.absences.map(({ name: _name, number: _number, ...accounting }) => accounting),
    });
    const eventCount = period ? await db.timesheetEvent.count({ where: { periodId: period.id } }) : 0;
    return {
      historyPagination: { page: eventPage, pages: Math.max(1, Math.ceil(eventCount / 50)), total: eventCount },
      period,
      snapshot: period?.status === 'CLOSED' && saved ? saved : current,
      snapshotToken: snapshotToken(current),
      versions,
      events: period ? await db.timesheetEvent.findMany({ where: { periodId: period.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (eventPage - 1) * 50, take: 50 }) : [],
      changedSinceClose: !!saved && !isDeepStrictEqual(content(saved), content(current)),
      capabilities: {
        close: active && hasPermission(actor, 'reports.export', location.id),
        reopen: active && hasPermission(actor, 'reports.export', location.id),
        export: hasPermission(actor, 'reports.export', location.id),
        actual: active && hasPermission(actor, 'schedule.actual', location.id),
      },
    };
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
}
export async function actOnTimesheet(userId: string, organizationId: string, month: string, input: ActionInput) {
  monthSchema.parse(month);
  input = actionBody.parse(input);
  return prisma.$transaction(async (db) => {
    // Same lock order as shift services. The DB epoch also protects indirect and
    // standalone writes against closure and stale SERIALIZABLE transactions.
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`;
    await db.$executeRaw`SELECT public.staffly_lock_timesheets(${organizationId}::uuid)`;
    const { actor, location } = await access(db, userId, organizationId);
    requirePermission(actor, 'reports.export', location.id);
    await requireSubscriptionWritable(db, organizationId);
    await requirePlanFeature(organizationId, 'timesheets', db);
    let period = await db.timesheetPeriod.findUnique({ where: { organizationId_locationId_month: { organizationId, locationId: location.id, month } } });
    if (!period) {
      if (input.revision !== 0 || input.action === 'REOPEN')
        throw new ApiError(409, 'TIMESHEET_CHANGED', 'Обновите табель перед действием.');
      period = await db.timesheetPeriod.create({ data: { organizationId, locationId: location.id, month, timezone: location.timezone } });
    }
    if (period.revision !== input.revision)
      throw new ApiError(409, 'TIMESHEET_CHANGED', 'Табель уже изменился. Обновите данные.');
    const reason = input.reason ?? (input.action === 'CLOSE' ? 'Версия табеля зафиксирована' : 'Подтверждено по плану');
    if (input.action === 'REOPEN' && !input.reason)
      throw new ApiError(400, 'REASON_REQUIRED', 'Укажите причину.');
    let status = period.status;
    let version = period.version;
    if (input.action === 'CONFIRM') {
      if (status !== 'OPEN')
        throw new ApiError(409, 'TIMESHEET_LOCKED', 'Табель заблокирован. Верните его в работу.');
      requirePermission(actor, 'schedule.actual', location.id);
      if (version > 0 && !input.reason)
        throw new ApiError(400, 'REASON_REQUIRED', 'Укажите причину исправления ранее закрытого табеля.');
      await db.$queryRaw`SELECT set_config('staffly.actor_user_id',${userId},true),set_config('staffly.correction_reason',${reason},true)`;
      const { start, end } = monthBounds(month, period.timezone);
      const shifts = await db.workShift.findMany({
        where: {
          organizationId,
          locationId: location.id,
          status: 'SCHEDULED',
          cancelledAt: null,
          attendance: 'UNCONFIRMED',
          scheduledStartAt: { gte: start, lt: end },
          scheduledEndAt: { lte: new Date() }
        }
      });
      for (const shift of shifts) {
        // Existing partial facts are never overwritten by mass confirmation.
        if (shift.actualStartAt || shift.actualEndAt)
          continue;
        assertPartialShiftBounds(shift, shift.scheduledStartAt, shift.scheduledEndAt, 'WORKED');
        await db.workShiftAdjustment.create({
          data: {
            shiftId: shift.id,
            changedByMemberId: actor.id,
            previousStartAt: shift.scheduledStartAt,
            previousEndAt: shift.scheduledEndAt,
            previousBreakMinutes: shift.breakMinutes,
            newStartAt: shift.scheduledStartAt,
            newEndAt: shift.scheduledEndAt,
            newBreakMinutes: shift.breakMinutes,
            reason,
            kind: 'TIMESHEET_CONFIRM'
          }
        });
        await db.workShift.update({
          where: { id: shift.id },
          data: {
            attendance: 'WORKED',
            actualStartAt: shift.scheduledStartAt,
            actualEndAt: shift.scheduledEndAt,
            actualBreakMinutes: shift.breakMinutes,
            attendanceReason: reason
          }
        });
      }
    }
    else if (input.action === 'CLOSE') {
      if (status !== 'OPEN')
        throw new ApiError(409, 'TIMESHEET_CHANGED', 'Версия уже зафиксирована. Обновите табель.');
      const snapshot = await buildTimesheet(db, organizationId, location.id, month, period.timezone);
      if (snapshotToken(snapshot) !== input.snapshotToken)
        throw new ApiError(409, 'TIMESHEET_DATA_CHANGED', 'Данные изменились после сверки. Проверьте обновлённый табель и зафиксируйте версию ещё раз.');
      if (snapshot.issues.length)
        throw new ApiError(409, 'TIMESHEET_NOT_READY', 'Устраните замечания перед фиксацией табеля.', { issues: snapshot.issues });
      const author = await db.user.findUniqueOrThrow({ where: { id: userId } });
      snapshot.closure = {
        memberId: actor.id,
        name: [actor.personnelLastName, actor.personnelFirstName, actor.personnelMiddleName].filter(Boolean).join(' ')
          || [author.lastName, author.firstName, author.middleName].filter(Boolean).join(' ') || 'Сотрудник'
      };
      version++;
      await db.timesheetVersion.create({
        data: {
          periodId: period.id,
          version,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          closedByMemberId: actor.id
        }
      });
      status = 'CLOSED';
    }
    else {
      if (status !== 'CLOSED')
        throw new ApiError(409, 'TIMESHEET_CHANGED', 'Табель уже открыт для сверки.');
      status = 'OPEN';
    }
    const author = await db.user.findUniqueOrThrow({ where: { id: userId } });
    await db.timesheetEvent.create({
      data: {
        periodId: period.id,
        actorMemberId: actor.id,
        actorName: [actor.personnelLastName, actor.personnelFirstName, actor.personnelMiddleName].filter(Boolean).join(' ') || [author.lastName, author.firstName, author.middleName].filter(Boolean).join(' ') || 'Сотрудник',
        kind: input.action,
        reason
      }
    });
    const updated = await db.timesheetPeriod.update({
      where: { id: period.id },
      data: { status, version, revision: { increment: 1 } }
    });
    return updated;
  }, { timeout: 30000 });
}
export async function readTimesheetVersion(userId: string, organizationId: string, month: string, version: number) {
  return prisma.$transaction(async (db) => {
    const { actor, location } = await access(db, userId, organizationId);
    requirePermission(actor, 'reports.export', location.id);
    const period = await db.timesheetPeriod.findUnique({ where: { organizationId_locationId_month: { organizationId, locationId: location.id, month } } });
    const record = period ? await db.timesheetVersion.findUnique({ where: { periodId_version: { periodId: period.id, version } } }) : null;
    if (!record)
      throw new ApiError(404, 'TIMESHEET_VERSION_NOT_FOUND', 'Закрытая версия табеля не найдена.');
    return {
      snapshot: record.snapshot as unknown as TimesheetSnapshot,
      closedAt: record.closedAt,
      version,
      currentVersion: period!.version,
      status: period!.status
    };
  });
}
