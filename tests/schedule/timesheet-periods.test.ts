import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { prisma } from '../../src/server/db.ts';
import { createBusinessOrganization } from '../support/business-organization.ts';
import { locationContext } from '../../src/server/organizations/location-context.ts';
import { timesheetMutationContext } from '../../src/server/schedule/timesheets/mutation-context.ts';
import { readTimesheet, actOnTimesheet, readTimesheetVersion } from '../../src/server/schedule/timesheets/service.ts';
import { timesheetWorkbook } from '../../src/server/schedule/timesheets/workbook.ts';
import { timesheetDatabaseError } from '../../src/server/schedule/timesheets/errors.ts';
import { saveTimeCorrection } from '../../src/server/schedule/time/time-correction-service.ts';
import { monthBounds } from '../../src/server/schedule/timesheets/snapshot.ts';
const month = '2025-10';
async function fixture() {
  const user = await prisma.user.create({ data: { email: `tab-${randomUUID()}@example.test`, firstName: 'Владелец', passwordHash: 'synthetic' } });
  const org = await createBusinessOrganization(user.id, { name: 'Табель тест', description: null, timezone: 'Europe/Moscow' });
  const member = await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    data: {
      joinedAt: new Date('2020-01-01'),
      personnelFirstName: 'Иван',
      personnelLastName: 'Кадровый',
      personnelNumber: '0007'
    }
  });
  await prisma.locationMember.update({
    where: { locationId_memberId: { locationId: org.locationId, memberId: member.id } },
    data: { joinedAt: new Date('2020-01-01') }
  });
  const shift = await prisma.workShift.create({
    data: {
      organizationId: org.id,
      locationId: org.locationId,
      memberId: member.id,
      createdByMemberId: member.id,
      scheduledStartAt: new Date('2025-10-02T06:00:00Z'),
      scheduledEndAt: new Date('2025-10-02T15:00:00Z'),
      breakMinutes: 30,
      attendance: 'WORKED',
      actualStartAt: new Date('2025-10-02T06:00:00Z'),
      actualEndAt: new Date('2025-10-02T14:30:00Z'),
      actualBreakMinutes: 20
    }
  });
  const scope = <T>(work: () => T, reason = '') => timesheetMutationContext.run({ userId: user.id, reason }, () => locationContext.run({ organizationId: org.id, locationId: org.locationId }, work));
  const read = () => scope(() => readTimesheet(user.id, org.id, month));
  const act = async (action: 'CLOSE' | 'REOPEN' | 'CONFIRM', reason?: string, revision?: number) => {
    const data = await read();
    return scope(() => actOnTimesheet(user.id, org.id, month, { action, reason, revision: revision ?? data.period?.revision ?? 0, snapshotToken: data.snapshotToken }));
  };
  const close = () => act('CLOSE');
  return { user, org, member, shift, scope, read, act, close };
}
after(() => prisma.$disconnect());
describe('monthly timesheet reconciliation and direct closure', () => {
  it('closes and freezes personnel identity, actual hours, breaks and absences in a real workbook', async () => {
    const f = await fixture();
    await prisma.employeeAbsence.create({
      data: {
        organizationId: f.org.id,
        memberId: f.member.id,
        type: 'VACATION',
        startDate: new Date('2025-10-06'),
        endDate: new Date('2025-10-08'),
        comment: '=SUM(A1:A2)'
      }
    });
    await f.close();
    const current = await f.read();
    assert.equal(current.period?.status, 'CLOSED');
    assert.equal(current.period?.version, 1);
    assert.equal(current.snapshot.members[0].name, 'Кадровый Иван');
    assert.equal(current.snapshot.members[0].actualMinutes, 510);
    assert.equal(current.snapshot.members[0].vacationDays, 3);
    const record = await f.scope(() => readTimesheetVersion(f.user.id, f.org.id, month, 1));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(await timesheetWorkbook(record.snapshot, record)).buffer);
    assert.equal(workbook.worksheets.length, 5);
    assert.equal(workbook.getWorksheet('Сводка')!.getCell('A2').value, '0007');
    assert.equal(workbook.getWorksheet('Сводка')!.getCell('B2').value, 'Кадровый Иван');
    assert.equal(workbook.getWorksheet('Сводка')!.getCell('F2').value, 8.5);
    assert.equal(workbook.getWorksheet('Смены')!.getCell('L2').value, 20);
    assert.equal(workbook.getWorksheet('Параметры')!.getCell('A10').value, 'Зафиксировал');
    assert.equal(workbook.getWorksheet('Параметры')!.getCell('B10').value, 'Кадровый Иван');
    assert.equal(workbook.getWorksheet('Параметры')!.getCell('B11').value, f.member.id);
    assert(workbook.getWorksheet('Смены')!.getCell('E2').value instanceof Date);
    assert.equal(workbook.getWorksheet('Отсутствия')!.getCell('J2').value, '=SUM(A1:A2)');
    await prisma.organizationMember.update({ where: { id: f.member.id }, data: { personnelLastName: 'Изменённый' } });
    assert.equal((await f.read()).snapshot.members[0].name, 'Кадровый Иван');
  });
  it('blocks edits, cancellation, insertion and deletion through the database including indirect callers', async () => {
    const f = await fixture();
    await f.close();
    for (const work of [
      () => prisma.workShift.update({ where: { id: f.shift.id }, data: { actualEndAt: new Date('2025-10-02T15:00:00Z') } }),
      () => prisma.workShift.update({ where: { id: f.shift.id }, data: { status: 'CANCELLED' } }),
      () => prisma.workShift.delete({ where: { id: f.shift.id } }),
      () => prisma.workShift.create({
        data: {
          organizationId: f.org.id,
          locationId: f.org.locationId,
          memberId: f.member.id,
          createdByMemberId: f.member.id,
          scheduledStartAt: new Date('2025-10-31T21:00:00Z'),
          scheduledEndAt: new Date('2025-11-01T06:00:00Z')
        }
      }).then(async (shift) => {
        // A November shift can be created, but moving it into October is blocked.
        await prisma.workShift.update({ where: { id: shift.id }, data: { scheduledStartAt: new Date('2025-10-31T20:00:00Z') } });
      }),
    ])
      await assert.rejects(work(), error => timesheetDatabaseError(error)?.code === 'TIMESHEET_LOCKED');
    await prisma.workShift.update({ where: { id: f.shift.id }, data: { assignmentReadAt: new Date() } });
    assert.equal((await f.read()).changedSinceClose, false);
  });
  it('requires confirmed actual attendance, finished shifts and a completed calendar month', async () => {
    const f = await fixture();
    await prisma.workShift.update({
      where: { id: f.shift.id },
      data: { attendance: 'UNCONFIRMED', actualStartAt: null, actualEndAt: null, actualBreakMinutes: null }
    });
    await assert.rejects(f.act('CLOSE'), /Устраните замечания/);
    await f.act('CONFIRM');
    assert.equal((await f.read()).snapshot.members[0].actualMinutes, 540);
    await f.close();
    const future = '2099-01';
    const value = await f.scope(() => readTimesheet(f.user.id, f.org.id, future));
    assert(value.snapshot.issues.some(item => item.code === 'PERIOD_NOT_ENDED'));
  });
  it('preserves partial facts when mass-confirming the plan', async () => {
    const f = await fixture();
    await prisma.workShift.update({ where: { id: f.shift.id }, data: { attendance: 'UNCONFIRMED', actualEndAt: null } });
    await f.act('CONFIRM');
    assert((await f.read()).snapshot.issues.some(item => item.code === 'UNCONFIRMED'));
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: f.shift.id } })).actualEndAt, null);
  });
  it('reopens only with a reason, audits corrections, and retains both closed versions', async () => {
    const f = await fixture();
    await f.close();
    await assert.rejects(f.act('REOPEN'), /Укажите причину/);
    await f.act('REOPEN', 'Уточнение фактического ухода');
    await assert.rejects(prisma.workShift.update({ where: { id: f.shift.id }, data: { description: 'No author/reason' } }), error => timesheetDatabaseError(error)?.code === 'TIMESHEET_REASON_REQUIRED');
    await f.scope(() => saveTimeCorrection(f.user.id, f.org.id, f.shift.id, {
      mode: 'NO_SHOW',
      comment: 'Подтверждена неявка',
      expectedUpdatedAt: f.shift.updatedAt.toISOString()
    }));
    await f.close();
    const current = await f.read();
    assert.equal(current.period?.version, 2);
    assert.equal(current.snapshot.members[0].actualMinutes, 0);
    const old = await f.scope(() => readTimesheetVersion(f.user.id, f.org.id, month, 1));
    assert.equal(old.snapshot.members[0].actualMinutes, 510);
    const event = current.events.find(item => item.kind === 'CORRECTION')!;
    assert.equal(event.actorMemberId, f.member.id);
    assert(event.reason.includes('Подтверждена неявка'));
    assert(event.changes);
  });
  it('records late medical information without overwriting a closed report', async () => {
    const f = await fixture();
    await f.close();
    await f.scope(() => prisma.$transaction(tx => tx.employeeAbsence.create({
      data: {
        organizationId: f.org.id,
        memberId: f.member.id,
        type: 'SICK',
        startDate: new Date('2025-10-06'),
        endDate: new Date('2025-10-07'),
        updatedByMemberId: f.member.id
      }
    })), 'Больничный получен позднее');
    const current = await f.read();
    assert.equal(current.period?.status, 'CLOSED');
    assert.equal(current.snapshot.absences.length, 0);
    assert.equal(current.changedSinceClose, true);
    assert(current.events.some(item => item.kind === 'LATE_ABSENCE' && item.actorMemberId === f.member.id));
    await f.act('REOPEN', 'Учесть поздний больничный');
    await f.close();
    assert.equal((await f.read()).snapshot.members[0].sickDays, 2);
  });
  it('rejects a stale preview when a late absence arrives before fixation', async () => {
    const f = await fixture();
    const preview = await f.read();
    await f.scope(() => prisma.$transaction(tx => tx.employeeAbsence.create({
      data: {
        organizationId: f.org.id,
        memberId: f.member.id,
        type: 'SICK',
        startDate: new Date('2025-10-06'),
        endDate: new Date('2025-10-07'),
        updatedByMemberId: f.member.id
      }
    })), 'Поздний больничный');
    await assert.rejects(f.scope(() => actOnTimesheet(f.user.id, f.org.id, month, {
      action: 'CLOSE', revision: 0, snapshotToken: preview.snapshotToken,
    })), error => (error as { code: string }).code === 'TIMESHEET_DATA_CHANGED');
    assert.equal((await f.read()).period, null, 'Failed fixation must not leave a period or version behind');
    await f.close();
    assert.equal((await f.read()).snapshot.members[0].sickDays, 2);
  });
  it('does not silently fix changed hours and does not treat read acknowledgement as an accounting change', async () => {
    const f = await fixture();
    const preview = await f.read();
    await prisma.workShift.update({ where: { id: f.shift.id }, data: { actualEndAt: new Date('2025-10-02T15:00:00Z') } });
    await assert.rejects(f.scope(() => actOnTimesheet(f.user.id, f.org.id, month, {
      action: 'CLOSE', revision: 0, snapshotToken: preview.snapshotToken,
    })), error => (error as { code: string }).code === 'TIMESHEET_DATA_CHANGED');
    const refreshed = await f.read();
    await prisma.workShift.update({ where: { id: f.shift.id }, data: { assignmentReadAt: new Date() } });
    await f.scope(() => actOnTimesheet(f.user.id, f.org.id, month, {
      action: 'CLOSE', revision: 0, snapshotToken: refreshed.snapshotToken,
    }));
    assert.equal((await f.read()).snapshot.members[0].actualMinutes, 540);
  });
  it('rejects work conflicting with an absence and pending requests that affect the period', async () => {
    const f = await fixture();
    await prisma.employeeAbsence.create({
      data: {
        organizationId: f.org.id,
        memberId: f.member.id,
        type: 'SICK',
        startDate: new Date('2025-10-02'),
        endDate: new Date('2025-10-02')
      }
    });
    assert((await f.read()).snapshot.issues.some(item => item.code === 'ABSENCE_CONFLICT'));
    await assert.rejects(f.act('CLOSE'), /Устраните/);
  });
  it('blocks pending absence applications and ignores unrelated future applications', async () => {
    const f = await fixture();
    const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: f.org.id, systemCode: 'VACATION' } });
    const request = await prisma.organizationRequest.create({
      data: {
        organizationId: f.org.id,
        locationId: f.org.locationId,
        createdByMemberId: f.member.id,
        requestTypeId: type.id,
        typeNameSnapshot: 'Отпуск',
        systemCodeSnapshot: 'VACATION',
        startDate: new Date('2025-10-06'),
        endDate: new Date('2025-10-07')
      }
    });
    assert((await f.read()).snapshot.issues.some(item => item.code === 'PENDING_REQUEST' && item.requestId === request.id));
    await assert.rejects(f.act('CLOSE'), /Устраните/);
    await prisma.organizationRequest.update({
      where: { id: request.id },
      data: { startDate: new Date('2099-01-01'), endDate: new Date('2099-01-02') }
    });
    await f.close();
  });
  it('rejects a stale SERIALIZABLE writer that started before the period was created', async () => {
    const f = await fixture();
    let ready!: () => void, release!: () => void;
    const seen = new Promise<void>(resolve => { ready = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const writer = prisma.$transaction(async (tx) => {
      await tx.workShift.findUniqueOrThrow({ where: { id: f.shift.id } });
      ready();
      await resume;
      await tx.workShift.update({ where: { id: f.shift.id }, data: { description: 'Stale writer' } });
    }, { isolationLevel: 'Serializable', timeout: 15000 });
    const rejected = assert.rejects(writer);
    await seen;
    await f.close();
    release();
    await rejected;
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: f.shift.id } })).description, null);
  });
  it('enforces Business on mutations and keeps closed Excel readable after downgrade', async () => {
    const f = await fixture();
    await f.close();
    await prisma.organizationSubscription.update({ where: { organizationId: f.org.id }, data: { plan: 'TEAM', trialEndsAt: null } });
    await assert.rejects(f.read(), error => (error as { code: string }).code === 'SUBSCRIPTION_FEATURE_REQUIRED');
    await assert.rejects(f.act('REOPEN', 'Коррекция'), error => (error as {
      code: string;
    }).code === 'SUBSCRIPTION_FEATURE_REQUIRED');
    const record = await f.scope(() => readTimesheetVersion(f.user.id, f.org.id, month, 1));
    assert.equal(record.version, 1);
    const other = await fixture();
    await prisma.organizationSubscription.update({ where: { organizationId: other.org.id }, data: { plan: 'FREE', trialEndsAt: null } });
    await assert.rejects(other.read(), error => (error as {
      code: string;
    }).code === 'SUBSCRIPTION_FEATURE_REQUIRED');
  });
  it('rejects foreign organizations and scopes, revoked and incomplete permissions', async () => {
    const f = await fixture(), other = await fixture();
    await f.close();
    await assert.rejects(other.scope(() => readTimesheet(other.user.id, f.org.id, month)));
    await assert.rejects(locationContext.run({ organizationId: f.org.id, locationId: other.org.locationId }, () => readTimesheet(f.user.id, f.org.id, month)));
    const employee = await prisma.user.create({ data: { email: `denied-${randomUUID()}@example.test` } });
    const role = await prisma.accessRole.create({
      data: {
        organizationId: f.org.id,
        name: 'Без доступа к причинам',
        permissions: ['timesheets.view', 'reports.export']
      }
    });
    await prisma.organizationMember.create({ data: { organizationId: f.org.id, userId: employee.id, accessConfigured: true, accessRoleId: role.id } });
    await assert.rejects(f.scope(() => readTimesheet(employee.id, f.org.id, month)), /Недостаточно прав/);
  });
  it('does not fix two versions when two authorized users act concurrently', async () => {
    const f = await fixture();
    const revision = (await f.read()).period?.revision ?? 0;
    const results = await Promise.allSettled([f.act('CLOSE', undefined, revision), f.act('CLOSE', undefined, revision)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(await prisma.timesheetVersion.count({ where: { periodId: (await f.read()).period!.id } }), 1);
  });
  it('lets an accountant fix and reopen directly with existing export rights, without a reviewer or fact-edit permission', async () => {
    const f = await fixture();
    const user = await prisma.user.create({ data: { email: `accountant-${randomUUID()}@example.test`, firstName: 'Бухгалтер' } });
    const role = await prisma.accessRole.create({
      data: {
        organizationId: f.org.id,
        name: 'Бухгалтер',
        permissions: ['members.view', 'members.personnel.view', 'absences.view', 'absences.details',
          'timesheets.view', 'reports.preview', 'reports.export']
      }
    });
    const accountant = await prisma.organizationMember.create({ data: { organizationId: f.org.id, userId: user.id, accessConfigured: true, accessRoleId: role.id } });
    const preview = await f.scope(() => readTimesheet(user.id, f.org.id, month));
    assert.equal(preview.capabilities.close, true);
    assert.equal(preview.capabilities.actual, false);
    await assert.rejects(f.scope(() => actOnTimesheet(user.id, f.org.id, month, {
      action: 'CONFIRM', revision: 0,
    })), /Недостаточно прав/);
    await f.scope(() => actOnTimesheet(user.id, f.org.id, month, {
      action: 'CLOSE', revision: 0, snapshotToken: preview.snapshotToken,
    }));
    const closed = await f.read();
    assert.equal(closed.period?.status, 'CLOSED');
    assert.equal(closed.snapshot.closure?.memberId, accountant.id);
    assert.equal(closed.events.filter(event => event.kind === 'CLOSE').length, 1);
    assert.equal(closed.events.some(event => event.kind === 'SUBMIT'), false);
    assert.equal(await prisma.accountNotification.count({ where: { timesheetPeriodId: closed.period!.id } }), 0);
    await f.scope(() => actOnTimesheet(user.id, f.org.id, month, {
      action: 'REOPEN', revision: closed.period!.revision, reason: 'Уточнить сведения бухгалтерии',
    }));
    assert.equal((await f.read()).period?.status, 'OPEN');
    await prisma.accessRole.update({ where: { id: role.id }, data: { permissions: role.permissions.filter(key => key !== 'reports.export') } });
    const readOnly = await f.scope(() => readTimesheet(user.id, f.org.id, month));
    assert.equal(readOnly.capabilities.close, false);
    await assert.rejects(f.scope(() => actOnTimesheet(user.id, f.org.id, month, {
      action: 'CLOSE', revision: readOnly.period!.revision, snapshotToken: readOnly.snapshotToken,
    })), /Недостаточно прав/);
    await assert.rejects(f.scope(() => readTimesheetVersion(user.id, f.org.id, month, 1)), /Недостаточно прав/);
  });
  it('blocks overlapping actual hours across different points', async () => {
    const f = await fixture();
    const point = await prisma.organizationLocation.create({ data: { organizationId: f.org.id, name: 'Вторая', city: '', address: '', timezone: 'Europe/Moscow' } });
    await prisma.workShift.create({
      data: {
        organizationId: f.org.id,
        locationId: point.id,
        memberId: f.member.id,
        createdByMemberId: f.member.id,
        scheduledStartAt: new Date('2025-10-02T16:00:00Z'),
        scheduledEndAt: new Date('2025-10-02T18:00:00Z'),
        actualStartAt: new Date('2025-10-02T14:00:00Z'),
        actualEndAt: new Date('2025-10-02T17:00:00Z'),
        attendance: 'WORKED'
      }
    });
    assert((await f.read()).snapshot.issues.some(issue => issue.code === 'ACTUAL_OVERLAP'));
    await assert.rejects(f.act('CLOSE'), /Устраните/);
  });
  it('purges closed history only for an explicitly requested due organization deletion', async () => {
    const f = await fixture(); await f.close();
    await assert.rejects(prisma.$executeRaw`SELECT public.staffly_purge_deleted_timesheets(${f.org.id}::uuid)`);
    const { runDataRetention } = await import('../../src/server/privacy/maintenance.ts');
    await prisma.organization.update({ where: { id: f.org.id }, data: { deletedAt: new Date() } });
    await prisma.dataDeletion.create({ data: { kind: 'ORGANIZATION', subjectId: f.org.id, requestedAt: new Date(Date.now() - 31 * 86400000), dueAt: new Date(Date.now() - 1000) } });
    const result = await runDataRetention({ enabled: true, removeObject: async () => { } });
    assert.equal(result.failed, 0);
    assert.equal(await prisma.organization.count({ where: { id: f.org.id } }), 0);
  });
  it('uses local month boundaries including DST and cross-month overnight shifts', () => {
    assert.equal(monthBounds('2025-10', 'Europe/Moscow').end.toISOString(), '2025-10-31T21:00:00.000Z');
    assert.equal(monthBounds('2025-03', 'Europe/Berlin').start.toISOString(), '2025-02-28T23:00:00.000Z');
    assert.equal(monthBounds('2025-03', 'Europe/Berlin').end.toISOString(), '2025-03-31T22:00:00.000Z');
  });
});
