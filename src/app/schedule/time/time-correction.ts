import { shiftTimeRange } from '../date-utils.ts'
import type { WorkShift } from '../types.ts'

export const correctionLabels = { LATE: 'Опоздал', EARLY: 'Ушёл раньше', NO_SHOW: 'Не вышел', CUSTOM: 'Другая корректировка', RESTORE: 'Вернуть по плану' } as const
export type CorrectionMode = keyof typeof correctionLabels
export type CorrectionInput = { mode: CorrectionMode; startAt?: string; endAt?: string; comment?: string }
export type CorrectionShift = Pick<WorkShift, 'status' | 'attendance' | 'scheduledStartAt' | 'scheduledEndAt' | 'actualStartAt' | 'actualEndAt' | 'actualBreakMinutes'>

export function canCorrectShift(shift: Pick<WorkShift, 'status' | 'scheduledStartAt'>, now = Date.now()) {
  return shift.status !== 'CANCELLED' && Date.parse(shift.scheduledStartAt) <= now
}

/** Shared preview/validation. Dates are UTC instants; local input is converted in the point's zone. */
export function resolveTimeCorrection(shift: CorrectionShift, input: CorrectionInput, now = Date.now()) {
  if (!canCorrectShift(shift, now)) throw new Error('Корректировка доступна после начала действующей смены.')
  let actualStartAt = shift.actualStartAt, actualEndAt = shift.actualEndAt
  let attendance: NonNullable<WorkShift['attendance']> = shift.attendance ?? 'UNCONFIRMED'
  let actualBreakMinutes = shift.actualBreakMinutes
  const plannedStart = Date.parse(shift.scheduledStartAt), plannedEnd = Date.parse(shift.scheduledEndAt)
  if (input.mode === 'RESTORE' || input.mode === 'NO_SHOW') {
    actualStartAt = null; actualEndAt = null; actualBreakMinutes = null
    attendance = input.mode === 'NO_SHOW' ? 'NO_SHOW' : 'UNCONFIRMED'
  } else {
    if (shift.attendance === 'NO_SHOW' && input.mode !== 'CUSTOM') throw new Error('Сначала верните время по плану или выберите другую корректировку.')
    if (input.mode === 'LATE') {
      const start = Date.parse(input.startAt ?? '')
      if (!Number.isFinite(start) || start <= plannedStart || start > now) throw new Error('Укажите прошедшее время прихода позже начала по плану.')
      actualStartAt = new Date(start).toISOString()
      // Arrival alone must never record a planned future end as an actual departure.
      attendance = actualEndAt ? 'PARTIAL' : 'UNCONFIRMED'
    } else if (input.mode === 'EARLY') {
      const end = Date.parse(input.endAt ?? '')
      if (!Number.isFinite(end) || end >= plannedEnd || end > now) throw new Error('Укажите прошедшее время ухода раньше окончания по плану.')
      actualEndAt = new Date(end).toISOString(); attendance = 'PARTIAL'
    } else {
      const start = Date.parse(input.startAt ?? ''), end = Date.parse(input.endAt ?? '')
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || end > now) throw new Error('Укажите прошедший период фактической работы.')
      actualStartAt = new Date(start).toISOString(); actualEndAt = new Date(end).toISOString(); attendance = 'WORKED'
    }
    if (Date.parse(actualEndAt ?? shift.scheduledEndAt) <= Date.parse(actualStartAt ?? shift.scheduledStartAt)) throw new Error('Окончание должно быть позже начала. Проверьте дату ночной смены.')
  }
  const minutes = attendance === 'NO_SHOW' ? 0 : Math.max(0, Math.floor((Date.parse(actualEndAt ?? shift.scheduledEndAt) - Date.parse(actualStartAt ?? shift.scheduledStartAt)) / 60000))
  if (actualBreakMinutes !== null && actualBreakMinutes >= minutes) throw new Error('Период должен быть длиннее сохранённого перерыва. Верните время по плану перед новой корректировкой.')
  const provisional = attendance !== 'NO_SHOW' && actualEndAt === null
  return { actualStartAt, actualEndAt, actualBreakMinutes, attendance, minutes, provisional }
}

export function correctionReason(input: CorrectionInput) {
  const reason = { LATE: 'Опоздание', EARLY: 'Ранний уход', NO_SHOW: 'Неявка', CUSTOM: 'Корректировка времени', RESTORE: 'Возврат к учёту по расписанию' }[input.mode]
  return input.comment?.trim() ? `${reason}: ${input.comment.trim()}` : reason
}

export function accountedTimeLabel(shift: Pick<WorkShift, 'attendance' | 'scheduledStartAt' | 'scheduledEndAt' | 'actualStartAt' | 'actualEndAt'>, timezone: string) {
  if (shift.attendance === 'NO_SHOW') return 'Неявка · 0 ч'
  return `${shiftTimeRange(shift.actualStartAt ?? shift.scheduledStartAt, shift.actualEndAt ?? shift.scheduledEndAt, timezone)}${shift.actualStartAt && !shift.actualEndAt ? ' · окончание по плану' : ''}`
}

