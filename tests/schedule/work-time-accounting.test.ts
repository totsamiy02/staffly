import assert from 'node:assert/strict';
import { it } from 'node:test';
import { calculateWorkTime, intervalMinutes, workTimeRules } from '../../src/shared/work-time.ts';
import { resolveTimeCorrection } from '../../src/app/schedule/time/time-correction.ts';
import { zonedDateTimeToUtc } from '../../src/server/schedule/timezone.ts';
const now = Date.parse('2026-11-15T12:00:00Z');
const shift = {
  scheduledStartAt: '2026-10-27T06:00:00Z', scheduledEndAt: '2026-10-27T15:00:00Z',
  actualStartAt: null, actualEndAt: null, actualBreakMinutes: null, breakMinutes: 30,
  attendance: 'UNCONFIRMED' as const, status: 'SCHEDULED' as const,
};
it('keeps the plan and estimate without inventing confirmed work, including legacy complete unconfirmed ranges', () => {
  const unknown = calculateWorkTime(shift, now);
  assert.equal(unknown.plannedMinutes, 540);
  assert.equal(unknown.estimatedMinutes, 540);
  assert.equal(unknown.confirmedMinutes, null);
  assert.equal(unknown.pending, true);
  const legacy = calculateWorkTime({ ...shift, actualStartAt: shift.scheduledStartAt, actualEndAt: shift.scheduledEndAt }, now);
  assert.equal(legacy.confirmedMinutes, null);
  assert.equal(legacy.state, 'UNCONFIRMED');
  assert.equal(legacy.source, 'UNCONFIRMED_MARKS');
});
it('one mark remains provisional; both past marks produce confirmed work only through an explicit action', () => {
  const arrival = resolveTimeCorrection(shift, { mode: 'MARKS', startAt: '2026-10-27T06:30:00Z' }, now);
  assert.equal(arrival.attendance, 'UNCONFIRMED');
  assert.equal(arrival.accounting.confirmedMinutes, null);
  assert.equal(arrival.accounting.estimatedMinutes, 510);
  const full = resolveTimeCorrection({ ...shift, ...arrival }, { mode: 'MARKS', startAt: arrival.actualStartAt, endAt: '2026-10-27T14:30:00Z' }, now);
  assert.equal(full.accounting.confirmedMinutes, 480);
  assert.equal(full.accounting.estimatedMinutes, 480);
  assert.equal(full.accounting.plannedMinutes, 540);
});
it('distinguishes no-show zero, missing fact, future, active and cancelled shifts', () => {
  assert.equal(calculateWorkTime({ ...shift, attendance: 'NO_SHOW' }, now).confirmedMinutes, 0);
  assert.equal(calculateWorkTime({ ...shift, status: 'CANCELLED' }, now).estimatedMinutes, 0);
  const future = { ...shift, scheduledStartAt: '2099-01-01T06:00:00Z', scheduledEndAt: '2099-01-01T15:00:00Z' };
  assert.equal(calculateWorkTime(future, now).state, 'FUTURE');
  assert.equal(calculateWorkTime(future, now).pending, false);
  assert.equal(calculateWorkTime(shift, Date.parse('2026-10-27T10:00:00Z')).state, 'IN_PROGRESS');
  assert.throws(() => resolveTimeCorrection(future, { mode: 'CONFIRM' }, now));
});
it('plan confirmation is explicit, includes breaks, and never overwrites an existing mark', () => {
  const result = resolveTimeCorrection(shift, { mode: 'CONFIRM' }, now);
  assert.equal(result.accounting.confirmedMinutes, 540);
  assert.equal(result.actualBreakMinutes, 30);
  assert.equal(workTimeRules.breaks, 'INCLUDED');
  assert.throws(() => resolveTimeCorrection({ ...shift, actualStartAt: shift.scheduledStartAt }, { mode: 'CONFIRM' }, now));
  const restored = resolveTimeCorrection({ ...shift, ...result }, { mode: 'RESTORE' }, now);
  assert.equal(restored.accounting.confirmedMinutes, null);
  assert.equal(restored.accounting.estimatedMinutes, 540);
});
it('uses elapsed minutes across DST, keeps overnight boundaries, and sums minutes before converting to hours', () => {
  for (const [day, expected] of [['2026-03-08', 420], ['2026-11-01', 540]] as const) {
    assert.equal(intervalMinutes(zonedDateTimeToUtc(day, '00:00', 'America/New_York'), zonedDateTimeToUtc(day, '08:00', 'America/New_York')), expected);
  }
  assert.equal(intervalMinutes('2026-10-31T19:00Z', '2026-11-01T03:00Z'), 480);
  const total = Array.from({ length: 60 }, () => intervalMinutes('2026-01-01T00:00Z', '2026-01-01T00:01Z')).reduce((sum, value) => sum + value, 0);
  assert.equal(total / 60, 1);
});
