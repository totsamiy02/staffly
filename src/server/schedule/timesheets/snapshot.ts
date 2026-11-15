import { calculateWorkTime, intervalMinutes, workTimeRules } from '../../../shared/work-time.ts';
import { vacationDays as countVacationDays } from '../../../shared/request-workflow.ts';
import type { Prisma } from '../../../generated/prisma/client.ts';
import type { TimesheetSnapshot, TimesheetMember } from '../../../app/schedule/timesheets/types.ts';
import { addCalendarDays, startOfZonedDate } from '../timezone.ts';
import { dateTimeParts } from '../../../shared/date-time.ts';
import { ApiError } from '../../api-error.ts';
export function monthBounds(month: string, timezone: string) {
  const first = `${month}-01`;
  const next = new Date(`${first}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const until = next.toISOString().slice(0, 10);
  return {
    first,
    last: addCalendarDays(until, -1),
    start: startOfZonedDate(first, timezone),
    end: startOfZonedDate(until, timezone)
  };
}
export function localDate(date: Date, timezone: string) {
  const parts = dateTimeParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
export function minutes(start: Date, end: Date) { return intervalMinutes(start, end); }
const date = (value: Date) => value.toISOString().slice(0, 10);
export async function buildTimesheet(db: Prisma.TransactionClient, organizationId: string, locationId: string, month: string, timezone: string): Promise<TimesheetSnapshot> {
  const { start, end, first, last } = monthBounds(month, timezone);
  const location = await db.organizationLocation.findFirstOrThrow({ where: { id: locationId, organizationId } });
  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const candidates = await db.organizationMember.findMany({
    where: {
      organizationId,
      OR: [
        { workShifts: { some: { locationId, scheduledStartAt: { gte: start, lt: end } } } },
        { locationMemberships: { some: { locationId, joinedAt: { lt: end }, OR: [{ leftAt: null }, { leftAt: { gte: start } }] } } },
        {
          locationTransfers: {
            some: {
              toLocationId: locationId,
              startAt: { lt: end },
              OR: [{ endAt: null }, { endAt: { gte: start } }]
            }
          }
        },
      ]
    },
    include: { user: true, locationMemberships: true, locationTransfers: true },
    take: 1001,
  });
  if (candidates.length > 1000)
    throw new ApiError(400, 'TIMESHEET_LIMIT', 'В табеле допускается до 1000 сотрудников.');
  const shifts = await db.workShift.findMany({
    where: {
      organizationId,
      locationId,
      scheduledStartAt: { gte: start, lt: end },
      status: 'SCHEDULED',
      cancelledAt: null
    },
    orderBy: [{ scheduledStartAt: 'asc' }, { id: 'asc' }],
    take: 20001
  });
  const members = candidates.filter(member => shifts.some(shift => shift.memberId === member.id)
    || member.locationMemberships.some(item => item.locationId === locationId && item.joinedAt < end && (!item.leftAt || item.leftAt > start))
    || member.locationTransfers.some(item => item.toLocationId === locationId && item.startAt < end && (!item.endAt || item.endAt > start) && (!item.revokedAt || item.revokedAt > start && item.revokedAt > item.startAt)));
  const memberIds = members.map(member => member.id);
  const absences = await db.employeeAbsence.findMany({
    where: {
      organizationId,
      memberId: { in: memberIds },
      cancelledAt: null,
      startDate: { lte: new Date(last) },
      endDate: { gte: new Date(first) }
    },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    take: 20001
  });
  if (shifts.length > 20000 || absences.length > 20000)
    throw new ApiError(400, 'TIMESHEET_LIMIT', 'В табеле допускается до 20000 смен и отсутствий.');
  const snapshot: TimesheetSnapshot = {
    organization: organization.name,
    location: location.name,
    timezone,
    month,
    generatedAt: new Date().toISOString(),
    calculationRules: workTimeRules,
    members: [],
    shifts: [],
    absences: [],
    issues: []
  };
  const now = new Date();
  if (end > now)
    snapshot.issues.push({ code: 'PERIOD_NOT_ENDED', message: 'Период ещё не закончился.' });
  const identities = new Map<string, TimesheetMember>();
  for (const member of members) {
    const name = [member.personnelLastName, member.personnelFirstName, member.personnelMiddleName].filter(Boolean).join(' ')
      || [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || 'Без имени';
    identities.set(member.id, {
      id: member.id,
      name,
      number: member.personnelNumber,
      former: !!member.leftAt,
      positions: '',
      plannedMinutes: 0,
      actualMinutes: 0,
      confirmedShifts: 0,
      unconfirmedShifts: 0,
      workedShifts: 0,
      noShows: 0,
      vacationDays: 0,
      sickDays: 0,
      otherAbsenceDays: 0
    });
  }
  for (const shift of shifts) {
    const member = identities.get(shift.memberId)!;
    const accounting = calculateWorkTime(shift, now);
    const plannedMinutes = accounting.plannedMinutes;
    const actualMinutes = accounting.confirmedMinutes ?? 0;
    if (shift.scheduledEndAt > now || shift.actualEndAt && shift.actualEndAt > now)
      snapshot.issues.push({ code: 'SHIFT_NOT_ENDED', message: `${member.name}: смена ещё не завершена.`, shiftId: shift.id });
    if (accounting.confirmedMinutes === null)
      snapshot.issues.push({
        code: 'UNCONFIRMED',
        message: `${member.name}: подтвердите факт за ${localDate(shift.scheduledStartAt, timezone)}.`,
        shiftId: shift.id
      });
    snapshot.shifts.push({
      id: shift.id,
      memberId: member.id,
      name: member.name,
      number: member.number,
      position: shift.positionNameSnapshot,
      date: localDate(shift.scheduledStartAt, timezone),
      scheduledStart: shift.scheduledStartAt.toISOString(),
      scheduledEnd: shift.scheduledEndAt.toISOString(),
      actualStart: shift.actualStartAt?.toISOString() ?? null,
      actualEnd: shift.actualEndAt?.toISOString() ?? null,
      plannedMinutes,
      actualMinutes,
      accounting,
      breakMinutes: shift.breakMinutes,
      actualBreakMinutes: shift.actualBreakMinutes,
      attendance: shift.attendance,
      reason: shift.attendanceReason,
      updatedAt: shift.updatedAt.toISOString()
    });
    member.plannedMinutes += plannedMinutes;
    member.actualMinutes += actualMinutes;
    member.confirmedShifts = (member.confirmedShifts ?? 0) + (accounting.confirmedMinutes !== null ? 1 : 0);
    member.unconfirmedShifts = (member.unconfirmedShifts ?? 0) + (accounting.confirmedMinutes === null ? 1 : 0);
    member.workedShifts += accounting.state === 'CONFIRMED' ? 1 : 0;
    member.noShows += shift.attendance === 'NO_SHOW' ? 1 : 0;
    member.positions = [...new Set([member.positions, shift.positionNameSnapshot].filter(Boolean))].join('; ');
  }
  const actualShifts = shifts.filter(shift => shift.attendance !== 'NO_SHOW' && shift.actualStartAt && shift.actualEndAt);
  if (actualShifts.length) {
    const earliest = new Date(Math.min(...actualShifts.map(shift => +shift.actualStartAt!)));
    const latest = new Date(Math.max(...actualShifts.map(shift => +shift.actualEndAt!)));
    const peers = await db.workShift.findMany({
      where: {
        organizationId,
        memberId: { in: memberIds },
        status: 'SCHEDULED',
        cancelledAt: null,
        attendance: { not: 'NO_SHOW' },
        actualStartAt: { lt: latest },
        actualEndAt: { gt: earliest }
      },
      select: { id: true, memberId: true, actualStartAt: true, actualEndAt: true },
      take: 20001,
    });
    if (peers.length > 20000) throw new ApiError(400, 'TIMESHEET_LIMIT', 'Слишком много пересекающихся фактических интервалов.');
    for (const shift of actualShifts) {
      if (peers.some(peer => peer.id !== shift.id && peer.memberId === shift.memberId
        && peer.actualStartAt! < shift.actualEndAt! && peer.actualEndAt! > shift.actualStartAt!)) {
        snapshot.issues.push({
          code: 'ACTUAL_OVERLAP',
          shiftId: shift.id,
          message: `${identities.get(shift.memberId)!.name}: фактическое время пересекается с другой сменой в организации.`
        });
      }
    }
  }
  for (const absence of absences) {
    const member = identities.get(absence.memberId)!;
    const source = members.find(item => item.id === member.id)!;
    const overlapStart = date(absence.startDate) > first ? date(absence.startDate) : first;
    const overlapEnd = date(absence.endDate) < last ? date(absence.endDate) : last;
    let days = 0, vacationDays = 0;
    const dates: string[] = [];
    for (let day = overlapStart; day <= overlapEnd; day = addCalendarDays(day, 1)) {
      const a = startOfZonedDate(day, timezone), b = startOfZonedDate(addCalendarDays(day, 1), timezone);
      const relevant = source.locationMemberships.some(item => item.locationId === locationId && item.joinedAt < b && (!item.leftAt || item.leftAt > a))
        || source.locationTransfers.some(item => item.toLocationId === locationId && item.startAt < b && (!item.endAt || item.endAt > a) && (!item.revokedAt || item.revokedAt > a && item.revokedAt > item.startAt))
        || shifts.some(item => item.memberId === member.id && item.scheduledStartAt < b && item.scheduledEndAt > a);
      if (!relevant)
        continue;
      dates.push(day);
      days++;
      vacationDays += countVacationDays(day, day, organization.vacationHolidays);
      if (shifts.some(shift => shift.memberId === member.id && shift.attendance !== 'NO_SHOW' && shift.actualStartAt && shift.actualEndAt && shift.actualStartAt < b && shift.actualEndAt > a))
        snapshot.issues.push({ code: 'ABSENCE_CONFLICT', message: `${member.name}: работа пересекается с отсутствием ${day}.` });
    }
    if (!days)
      continue;
    if (absence.type === 'VACATION')
      member.vacationDays += vacationDays;
    else if (['SICK', 'SICK_LEAVE'].includes(absence.type))
      member.sickDays += days;
    else
      member.otherAbsenceDays += days;
    snapshot.absences.push({
      id: absence.id,
      memberId: member.id,
      name: member.name,
      number: member.number,
      type: absence.type,
      start: date(absence.startDate),
      end: date(absence.endDate),
      overlapStart,
      overlapEnd,
      days,
      vacationDays: absence.type === 'VACATION' ? vacationDays : 0,
      dates,
      reason: absence.reason,
      comment: absence.comment,
      requestId: absence.sourceRequestId
    });
  }
  const pending = await db.organizationRequest.findMany({
    where: {
      organizationId,
      status: 'PENDING',
      OR: [
        { relatedShiftId: { in: shifts.map(shift => shift.id) } },
        {
          createdByMemberId: { in: memberIds },
          systemCodeSnapshot: { in: ['VACATION', 'SICK', 'SICK_LEAVE', 'DAY_OFF', 'ABSENCE'] },
          startDate: { lte: new Date(last) },
          endDate: { gte: new Date(first) }
        },
        { locationId, proposedStartAt: { lt: end }, proposedEndAt: { gt: start } },
      ]
    },
    take: 1001
  });
  for (const request of pending)
    snapshot.issues.push({
      code: 'PENDING_REQUEST',
      message: `Рассмотрите заявку «${request.typeNameSnapshot}», влияющую на период.`,
      requestId: request.id
    });
  const offers = await db.shiftOffer.count({
    where: {
      organizationId,
      status: { in: ['PENDING', 'AWAITING_APPROVAL'] },
      OR: [{ sourceShiftId: { in: shifts.map(item => item.id) } },
      { targetShiftId: { in: shifts.map(item => item.id) } }]
    }
  });
  if (offers)
    snapshot.issues.push({ code: 'PENDING_OFFERS', message: `Завершите передачу или обмен сменами: ${offers}.` });
  snapshot.members = [...identities.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.id.localeCompare(b.id));
  return snapshot;
}
