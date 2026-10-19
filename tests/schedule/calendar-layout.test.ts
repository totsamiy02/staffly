import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calendarRange, addDays, shiftsByDate, shiftCoversDate, zonedDateAndTime, formatTime } from '../../src/app/schedule/date-utils.ts'

test('calendar navigation keeps six complete weeks for short, leap and long months', () => {
  for (const month of ['2026-02', '2024-02', '2026-03', '2026-10', '2026-12', '2027-01']) {
    const range = calendarRange(month, true)
    assert.equal(range.days.length, 42)
    assert.equal(new Date(range.from).getUTCDay(), 1)
    assert.equal(new Date(range.days.at(-1)!).getUTCDay(), 0)
    assert.equal(range.to, addDays(range.from, 42))
    const [year, number] = month.split('-').map(Number)
    assert.equal(range.days.filter(day => day.startsWith(month)).length, new Date(Date.UTC(year, number, 0)).getUTCDate())
    assert.equal(new Set(range.days).size, 42)
  }
})

test('compact calendar ranges used by existing business calculations stay unchanged', () => {
  assert.equal(calendarRange('2026-02').days.length, 35)
  assert.equal(calendarRange('2026-10').days.length, 35)
  assert.equal(calendarRange('2026-03').days.length, 42)
})

test('calendar shift index preserves local dates, midnight endings, sparse days and input order', () => {
  const shifts = [
    { id: 'night', scheduledStartAt: '2026-10-17T20:00:00Z', scheduledEndAt: '2026-10-18T03:00:00Z' },
    { id: 'midnight', scheduledStartAt: '2026-10-18T09:00:00Z', scheduledEndAt: '2026-10-18T21:00:00Z' },
    { id: 'outside', scheduledStartAt: '2026-09-01T09:00:00Z', scheduledEndAt: '2026-09-01T10:00:00Z' },
    { id: 'long', scheduledStartAt: '2026-10-01T09:00:00Z', scheduledEndAt: '2026-10-31T09:00:00Z' },
  ]
  const days = ['2026-10-19', '2026-10-17', '2026-10-18', '2026-10-18']
  const index = shiftsByDate(shifts, days, 'Europe/Moscow')
  assert.deepEqual(index.get('2026-10-17')?.map(s => s.id), ['night', 'long'])
  assert.deepEqual(index.get('2026-10-18')?.map(s => s.id), ['night', 'midnight', 'long'])
  assert.deepEqual(index.get('2026-10-19')?.map(s => s.id), ['long'])
  assert.equal(index.size, 3)
  assert.equal(shiftsByDate(shifts, [], 'Europe/Moscow').size, 0)
  assert.equal(shiftsByDate(shifts, ['2026-10-18', '2026-10-20'], 'Europe/Moscow').has('2026-10-19'), false)
})

test('calendar index matches day selection across DST, month/year and fractional timezone boundaries', () => {
  const shifts = [
    { scheduledStartAt: '2026-10-24T20:00:00Z', scheduledEndAt: '2026-10-26T00:00:00Z' },
    { scheduledStartAt: '2026-12-31T20:00:00Z', scheduledEndAt: '2027-01-01T00:00:00Z' },
  ]
  for (const timezone of ['Europe/Berlin', 'Europe/Moscow', 'Asia/Kathmandu', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    for (const month of ['2026-10', '2026-12', '2027-01']) {
      const days = calendarRange(month, true).days, index = shiftsByDate(shifts, days, timezone)
      for (const day of days) assert.deepEqual(index.get(day), shifts.filter(s => shiftCoversDate(s, day, timezone)))
    }
  }
  // Switching zones must never reuse a formatter from the previous point.
  assert.equal(zonedDateAndTime('2026-10-18T20:30:00Z', 'Asia/Kathmandu').date, '2026-10-19')
  assert.equal(zonedDateAndTime('2026-10-18T20:30:00Z', 'Europe/Moscow').date, '2026-10-18')
  assert.equal(formatTime('2026-10-18T20:30:00Z', 'Asia/Kathmandu'), '02:15')
})
