import { ApiError } from '../api-error.ts'

type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partsInZone(date: Date, timeZone: string): DateParts {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => { result[part.type] = part.value; return result }, {})
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) }
}

function offsetAt(date: Date, timeZone: string) {
  const part = partsInZone(date, timeZone)
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - Math.floor(date.getTime() / 1000) * 1000
}

export function zonedDateTimeToUtc(dateValue: string, timeValue: string, timeZone: string) {
  const [year, month, day] = dateValue.split('-').map(Number)
  const [hour, minute] = timeValue.split(':').map(Number)
  const wallClock = Date.UTC(year, month - 1, day, hour, minute)
  let result = new Date(wallClock - offsetAt(new Date(wallClock), timeZone))
  result = new Date(wallClock - offsetAt(result, timeZone))
  const actual = partsInZone(result, timeZone)
  if (actual.year !== year || actual.month !== month || actual.day !== day || actual.hour !== hour || actual.minute !== minute) {
    throw new ApiError(400, 'INVALID_LOCAL_TIME', 'Выбранное местное время не существует в часовом поясе организации.')
  }
  return result
}

export function startOfZonedDate(dateValue: string, timeZone: string) {
  return zonedDateTimeToUtc(dateValue, '00:00', timeZone)
}

export function addCalendarDays(dateValue: string, days: number) {
  const [year, month, day] = dateValue.split('-').map(Number)
  const result = new Date(Date.UTC(year, month - 1, day + days))
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`
}

export function zonedParts(date: Date, timeZone: string) {
  return partsInZone(date, timeZone)
}
