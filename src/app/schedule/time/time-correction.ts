import { shiftTimeRange } from '../date-utils.ts';
import type { WorkShift } from '../types.ts';
import { calculateWorkTime } from '../../../shared/work-time.ts';

export const correctionLabels = {
  MARKS: 'Отметки', LATE: 'Опоздал', EARLY: 'Ушёл раньше', NO_SHOW: 'Не вышел',
  CUSTOM: 'Полный факт', RESTORE: 'Снять подтверждение', CONFIRM: 'Подтвердить по плану',
} as const;
export type CorrectionMode = keyof typeof correctionLabels;
export type CorrectionInput = { mode: CorrectionMode; startAt?: string | null; endAt?: string | null; comment?: string };
export type CorrectionShift = Pick<WorkShift, 'status' | 'attendance' | 'scheduledStartAt' | 'scheduledEndAt' | 'actualStartAt' | 'actualEndAt' | 'actualBreakMinutes'> & { breakMinutes?: number };

export function canCorrectShift(shift: Pick<WorkShift, 'status' | 'scheduledStartAt'>, now = Date.now()) {
  return shift.status !== 'CANCELLED' && Date.parse(shift.scheduledStartAt) <= now;
}
export function canConfirmShiftPlan(shift: CorrectionShift, now = Date.now()) {
  return canCorrectShift(shift, now) && Date.parse(shift.scheduledEndAt) <= now
    && (!shift.attendance || shift.attendance === 'UNCONFIRMED') && !shift.actualStartAt && !shift.actualEndAt;
}

/** Preview and server validation share one calculation; missing marks remain missing. */
export function resolveTimeCorrection(shift: CorrectionShift, input: CorrectionInput, now = Date.now()) {
  if (!canCorrectShift(shift, now)) throw new Error('Корректировка доступна после начала действующей смены.');
  let actualStartAt = shift.actualStartAt;
  let actualEndAt = shift.actualEndAt;
  let actualBreakMinutes = shift.actualBreakMinutes;
  let attendance = shift.attendance ?? 'UNCONFIRMED';
  const plannedStart = Date.parse(shift.scheduledStartAt);
  const plannedEnd = Date.parse(shift.scheduledEndAt);
  if (input.mode === 'RESTORE' || input.mode === 'NO_SHOW') {
    actualStartAt = null;
    actualEndAt = null;
    actualBreakMinutes = null;
    attendance = input.mode === 'NO_SHOW' ? 'NO_SHOW' : 'UNCONFIRMED';
  } else if (input.mode === 'CONFIRM') {
    if (!canConfirmShiftPlan(shift, now)) throw new Error('Подтверждение по плану доступно для завершённой смены без введённых отметок.');
    actualStartAt = shift.scheduledStartAt;
    actualEndAt = shift.scheduledEndAt;
    actualBreakMinutes = shift.breakMinutes ?? 0;
    attendance = 'WORKED';
  } else {
    if (shift.attendance === 'NO_SHOW' && !['CUSTOM', 'MARKS'].includes(input.mode))
      throw new Error('Сначала снимите подтверждение неявки или укажите полный факт.');
    if (input.mode === 'LATE') {
      const start = Date.parse(input.startAt ?? '');
      if (!Number.isFinite(start) || start <= plannedStart || start > now)
        throw new Error('Укажите прошедшее время прихода позже начала по плану.');
      actualStartAt = new Date(start).toISOString();
    } else if (input.mode === 'EARLY') {
      const end = Date.parse(input.endAt ?? '');
      if (!Number.isFinite(end) || end >= plannedEnd || end > now)
        throw new Error('Укажите прошедшее время ухода раньше окончания по плану.');
      actualEndAt = new Date(end).toISOString();
    } else {
      actualStartAt = input.startAt ?? null;
      actualEndAt = input.endAt ?? null;
      if (input.mode === 'CUSTOM' && (!actualStartAt || !actualEndAt))
        throw new Error('Укажите полный фактический период.');
      if (!actualStartAt && !actualEndAt) throw new Error('Укажите хотя бы одну фактическую отметку.');
      for (const value of [actualStartAt, actualEndAt]) {
        if (value && (!Number.isFinite(Date.parse(value)) || Date.parse(value) > now))
          throw new Error('Фактическая отметка должна быть в прошлом.');
      }
    }
    if (Date.parse(actualEndAt ?? shift.scheduledEndAt) <= Date.parse(actualStartAt ?? shift.scheduledStartAt))
      throw new Error('Окончание должно быть позже начала. Проверьте дату ночной смены.');
    attendance = actualStartAt && actualEndAt
      ? Date.parse(actualStartAt) === plannedStart && Date.parse(actualEndAt) === plannedEnd ? 'WORKED' : 'PARTIAL'
      : 'UNCONFIRMED';
  }
  const accounting = calculateWorkTime({ ...shift, actualStartAt, actualEndAt, attendance }, now);
  if (actualBreakMinutes !== null && attendance !== 'NO_SHOW' && actualBreakMinutes >= accounting.estimatedMinutes)
    throw new Error('Период должен быть длиннее сохранённого перерыва. Проверьте отметки.');
  return { actualStartAt, actualEndAt, actualBreakMinutes, attendance, accounting, minutes: accounting.estimatedMinutes, provisional: accounting.confirmedMinutes === null };
}

export function correctionReason(input: CorrectionInput) {
  const reasons: Record<CorrectionMode, string> = {
    MARKS: 'Уточнение фактических отметок', LATE: 'Опоздание', EARLY: 'Ранний уход', NO_SHOW: 'Неявка',
    CUSTOM: 'Корректировка времени', RESTORE: 'Снятие подтверждения факта', CONFIRM: 'Явное подтверждение по расписанию',
  };
  return input.comment?.trim() ? `${reasons[input.mode]}: ${input.comment.trim()}` : reasons[input.mode];
}
export function accountedTimeLabel(shift: Pick<WorkShift, 'attendance' | 'scheduledStartAt' | 'scheduledEndAt' | 'actualStartAt' | 'actualEndAt'>, timezone: string) {
  const time = calculateWorkTime(shift);
  if (time.state === 'NO_SHOW') return 'Неявка · 0 ч';
  const range = shiftTimeRange(shift.actualStartAt ?? shift.scheduledStartAt, shift.actualEndAt ?? shift.scheduledEndAt, timezone);
  return `${range} · ${time.confirmedMinutes === null ? 'предварительно' : 'подтверждено'}`;
}
