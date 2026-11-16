import { addCalendarDateDays, isCalendarDate } from '../../shared/date-time.ts'

export const MAX_BATCH_DATES = 62

export type BatchShiftTime = {
  startTime: string
  endTime: string
  overnight: boolean
}

export type BatchShiftOverrides = Record<string, BatchShiftTime>

// Calendar selection must not depend on the browser's timezone or DST changes.
export function selectBatchDates(from: string, to: string, weekdays?: readonly number[]) {
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new Error('Укажите обе даты периода.')
  if (to < from) throw new Error('Конец периода должен быть не раньше начала.')
  if (weekdays && (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new Error('Выберите хотя бы один день недели.')
  }

  const dates: string[] = []
  for (let day = from; ; day = addCalendarDateDays(day, 1)) {
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
    if (!weekdays || weekdays.includes(weekday)) dates.push(day)
    if (dates.length > MAX_BATCH_DATES) throw new Error(`За один раз можно выбрать не больше ${MAX_BATCH_DATES} дат.`)
    if (day === to) break
  }
  if (!dates.length) throw new Error('В этом периоде нет выбранных дней недели.')
  return dates
}

export function retainBatchOverrides(overrides: BatchShiftOverrides, dates: readonly string[]) {
  const selected = new Set(dates)
  return Object.fromEntries(Object.entries(overrides).filter(([day]) => selected.has(day)))
}

export function batchTimeError(times: BatchShiftTime) {
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  if (!validTime.test(times.startTime) || !validTime.test(times.endTime)) return 'Укажите время начала и окончания.'
  if (!times.overnight && times.endTime <= times.startTime) {
    return 'Окончание должно быть позже начала. Для ночной смены включите следующий день.'
  }
  return null
}

export function batchShiftLabel(count: number) {
  const last = count % 10
  const teen = count % 100 >= 11 && count % 100 <= 14
  const noun = !teen && last === 1 ? 'смену' : !teen && last >= 2 && last <= 4 ? 'смены' : 'смен'
  return `${count} ${noun}`
}
