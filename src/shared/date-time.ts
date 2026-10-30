// Calendar dates are YYYY-MM-DD strings, not instants. A Date represents a UTC
// instant. Wall-clock input is converted exactly once using the point's IANA zone.
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

export function addCalendarDateDays(value: string, days: number) {
  if (!isCalendarDate(value) || !Number.isInteger(days)) throw new RangeError('Некорректная календарная дата.')
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  const result = date.toISOString().slice(0, 10)
  if (!isCalendarDate(result)) throw new RangeError('Дата выходит за допустимый диапазон.')
  return result
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number }
const formatters = new Map<string, Intl.DateTimeFormat>()
const conversions = new Map<string, number>()

export function dateTimeParts(date: Date, timeZone: string): Parts {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value!)
    formatters.set(timeZone, formatter)
  }
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  return { year: +values.year, month: +values.month, day: +values.day, hour: +values.hour, minute: +values.minute, second: +values.second }
}

function offsetAt(time: number, timeZone: string) {
  const p = dateTimeParts(new Date(time), timeZone)
  const wall = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}Z`
  return Date.parse(wall) - Math.floor(time / 1000) * 1000
}

// In an autumn DST overlap choose the EARLIER occurrence on both server and UI.
// Nonexistent spring-forward times are rejected; a clock hour is never guessed.
export function wallClockToInstant(date: string, time: string, timeZone: string): Date {
  if (!isCalendarDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError('Укажите существующую дату и время.')
  const key = `${date}T${time}@${timeZone}`, cached = conversions.get(key)
  if (cached !== undefined) return new Date(cached)
  const wall = Date.parse(`${date}T${time}:00.000Z`)
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = time.split(':').map(Number)
  // Sampling either side also covers half-hour DST and zones beyond UTC+12.
  const offsets = new Set([-36, -12, 0, 12, 36].map(hours => offsetAt(wall + hours * 3600000, timeZone)))
  const candidates = [...offsets].map(offset => wall - offset).filter(instant => {
    const p = dateTimeParts(new Date(instant), timeZone)
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === 0
  })
  if (!candidates.length) throw new RangeError('Выбранное местное время не существует в часовом поясе точки.')
  const instant = Math.min(...candidates)
  if (conversions.size >= 4096) conversions.delete(conversions.keys().next().value!)
  conversions.set(key, instant)
  return new Date(instant)
}

export function startOfCalendarDate(date: string, timeZone: string): Date {
  // Some IANA zones advance at midnight. Such a day begins at 01:00 (or
  // another first valid minute), while an entirely skipped date is invalid.
  const at = (minute: number) => {
    try { return wallClockToInstant(date, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, timeZone) }
    catch (error) {
      if (!(error instanceof RangeError) || !isCalendarDate(date)) throw error
      if (minute === 0) dateTimeParts(new Date(`${date}T00:00:00Z`), timeZone) // Reject an invalid zone without a minute-by-minute retry.
    }
  }
  const midnight = at(0)
  if (midnight) return midnight
  for (const end of [...Array.from({ length: 23 }, (_, index) => (index + 1) * 60), 1439]) {
    const valid = at(end)
    if (!valid) continue
    let low = end === 1439 ? 1380 : end - 60, high = end
    while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (at(middle)) high = middle; else low = middle }
    return at(high)!
  }
  throw new RangeError('Эта календарная дата не существует в часовом поясе точки.')
}
