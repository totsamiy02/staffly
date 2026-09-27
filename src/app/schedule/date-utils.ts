import type { WorkShift } from './types.ts'

export function dateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export function addDays(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return dateKey(date)
}

export function monthKeyInZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date)
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? ''
  return `${get('year')}-${get('month')}`
}

export function calendarRange(month: string) {
  const [year, number] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, number - 1, 1))
  const mondayOffset = (first.getUTCDay() + 6) % 7
  first.setUTCDate(first.getUTCDate() - mondayOffset)
  const daysInMonth = new Date(Date.UTC(year, number, 0)).getUTCDate()
  const dayCount = Math.ceil((mondayOffset + daysInMonth) / 7) * 7
  const last = new Date(first)
  last.setUTCDate(last.getUTCDate() + dayCount)
  return { from: dateKey(first), to: dateKey(last), days: Array.from({ length: dayCount }, (_, index) => addDays(dateKey(first), index)) }
}

export function moveMonth(month: string, amount: number) {
  const [year, number] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, number - 1 + amount, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function formatMonth(month: string) {
  const [year, number] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 1)))
}

export function zonedDateAndTime(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

export function formatTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} мин`
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`
}

export function displayDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
}

export function shiftState(shift: Pick<WorkShift, 'status' | 'scheduledStartAt' | 'scheduledEndAt' | 'actualStartAt' | 'actualEndAt'>, now = Date.now()) {
  if (shift.status === 'CANCELLED') return { key: 'cancelled', label: 'Отменена' }
  const start = new Date(shift.actualStartAt ?? shift.scheduledStartAt).getTime()
  const end = new Date(shift.actualEndAt ?? shift.scheduledEndAt).getTime()
  if (now < start) return { key: 'future', label: 'Запланирована' }
  if (now >= end) return { key: 'completed', label: 'Завершена' }
  return { key: 'active', label: 'Идёт сейчас' }
}

export function shiftTimeRange(startAt: string, endAt: string, timezone: string, referenceDate?: string) {
  const start = zonedDateAndTime(startAt, timezone)
  const end = zonedDateAndTime(endAt, timezone)
  const shortDate = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`
  if (start.date !== end.date || (referenceDate && start.date !== referenceDate)) return `${shortDate(start.date)}, ${start.time} → ${shortDate(end.date)}, ${end.time}`
  return `${start.time}–${end.time}`
}
