import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batchShiftLabel, batchTimeError, MAX_BATCH_DATES, retainBatchOverrides, selectBatchDates } from '../../src/app/schedule/batch-shifts.ts'

test('batch selection includes both boundaries and crosses months and leap days', () => {
  assert.deepEqual(selectBatchDates('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01'])
  assert.deepEqual(selectBatchDates('2026-11-16', '2026-11-16'), ['2026-11-16'])
  assert.equal(selectBatchDates('2026-11-16', '2026-11-30').length, 15)
})

test('weekday selection uses calendar days independently of DST and the process timezone', () => {
  assert.deepEqual(selectBatchDates('2026-03-27', '2026-03-31', [0, 4, 6]), ['2026-03-27', '2026-03-29', '2026-03-30'])
  assert.deepEqual(selectBatchDates('2026-11-16', '2026-11-30', [0, 2, 4]), ['2026-11-16', '2026-11-18', '2026-11-20', '2026-11-23', '2026-11-25', '2026-11-27', '2026-11-30'])
})

test('selection rejects invalid periods, empty weekday sets and empty results', () => {
  for (const [from, to] of [['', '2026-11-30'], ['2026-02-30', '2026-03-01'], ['2026-11-30', '2026-11-16']]) assert.throws(() => selectBatchDates(from, to))
  assert.throws(() => selectBatchDates('2026-11-16', '2026-11-30', []))
  assert.throws(() => selectBatchDates('2026-11-16', '2026-11-16', [6]))
  assert.throws(() => selectBatchDates('2026-11-16', '2026-11-30', [7]))
  assert.deepEqual(selectBatchDates('9999-12-31', '9999-12-31'), ['9999-12-31'])
})

test('selection enforces the existing 62-date limit without truncating a request', () => {
  assert.equal(selectBatchDates('2026-01-01', '2026-03-03').length, MAX_BATCH_DATES)
  assert.throws(() => selectBatchDates('2026-01-01', '2026-03-04'), /62/)
  assert.equal(selectBatchDates('2026-01-05', '2027-03-08', [0]).length, MAX_BATCH_DATES)
  assert.throws(() => selectBatchDates('2026-01-05', '9999-12-31', [0]), /62/)
})

test('removing dates drops only their overrides and leaves selected individual times intact', () => {
  const first = { startTime: '10:00', endTime: '19:00', overnight: false }
  const second = { startTime: '22:00', endTime: '06:00', overnight: true }
  const original = { '2026-11-16': first, '2026-11-17': second }
  assert.deepEqual(retainBatchOverrides(original, ['2026-11-17', '2026-11-18']), { '2026-11-17': second })
  assert.deepEqual(original, { '2026-11-16': first, '2026-11-17': second })
  assert.deepEqual(retainBatchOverrides(original, []), {})
})

test('time validation distinguishes daytime, overnight, missing and malformed values', () => {
  assert.equal(batchTimeError({ startTime: '09:00', endTime: '22:00', overnight: false }), null)
  assert.equal(batchTimeError({ startTime: '22:00', endTime: '06:00', overnight: true }), null)
  for (const [startTime, endTime] of [['22:00', '06:00'], ['09:00', '09:00'], ['', '18:00'], ['24:00', '18:00']]) assert(batchTimeError({ startTime, endTime, overnight: false }))
  assert.deepEqual([1, 2, 5, 11, 21, 22, 62].map(batchShiftLabel), ['1 смену', '2 смены', '5 смен', '11 смен', '21 смену', '22 смены', '62 смены'])
})
