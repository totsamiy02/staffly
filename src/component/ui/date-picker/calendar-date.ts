// These Dates are calendar arithmetic containers, never local/UTC instants sent
// to the API. UTC accessors keep a browser's DST/skipped days out of the grid.
export const calendarKey = (date: Date) => `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
export const parseCalendarDate = (value: string) => new Date(`${value}T12:00:00Z`)
export function calendarDate(year: number, month: number, day: number) {
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(12, 0, 0, 0)
  return date
}
export function browserToday() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
