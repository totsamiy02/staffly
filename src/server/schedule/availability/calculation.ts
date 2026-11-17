import type { AvailabilityConfig, AvailabilityRule } from '../../../shared/availability.ts'
import { availabilityRuleLabel } from '../../../shared/availability.ts'
import { zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { addCalendarDateDays, startOfCalendarDate, wallClockToInstant } from '../../../shared/date-time.ts'

type Window = { start: number; end: number }
const any: AvailabilityRule = { mode: 'ANY' }
export function ruleOnDate(config: AvailabilityConfig, date: string) {
  const exception = config.exceptions.find(item => item.date === date)
  if (exception) return exception.rule
  const week = [...config.weeks].reverse().find(item => item.from <= date)
  return week?.days[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7] ?? any
}

// A night interval belongs to its starting weekday. An explicit exception on
// the next calendar date replaces that date, including the incoming night part.
export function availabilityIssue(config: AvailabilityConfig, timezone: string, start: Date, end: Date) {
  if (end <= start) return null
  const first = zonedDateAndTime(start.toISOString(), timezone).date
  const last = zonedDateAndTime(new Date(+end - 1).toISOString(), timezone).date
  if (!config.weeks.length && !config.exceptions.length) return null
  const windows: Window[] = []
  let examined = 0
  try {
    for (let day = addCalendarDateDays(first, -1); day <= last; day = addCalendarDateDays(day, 1)) {
      if (++examined > 370) return { date: first, message: 'Проверьте доступность: интервал смены превышает год.' }
      const rule = ruleOnDate(config, day)
      if (rule.mode === 'OFF') continue
      const next = addCalendarDateDays(day, 1)
      const boundary = config.exceptions.some(item => item.date === next) || config.weeks.some(item => item.from === next)
      const from = rule.mode === 'ANY' ? startOfCalendarDate(day, timezone) : wallClockToInstant(day, rule.start, timezone)
      let to = rule.mode === 'ANY' ? startOfCalendarDate(next, timezone) : wallClockToInstant(rule.overnight ? next : day, rule.end, timezone)
      if (boundary && rule.mode === 'TIME' && rule.overnight) to = new Date(Math.min(+to, +startOfCalendarDate(next, timezone)))
      windows.push({ start: +from, end: +to })
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { date: first, message: 'Время правила не существует в выбранную дату. Уточните доступность с учётом перевода часов.' }
  }
  let cursor = +start
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    if (window.end <= cursor) continue
    if (window.start > cursor) break
    cursor = Math.max(cursor, window.end)
    if (cursor >= +end) return null
  }
  const date = zonedDateAndTime(new Date(cursor).toISOString(), timezone).date
  const rule = ruleOnDate(config, date)
  return {
    date,
    message: rule.mode === 'TIME' ? availabilityRuleLabel(rule) : 'Недоступен весь день',
  }
}
