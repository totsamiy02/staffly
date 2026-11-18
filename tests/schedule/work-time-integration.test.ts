import { checkMonthlyWorkload } from '../../src/server/schedule/workload.ts';
import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/server/db.ts';
import { createBusinessOrganization } from '../support/business-organization.ts';
import { locationContext } from '../../src/server/organizations/location-context.ts';
import { memberStatistics, organizationStatistics } from '../../src/server/schedule/time/statistics.ts';
import { statisticsQuery } from '../../src/server/schedule/schemas.ts';
import { buildReport } from '../../src/server/schedule/reports/report-service.ts';
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts';
import { readTimesheet, actOnTimesheet, readTimesheetVersion } from '../../src/server/schedule/timesheets/service.ts';
import { saveTimeCorrection } from '../../src/server/schedule/time/time-correction-service.ts';

after(() => prisma.$disconnect());
const month = '2025-10';
const options = { from: '2025-10-01', to: '2025-11-01', memberState: 'all', sort: 'name', direction: 'asc', page: 1, limit: 50 } as const;

it('statistics search covers all pages, treats SQL wildcard characters literally and retains point and permission boundaries', async () => {
  const f = await fixture();
  const users = await prisma.user.createManyAndReturn({
    data: Array.from({ length: 26 }, (_, index) => ({
      email: `search-${index}-${randomUUID()}@example.test`,
      firstName: `Тестовый ${String(index).padStart(2, '0')}`,
    })),
  });
  const members = await prisma.organizationMember.createManyAndReturn({
    data: users.map(user => ({ organizationId: f.org.id, userId: user.id })),
  });
  await prisma.locationMember.createMany({
    data: members.map(member => ({ organizationId: f.org.id, locationId: f.org.locationId, memberId: member.id })),
  });
  const read = (search: string, page = 1) => f.scope(() => organizationStatistics(f.user.id, f.org.id, {
    ...options, search, page, limit: 25,
  }));
  const first = await read('ТЕСТОВЫЙ');
  assert.equal(first.pagination.total, 26);
  assert.equal(first.pagination.pages, 2);
  assert.equal(first.members.length, 25);
  const second = await read('тестовый', 2);
  assert.equal(second.members.length, 1);
  assert(!first.members.some(member => member.memberId === second.members[0].memberId));
  const byMail = await read(users[25].email);
  assert.equal(byMail.pagination.total, 1);
  assert.equal(byMail.members[0].userId, users[25].id);
  await prisma.user.updateMany({ where: { id: { in: users.map(user => user.id) } }, data: { firstName: 'Одинаковый' } });
  const stableIds = members.map(member => member.id).sort((left, right) => left.localeCompare(right));
  assert.deepEqual((await read('Одинаковый')).members.map(member => member.memberId), stableIds.slice(0, 25));
  assert.deepEqual((await read('Одинаковый', 2)).members.map(member => member.memberId), stableIds.slice(25));
  await prisma.user.update({ where: { id: users[0].id }, data: { firstName: 'Литерал %_ тест' } });
  const literal = await read('%_');
  assert.equal(literal.pagination.total, 1);
  assert.equal(literal.members[0].userId, users[0].id);
  assert.equal((await read('несуществующий сотрудник')).pagination.total, 0);
  const removed = members.find(member => member.userId === users[1].id)!;
  await prisma.locationMember.delete({ where: { locationId_memberId: { locationId: f.org.locationId, memberId: removed.id } } });
  assert.equal((await read(users[1].email)).pagination.total, 0);
  const stranger = await prisma.user.create({ data: { email: `outside-${randomUUID()}@example.test` } });
  await assert.rejects(
    f.scope(() => organizationStatistics(stranger.id, f.org.id, { ...options, search: users[0].email })),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ORGANIZATION_NOT_FOUND'),
  );
  assert(!statisticsQuery.safeParse({ search: 'x'.repeat(201) }).success);
});
async function fixture() {
  const user = await prisma.user.create({ data: { email: `accounting-${randomUUID()}@example.test` } });
  const org = await createBusinessOrganization(user.id, { name: 'Единый учёт', timezone: 'Europe/Moscow', description: null });
  const member = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: user.id } } });
  await prisma.locationMember.update({ where: { locationId_memberId: { locationId: org.locationId, memberId: member.id } }, data: { joinedAt: new Date('2020-01-01') } });
  const scope = <T>(work: () => T) => locationContext.run({ organizationId: org.id, locationId: org.locationId }, work);
  const createShift = (day: string, patch = {}) => prisma.workShift.create({ data: {
    organizationId: org.id, locationId: org.locationId, memberId: member.id, createdByMemberId: member.id,
    scheduledStartAt: new Date(`${day}T06:00Z`), scheduledEndAt: new Date(`${day}T15:00Z`), breakMinutes: 30, ...patch,
  } });
  const stats = () => scope(() => memberStatistics(user.id, org.id, member.id, options));
  const report = () => buildReport(user.id, org.id, { from: options.from, to: '2025-10-31', locationIds: [org.locationId], memberIds: [member.id], includeFormer: false, config: defaultReportConfig() });
  const timesheet = () => scope(() => readTimesheet(user.id, org.id, month));
  return { user, org, member, scope, createShift, stats, report, timesheet };
}
it('statistics, previews, Excel data and timesheet share facts, missing marks and no-show zero', async () => {
  const f = await fixture();
  await f.createShift('2025-10-25', { attendance: 'WORKED', actualStartAt: new Date('2025-10-25T06:30Z'), actualEndAt: new Date('2025-10-25T15:00Z'), actualBreakMinutes: 30 });
  const pending = await f.createShift('2025-10-26');
  await f.createShift('2025-10-27', { attendance: 'NO_SHOW' });
  await f.createShift('2025-10-28', { status: 'CANCELLED', cancelledAt: new Date(), cancelledByMemberId: f.member.id, cancellationReason: 'Отмена тестовой смены' });
  let stats = await f.stats();
  assert.equal(stats.period?.plannedMinutes, 1620);
  assert.equal(stats.period?.estimatedMinutes, 1050);
  assert.equal(stats.period?.workedMinutes, 510);
  assert.equal(stats.period?.confirmedShifts, 2);
  assert.equal(stats.period?.pendingShifts, 1);
  assert.equal(stats.history.find(row => row.id === pending.id)?.actualMinutes, null);
  let report = await f.report();
  assert.equal(report.metrics.plannedHours, 27);
  assert.equal(report.metrics.hours, 17.5);
  assert.equal(report.metrics.confirmedHours, 8.5);
  assert.equal(report.rows.shifts.find(row => row.id === pending.id)?.confirmedHours, null);
  let tab = await f.timesheet();
  assert.equal(tab.snapshot.members[0].actualMinutes, 510);
  assert.equal(tab.snapshot.members[0].unconfirmedShifts, 1);
  assert.equal(tab.snapshot.calculationRules?.breaks, 'INCLUDED');
  await assert.rejects(f.scope(() => actOnTimesheet(f.user.id, f.org.id, month, { action: 'CLOSE', revision: 0, snapshotToken: tab.snapshotToken })), /Устраните/);
  let changed = await f.scope(() => saveTimeCorrection(f.user.id, f.org.id, pending.id, { mode: 'MARKS', startAt: '2025-10-26T06:30:00Z', expectedUpdatedAt: pending.updatedAt.toISOString() }));
  assert.equal(changed.accounting.confirmedMinutes, null);
  assert.equal((await f.stats()).period?.workedMinutes, 510);
  changed = await f.scope(() => saveTimeCorrection(f.user.id, f.org.id, pending.id, { mode: 'MARKS', startAt: '2025-10-26T06:30:00Z', endAt: '2025-10-26T14:30:00Z', expectedUpdatedAt: changed.updatedAt.toISOString() }));
  assert.equal(changed.accounting.confirmedMinutes, 480);
  stats = await f.stats(); report = await f.report(); tab = await f.timesheet();
  assert.equal(stats.period?.workedMinutes, 990);
  assert.equal(report.metrics.confirmedHours, 16.5);
  assert.equal(tab.snapshot.members[0].actualMinutes, 990);
  assert.equal(stats.period?.pendingShifts, 0);
  await f.scope(() => actOnTimesheet(f.user.id, f.org.id, month, { action: 'CLOSE', revision: 0, snapshotToken: tab.snapshotToken }));
  const closed = await f.scope(() => readTimesheetVersion(f.user.id, f.org.id, month, 1));
  assert.equal(closed.snapshot.calculationRules?.version, 'minutes-v2');
  assert.equal(closed.snapshot.members[0].actualMinutes, 990);
});
it('all-point statistics use each point local month and preserve row timezone across midnight', async () => {
  const f = await fixture();
  const east = await prisma.organizationLocation.create({ data: { organizationId: f.org.id, name: 'Восток', city: '', address: '', timezone: 'Asia/Vladivostok' } });
  const base = { organizationId: f.org.id, locationId: east.id, memberId: f.member.id, createdByMemberId: f.member.id };
  const included = await prisma.workShift.create({ data: { ...base, scheduledStartAt: new Date('2025-09-30T16:00Z'), scheduledEndAt: new Date('2025-09-30T17:00Z') } });
  const excluded = await prisma.workShift.create({ data: { ...base, scheduledStartAt: new Date('2025-10-31T20:00Z'), scheduledEndAt: new Date('2025-11-01T01:00Z') } });
  const data = await memberStatistics(f.user.id, f.org.id, f.member.id, options);
  assert.equal(data.period?.plannedMinutes, 60);
  assert(data.history.some(row => row.id === included.id && row.timezone === east.timezone));
  assert.equal(data.history.some(row => row.id === excluded.id), false);
  await prisma.organizationLocation.update({ where: { id: f.org.locationId }, data: { monthlyWorkMinutes: 90 } });
  await assert.rejects(f.scope(() => prisma.$transaction(tx => checkMonthlyWorkload(tx, f.org.id, f.member.id, 'Europe/Moscow', 90, [{ start: new Date('2025-10-01T06:00Z'), end: new Date('2025-10-01T07:00Z') }]))), error => (error as { code: string }).code === 'WORKLOAD_WARNING');
});
it('aggregates an all-time history beyond one batch without losing minutes or confirmations', async () => {
  const f = await fixture();
  const first = Date.parse('2025-10-01T00:00:00Z');
  await prisma.workShift.createMany({ data: Array.from({ length: 5001 }, (_, index) => {
    const start = new Date(first + index * 120000);
    const end = new Date(+start + 60000);
    return {
      organizationId: f.org.id, locationId: f.org.locationId, memberId: f.member.id, createdByMemberId: f.member.id,
      scheduledStartAt: start, scheduledEndAt: end, actualStartAt: start, actualEndAt: end, attendance: 'WORKED' as const,
    };
  }) });
  const data = await f.stats();
  assert.equal(data.period?.plannedMinutes, 5001);
  assert.equal(data.period?.workedMinutes, 5001);
  assert.equal(data.period?.estimatedMinutes, 5001);
  assert.equal(data.allTime?.confirmedShifts, 5001);
  assert.equal(data.pagination.total, 5001);
});
