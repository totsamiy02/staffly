import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calendarRange, addDays } from '../src/app/schedule/date-utils.ts'

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
