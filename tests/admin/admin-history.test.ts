import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DAY, fillHistory, historyPosition, historySegments } from '../../src/shared/monitoring-history.ts'
import { retentionCells } from '../../src/server/admin/history.ts'
import { effectiveBackupState } from '../../src/shared/admin-backup.ts'

test('history uses elapsed time, keeps unknown buckets and breaks paths across missing or incomplete observations', () => {
  const range = { from: '2026-11-07T10:00:00Z', to: '2026-11-07T15:00:00Z', stepMs: 300000 }
  assert.equal(historyPosition(Date.parse('2026-11-07T10:05:00Z'), range), 1 / 60)
  const rows = [{ at: range.from, users: 2 }, { at: '2026-11-07T10:05:00Z', users: 3 }, { at: range.to, users: 4 }]
  assert.deepEqual(historySegments(rows, 'users', range.stepMs), [[0, 1], [2]])
  const filled = fillHistory(rows, ['users'], range)
  assert.equal(filled.length, 61); assert.equal(filled[2].users, null); assert.equal(filled[60].users, 4)
  assert.deepEqual(historySegments([{ at: range.from, users: 1 }, { at: '2026-11-07T10:05:00Z', users: 2, incomplete: true }, { at: '2026-11-07T10:10:00Z', users: 3 }], 'users', 300000), [[0], [1], [2]])
})
test('retention separates a confirmed zero, missing collection, current week and future weeks', () => {
  const cohort = '2026-09-28', first = Date.parse(cohort + 'T00:00:00+03:00')
  const coverage = new Map(Array.from({ length: 14 }, (_, day) => [new Date(first + day * DAY + 10800000).toISOString().slice(0, 10), 288]))
  for(let day=28;day<=31;day++)coverage.set(new Date(first+day*DAY+10800000).toISOString().slice(0,10),day===31?1:288)
  const cells = retentionCells([{ cohort, week: 0, organizations: 2, total: 2 }, { cohort, week: 3, organizations: 1, total: 2 }], coverage, first + 31 * DAY)
  assert.equal(cells[0].organizations, 2); assert.equal(cells[1].organizations, 0); assert.equal(cells[1].state, 'complete')
  assert.equal(cells[2].organizations, null); assert.equal(cells[2].state, 'unknown')
  assert.equal(cells[3].organizations, null); assert.equal(cells[3].observed, 1)
  assert.equal(cells[4].state, 'partial'); assert.equal(cells[5].state, 'future')
})
test('an expired archive has one consistent effective state regardless of file integrity', () => {
  assert.equal(effectiveBackupState('AVAILABLE', '2026-10-01T00:00:00Z', Date.parse('2026-11-07T00:00:00Z')), 'EXPIRED')
  assert.equal(effectiveBackupState('AVAILABLE', '2026-12-01T00:00:00Z', Date.parse('2026-11-07T00:00:00Z')), 'AVAILABLE')
})
