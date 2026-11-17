import assert from 'node:assert/strict'
import { it } from 'node:test'
import { availabilityConfigSchema, availabilityRuleSchema, emptyAvailabilityWeek, type AvailabilityConfig } from '../../src/shared/availability.ts'
import { availabilityIssue } from '../../src/server/schedule/availability/calculation.ts'

const monday = '2026-11-23'
const interval = (start: string, end: string) => [new Date(start), new Date(end)] as const

it('validates real dates, unique exceptions and explicit overnight bounds', () => {
  assert.equal(availabilityRuleSchema.safeParse({ mode: 'TIME', start: '16:00', end: '08:00', overnight: false }).success, false)
  assert.equal(availabilityRuleSchema.safeParse({ mode: 'TIME', start: '16:00', end: '23:00', overnight: true }).success, false)
  assert.equal(availabilityRuleSchema.safeParse({ mode: 'TIME', start: '16:00', end: '08:00', overnight: true }).success, true)
  assert.equal(availabilityConfigSchema.safeParse({ weeks: [], exceptions: [{ date: '2026-02-30', rule: { mode: 'OFF' } }] }).success, false)
  assert.equal(availabilityConfigSchema.safeParse({ weeks: [], exceptions: [1, 2].map(() => ({ date: monday, rule: { mode: 'OFF' } })) }).success, false)
})

it('applies recurring availability only from its effective date and checks exact half-open bounds', () => {
  const days = emptyAvailabilityWeek()
  days[0] = { mode: 'TIME', start: '16:00', end: '23:00', overnight: false }
  days[1] = { mode: 'OFF' }
  const config = { weeks: [{ from: monday, days }], exceptions: [] }
  assert.equal(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-16T06:00Z', '2026-11-16T15:00Z')), null)
  assert.equal(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-23T13:00Z', '2026-11-23T20:00Z')), null)
  assert.ok(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-23T12:59Z', '2026-11-23T20:00Z')))
  assert.ok(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-24T07:00Z', '2026-11-24T15:00Z')))
})

it('lets a dated exception replace an unavailable weekday and restore an unrestricted day', () => {
  const days = emptyAvailabilityWeek()
  days[1] = { mode: 'OFF' }
  const config: AvailabilityConfig = { weeks: [{ from: monday, days }], exceptions: [{ date: '2026-11-24', rule: { mode: 'TIME' as const, start: '10:00', end: '18:00', overnight: false } }] }
  assert.equal(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-24T07:00Z', '2026-11-24T15:00Z')), null)
  assert.ok(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-24T06:00Z', '2026-11-24T15:00Z')))
  config.exceptions[0].rule = { mode: 'ANY' }
  assert.equal(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-24T01:00Z', '2026-11-24T20:00Z')), null)
})

it('checks an entire night and lets the next calendar date override the incoming night portion', () => {
  const days = emptyAvailabilityWeek()
  days[0] = { mode: 'TIME', start: '22:00', end: '06:00', overnight: true }
  days[1] = { mode: 'OFF' }
  const config = { weeks: [{ from: monday, days }], exceptions: [] as Array<{ date: string; rule: { mode: 'OFF' } }> }
  assert.equal(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-23T19:00Z', '2026-11-24T03:00Z')), null)
  assert.ok(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-23T19:00Z', '2026-11-24T03:01Z')))
  config.exceptions.push({ date: '2026-11-24', rule: { mode: 'OFF' } })
  assert.ok(availabilityIssue(config, 'Europe/Moscow', ...interval('2026-11-23T19:00Z', '2026-11-24T03:00Z')))
})

it('compares instants in the saved availability timezone across other points and DST transitions', () => {
  const days = emptyAvailabilityWeek()
  days[6] = { mode: 'TIME', start: '00:00', end: '04:00', overnight: false }
  const config = { weeks: [{ from: '2026-03-01', days }], exceptions: [] }
  assert.equal(availabilityIssue(config, 'America/New_York', ...interval('2026-03-08T05:00Z', '2026-03-08T08:00Z')), null)
  assert.ok(availabilityIssue(config, 'America/New_York', ...interval('2026-03-08T05:00Z', '2026-03-08T08:01Z')))
  const moscow = emptyAvailabilityWeek()
  moscow[0] = { mode: 'TIME', start: '16:00', end: '23:00', overnight: false }
  assert.equal(availabilityIssue({ weeks: [{ from: monday, days: moscow }], exceptions: [] }, 'Europe/Moscow', ...interval('2026-11-23T13:00Z', '2026-11-23T20:00Z')), null)
})
