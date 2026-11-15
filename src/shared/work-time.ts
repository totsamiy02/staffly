/** Accounting rules are independent of role, tariff and presentation. Breaks are included. */
export const workTimeRules = {
  version: 'minutes-v2',
  breaks: 'INCLUDED',
  rounding: 'FULL_MINUTES',
  attribution: 'SCHEDULED_START_IN_LOCATION_ZONE',
} as const;

export type WorkTimeInput = {
  scheduledStartAt: Date | string;
  scheduledEndAt: Date | string;
  actualStartAt?: Date | string | null;
  actualEndAt?: Date | string | null;
  attendance?: string;
  status?: string;
  cancelledAt?: Date | string | null;
};
export type WorkTimeState =
  | 'CANCELLED'
  | 'FUTURE'
  | 'IN_PROGRESS'
  | 'UNCONFIRMED'
  | 'INCOMPLETE'
  | 'CONFIRMED'
  | 'NO_SHOW';
export type ShiftAccounting = {
  plannedMinutes: number;
  estimatedMinutes: number;
  confirmedMinutes: number | null;
  state: WorkTimeState;
  source: 'SCHEDULE' | 'PARTIAL' | 'UNCONFIRMED_MARKS' | 'ACTUAL' | 'NO_SHOW' | 'CANCELLED';
  completed: boolean;
  pending: boolean;
};
const instant = (value: Date | string) => value instanceof Date ? value.getTime() : Date.parse(value);

export function intervalMinutes(start: Date | string, end: Date | string) {
  const duration = instant(end) - instant(start);
  return Number.isFinite(duration) ? Math.max(0, Math.floor(duration / 60000)) : 0;
}

export function estimatedWorkInterval(shift: WorkTimeInput) {
  return {
    start: shift.actualStartAt ?? shift.scheduledStartAt,
    end: shift.actualEndAt ?? shift.scheduledEndAt,
  };
}

export function calculateWorkTime(shift: WorkTimeInput, asOf: Date | number = Date.now()): ShiftAccounting {
  const now = asOf instanceof Date ? asOf.getTime() : asOf;
  const plannedMinutes = intervalMinutes(shift.scheduledStartAt, shift.scheduledEndAt);
  const base = {
    plannedMinutes,
    estimatedMinutes: 0,
    confirmedMinutes: null,
    completed: false,
    pending: false,
  };
  if (shift.status === 'CANCELLED' || shift.cancelledAt) {
    return { ...base, state: 'CANCELLED', source: 'CANCELLED' };
  }

  const started = instant(shift.scheduledStartAt) <= now;
  if (shift.attendance === 'NO_SHOW' && started) {
    return { ...base, confirmedMinutes: 0, completed: true, state: 'NO_SHOW', source: 'NO_SHOW' };
  }

  const start = shift.actualStartAt;
  const end = shift.actualEndAt;
  const validRange = !!start && !!end && instant(end) > instant(start) && instant(end) <= now;
  const confirmed = validRange && ['WORKED', 'PARTIAL'].includes(shift.attendance ?? '');
  const interval = estimatedWorkInterval(shift);
  const estimatedMinutes = intervalMinutes(interval.start, interval.end);
  if (confirmed) {
    return {
      plannedMinutes,
      estimatedMinutes,
      confirmedMinutes: intervalMinutes(start!, end!),
      completed: true,
      pending: false,
      state: 'CONFIRMED',
      source: 'ACTUAL',
    };
  }

  const completed = instant(shift.scheduledEndAt) <= now || !!end && instant(end) <= now;
  const hasMarks = !!start || !!end;
  const incomplete = hasMarks && (!start || !end);
  let state: WorkTimeState = 'IN_PROGRESS';
  if (!started) state = 'FUTURE';
  else if (incomplete) state = 'INCOMPLETE';
  else if (completed) state = 'UNCONFIRMED';

  let source: ShiftAccounting['source'] = 'SCHEDULE';
  if (incomplete) source = 'PARTIAL';
  else if (hasMarks) source = 'UNCONFIRMED_MARKS';

  return {
    plannedMinutes,
    estimatedMinutes,
    confirmedMinutes: null,
    completed,
    pending: started && completed,
    state,
    source,
  };
}

export const workTimeStateNames: Record<WorkTimeState, string> = {
  CANCELLED: 'Отменена',
  FUTURE: 'Будущая смена',
  IN_PROGRESS: 'Смена идёт',
  UNCONFIRMED: 'Не подтверждено',
  INCOMPLETE: 'Неполные отметки',
  CONFIRMED: 'Подтверждено',
  NO_SHOW: 'Неявка подтверждена',
};
export const workTimeSourceNames: Record<ShiftAccounting['source'], string> = {
  SCHEDULE: 'Расписание',
  PARTIAL: 'Отметки и расписание',
  UNCONFIRMED_MARKS: 'Неподтверждённые отметки',
  ACTUAL: 'Подтверждённые отметки',
  NO_SHOW: 'Подтверждённая неявка',
  CANCELLED: 'Отменена',
};
