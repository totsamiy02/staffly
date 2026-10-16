import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../src/server/db.ts'
import { createOrganization } from '../src/server/organizations/organization-service.ts'
import { locationContext } from '../src/server/organizations/location-context.ts'
import { buildReport, previewReport, reportWorkbook, reportOptions, reportMembers, saveReportTemplate, deleteReportTemplate, updatePersonnelNumber } from '../src/server/schedule/report-service.ts'
import { reportBody, reportConfigSchema, templateBody, personnelBody } from '../src/server/schedule/report-schemas.ts'
import { defaultReportConfig, type ReportInput } from '../src/app/schedule/reporting.ts'
import { startOfZonedDate, zonedDateTimeToUtc } from '../src/server/schedule/timezone.ts'

const people: Record<string, { id: string; memberId: string }> = {}
let orgId: string, foreignOrgId: string, point1: string, point2: string, closed: string, foreignPoint: string
const now = new Date('2026-10-15T12:00:00Z'), old = new Date('2026-01-01')
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected
const input = (patch: Partial<ReportInput> = {}): ReportInput => reportBody.parse({ from: '2026-10-01', to: '2026-10-31', locationIds: [point1, point2], memberIds: [people.anna.memberId, people.ivan.memberId], includeFormer: false, config: defaultReportConfig(), ...patch })
async function shift(who: string, locationId: string, day: string, start = '09:00', end = '17:00', endDay = day, patch: Record<string, unknown> = {}) {
  const timezone = locationId === point2 ? 'Asia/Vladivostok' : 'Europe/Moscow'
  return prisma.workShift.create({ data: { organizationId: orgId, locationId, memberId: people[who].memberId, createdByMemberId: people.owner.memberId, scheduledStartAt: zonedDateTimeToUtc(day, start, timezone), scheduledEndAt: zonedDateTimeToUtc(endDay, end, timezone), breakMinutes: 30, positionNameSnapshot: 'Бариста (снимок)', ...patch } })
}
before(async () => {
  for (const who of ['owner', 'admin', 'anna', 'ivan', 'former', 'other', 'transfer', 'foreign']) {
    const user = await prisma.user.create({ data: { email: `reports-${who}-${randomUUID()}@example.test`, passwordHash: 'test-only', firstName: who === 'anna' ? 'Анна' : who === 'ivan' ? 'Иван' : who, lastName: who === 'anna' ? 'Смирнова' : 'Петров', middleName: who === 'anna' ? 'Сергеевна' : 'Андреевич', emailVerifiedAt: old } })
    people[who] = { id: user.id, memberId: '' }
  }
  const org = await createOrganization(people.owner.id, { name: 'Accounting reports', timezone: 'Europe/Moscow', description: null, firstLocation: { name: 'Центр', city: 'Москва', address: 'Тест', timezone: 'Europe/Moscow' }, locations: [{ name: 'Парк', city: 'Владивосток', address: 'Тест', timezone: 'Asia/Vladivostok' }, { name: 'Архив', city: 'Москва', address: 'Тест', timezone: 'Europe/Moscow' }] })
  orgId = org.id; [point1, point2, closed] = org.locations.map(point => point.id)
  people.owner.memberId = (await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId: people.owner.id } } })).id
  for (const who of ['admin', 'anna', 'ivan', 'former', 'other', 'transfer']) {
    const member = await prisma.organizationMember.create({ data: { organizationId: orgId, userId: people[who].id, role: who === 'admin' ? 'ADMIN' : 'MEMBER', joinedAt: old, personnelNumber: who === 'anna' ? '0041' : who === 'ivan' ? '0042' : null, leftAt: who === 'former' ? new Date('2026-10-09') : null } }); people[who].memberId = member.id
    const ids = who === 'anna' ? [point1, point2] : who === 'other' ? [point2] : [point1]
    await prisma.locationMember.createMany({ data: ids.map(locationId => ({ organizationId: orgId, locationId, memberId: member.id, role: who === 'admin' ? 'ADMIN' : 'MEMBER', joinedAt: old, leftAt: who === 'former' ? new Date('2026-10-09') : who === 'transfer' ? new Date('2026-10-15') : null })) })
  }
  await prisma.organizationLocation.update({ where: { id: closed }, data: { archivedAt: new Date('2026-09-01') } })
  const foreign = await createOrganization(people.foreign.id, { name: 'Foreign reports', timezone: 'Europe/Moscow', description: null }); foreignOrgId = foreign.id; foreignPoint = foreign.locationId
  await shift('anna', point1, '2026-10-01', '09:00', '17:00', '2026-10-01', { actualStartAt: new Date('2026-10-01T07:00:00Z'), actualEndAt: new Date('2026-10-01T12:00:00Z'), actualBreakMinutes: 120 })
  await shift('anna', point2, '2026-10-20')
  await shift('ivan', point1, '2026-10-05', '09:00', '16:30')
  await shift('ivan', point1, '2026-10-31', '22:00', '06:00', '2026-11-01')
  await shift('ivan', point1, '2026-10-07', '09:00', '17:00', '2026-10-07', { status: 'CANCELLED', cancelledAt: now, cancelledByMemberId: people.owner.memberId, cancellationReason: 'Тест' })
  await shift('former', point1, '2026-10-03')
  await shift('other', point2, '2026-10-10')
  await prisma.employeeAbsence.createMany({ data: [
    { organizationId: orgId, memberId: people.anna.memberId, type: 'VACATION', startDate: new Date('2026-09-29'), endDate: new Date('2026-10-03'), comment: '=HYPERLINK("https://example.test")' },
    { organizationId: orgId, memberId: people.ivan.memberId, type: 'DAY_OFF', startDate: new Date('2026-10-11'), endDate: new Date('2026-10-11') },
    { organizationId: orgId, memberId: people.ivan.memberId, type: 'SICK', startDate: new Date('2026-10-12'), endDate: new Date('2026-10-12'), cancelledAt: now },
    { organizationId: orgId, memberId: people.other.memberId, type: 'VACATION', startDate: new Date('2026-10-02'), endDate: new Date('2026-10-03') },
    { organizationId: orgId, memberId: people.transfer.memberId, type: 'DAY_OFF', startDate: new Date('2026-10-25'), endDate: new Date('2026-10-25') },
  ] })
  await prisma.locationMember.create({ data: { organizationId: orgId, memberId: people.transfer.memberId, locationId: point2, joinedAt: new Date('2026-10-15') } })
})
after(async () => {
  if (orgId) {
    await prisma.employeeAbsence.deleteMany({ where: { organizationId: orgId } })
    await prisma.workShift.deleteMany({ where: { organizationId: orgId } })
  }
  await prisma.documentFolder.deleteMany({ where: { organizationId: { in: [orgId, foreignOrgId].filter(Boolean) } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, foreignOrgId].filter(Boolean) } } })
  await prisma.user.deleteMany({ where: { id: { in: Object.values(people).map(person => person.id) } } }); await prisma.$disconnect()
})
describe('accounting export rules and security', { concurrency: false }, () => {
  it('matches the reference: four shifts, 1710 minutes, actual time and paid breaks', async () => {
    const report = await buildReport(people.owner.id, orgId, input(), now)
    assert.deepEqual(report.metrics, { employees: 2, shifts: 4, minutes: 1710, hours: 28.5, futureShifts: 2, futureHours: 16 })
    assert.deepEqual(report.rows.summary.filter(row => row.memberId === people.anna.memberId).map(row => row.hours).sort((a,b)=>Number(a)-Number(b)), [5, 8])
    assert.equal(report.rows.summary.filter(row => row.memberId === people.anna.memberId).length, 2)
    assert.equal(report.rows.summary.find(row => row.memberId === people.ivan.memberId)?.hours, 15.5)
    assert.equal(report.rows.absences.length, 2); assert.equal(report.rows.absences.find(row => row.memberId === people.anna.memberId)?.days, 3); assert.equal(report.rows.absences.find(row => row.memberId === people.ivan.memberId)?.days, 1)
    assert.equal(report.rows.absences.find(row => row.memberId === people.ivan.memberId)?.type, 'Отгул')
    assert.ok(report.rows.shifts.some(row=>row.memberId===people.anna.memberId&&row.minutes===300&&row.position==='Бариста (снимок)'))
  })
  it('includes night shifts only in their start month and uses each location timezone', async () => {
    const october = await buildReport(people.owner.id, orgId, input(), now)
    assert.equal(october.rows.shifts.at(-1)?.end instanceof Date, true)
    const november = await buildReport(people.owner.id, orgId, input({ from: '2026-11-01', to: '2026-11-30' }), now)
    assert.equal(november.metrics.shifts, 0)
    const edge = await shift('other', point2, '2026-10-01', '00:00', '00:01', '2026-10-01', { breakMinutes: 0 })
    try { const report = await buildReport(people.owner.id, orgId, input({ memberIds: [people.other.memberId], from: '2026-10-01', to: '2026-10-01' }), now); assert.equal(report.metrics.minutes, 1); assert.equal(report.rows.shifts[0].start?.toString(), new Date('2026-10-01T00:00:00Z').toString()) } finally { await prisma.workShift.delete({ where: { id: edge.id } }) }
  })
  it('rejects members, foreign organizations/locations, inaccessible employees and mixed scopes', async () => {
    await assert.rejects(buildReport(people.anna.id, orgId, input()), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(reportOptions(people.anna.id, orgId), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(reportMembers(people.anna.id, orgId, input()), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(buildReport(people.foreign.id, orgId, input()), code('ORGANIZATION_NOT_FOUND'))
    for (const locationIds of [[point1, point2], [closed], [foreignPoint]]) await assert.rejects(buildReport(people.admin.id, orgId, input({ locationIds })), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(buildReport(people.admin.id, orgId, input({ locationIds: [point1], memberIds: [people.other.memberId] })), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(buildReport(people.owner.id, orgId, input({ memberIds: [randomUUID()] })), code('INSUFFICIENT_PERMISSIONS'))
    assert.ok((await reportOptions(people.owner.id, orgId)).locations.some(point => point.id === closed))
  })
  it('uses all managed locations independently from the selected sidebar context', async () => {
    const report = await locationContext.run({ organizationId: orgId, locationId: point2 }, () => buildReport(people.admin.id, orgId, input({ locationIds: [], memberIds: [] }), now))
    assert.ok(report.rows.shifts.every(row => row.location === 'Центр'))
    assert.ok(report.rows.absences.every(row => row.memberId !== people.other.memberId))
    assert.ok(report.rows.absences.every(row => row.memberId !== people.transfer.memberId))
    const choices = await reportMembers(people.admin.id, orgId, input({ locationIds: [], memberIds: [] }))
    assert.ok(!choices.members.some(member => member.id === people.other.memberId))
  })
  it('deduplicates employees and includes former memberships only when explicitly enabled', async () => {
    const active = await buildReport(people.owner.id, orgId, input({ memberIds: [] }), now)
    assert.ok(!active.rows.summary.some(row => row.memberId === people.former.memberId))
    const all = await buildReport(people.owner.id, orgId, input({ memberIds: [], includeFormer: true }), now)
    assert.equal(all.rows.summary.filter(row => row.memberId === people.anna.memberId).length, 2)
    assert.equal(all.rows.summary.find(row => row.memberId === people.former.memberId)?.status, 'Бывший')
    assert.ok(all.warnings.missingNumber.some(row => row.id === people.former.memberId))
  })
  it('covers temporary transfers and historical absence scope without inventing absence locations', async () => {
    const transfer = await prisma.locationTransfer.create({ data: { organizationId: orgId, memberId: people.other.memberId, createdByMemberId: people.owner.memberId, fromLocationId: point2, toLocationId: point1, temporary: true, startAt: new Date('2026-10-02'), endAt: new Date('2026-10-04') } })
    try { const report = await buildReport(people.admin.id, orgId, input({ locationIds: [point1], memberIds: [people.other.memberId] }), now); assert.equal(report.rows.absences.length, 1); assert.equal(report.metrics.shifts, 0); assert.equal(report.rows.absences[0].location, undefined) } finally { await prisma.locationTransfer.delete({ where: { id: transfer.id } }) }
  })
  it('exports an approved absence once through its registered record, with no extra request row', async () => {
    const absence = await prisma.employeeAbsence.findFirstOrThrow({ where: { organizationId: orgId, memberId: people.anna.memberId, type: 'VACATION' } })
    const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: orgId, systemCode: 'VACATION' } })
    const request = await prisma.organizationRequest.create({ data: { organizationId: orgId, locationId: point1, createdByMemberId: people.anna.memberId, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'VACATION', status: 'APPROVED', startDate: absence.startDate, endDate: absence.endDate, resolvedAt: now, resolvedByMemberId: people.owner.memberId } })
    try {
      await prisma.employeeAbsence.update({ where: { id: absence.id }, data: { sourceRequestId: request.id } })
      const report = await buildReport(people.owner.id, orgId, input(), now)
      assert.equal(report.rows.absences.length, 2)
      assert.equal(report.rows.absences.find(row => row.id === absence.id)?.source, 'Одобренная заявка')
    } finally {
      await prisma.employeeAbsence.update({ where: { id: absence.id }, data: { sourceRequestId: null } })
      await prisma.organizationRequest.delete({ where: { id: request.id } })
    }
  })
  it('stores personnel numbers as optional trimmed organization values and reserves former numbers', async () => {
    assert.equal(personnelBody.parse({ personnelNumber: ' 0041 ' }).personnelNumber, '0041')
    assert.equal(personnelBody.parse({ personnelNumber: ' ' }).personnelNumber, null)
    await updatePersonnelNumber(people.owner.id, orgId, people.former.memberId, '0009')
    await assert.rejects(updatePersonnelNumber(people.admin.id, orgId, people.ivan.memberId, '0009'), code('PERSONNEL_NUMBER_EXISTS'))
    await assert.rejects(updatePersonnelNumber(people.admin.id, orgId, people.other.memberId, '0010'), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(updatePersonnelNumber(people.anna.id, orgId, people.anna.memberId, '0010'), code('INSUFFICIENT_PERMISSIONS'))
    await updatePersonnelNumber(people.admin.id, orgId, people.ivan.memberId, '0042')
  })
  it('validates dates, empty sheets, normalized duplicate titles and cross-sheet/unknown keys', () => {
    for (const patch of [{ from: '2026-02-30' }, { from: '2026-99-99' }, { to: '2026-09-01' }, { to: '2028-01-01' }]) assert.equal(reportBody.safeParse({ ...input(), ...patch }).success, false)
    const config = defaultReportConfig(); config.sheets.forEach(sheet => sheet.enabled = false); assert.equal(reportConfigSchema.safeParse(config).success, false)
    config.sheets[0].enabled = true; config.sheets[0].columns = []; assert.equal(reportConfigSchema.safeParse(config).success, false)
    config.sheets[0].columns = [{ key: 'memberId', title: ' Код ' }, { key: 'name', title: 'код' }]; assert.equal(reportConfigSchema.safeParse(config).success, false)
    config.sheets[0].columns[1] = { key: 'break', title: 'Перерыв' }; assert.equal(reportConfigSchema.safeParse(config).success, false)
    config.sheets[0].columns[1] = { key: 'memberId', title: 'Другой ID' }; assert.equal(reportConfigSchema.safeParse(config).success, false)
    assert.equal(templateBody.safeParse({ name: ' ', config: defaultReportConfig() }).success, false)
  })
  it('saves, shares, updates and deletes templates under live owner/creator permissions', async () => {
    const template = await saveReportTemplate(people.admin.id, orgId, null, { name: 'Для бухгалтерии', config: defaultReportConfig() })
    assert.equal((await reportOptions(people.admin.id, orgId)).templates.find(item => item.id === template.id)?.canManage, true)
    const own = await saveReportTemplate(people.owner.id, orgId, null, { name: 'Владельца', config: defaultReportConfig() })
    assert.equal((await reportOptions(people.admin.id, orgId)).templates.find(item => item.id === own.id)?.canManage, false)
    await assert.rejects(deleteReportTemplate(people.admin.id, orgId, own.id), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(saveReportTemplate(people.admin.id, orgId, own.id, { name: 'Правка', config: defaultReportConfig() }), code('INSUFFICIENT_PERMISSIONS'))
    await saveReportTemplate(people.owner.id, orgId, template.id, { name: 'Обновлённая', config: defaultReportConfig() })
    const report = await buildReport(people.admin.id, orgId, input({ locationIds: [point1], templateId: own.id }), now)
    assert.equal(report.rows.parameters.find(row => row.parameter === 'Сохранённая настройка')?.value, 'Владельца')
    await assert.rejects(buildReport(people.foreign.id, foreignOrgId, input({ locationIds: [], memberIds: [], templateId: own.id }), now), code('TEMPLATE_NOT_FOUND'))
    await deleteReportTemplate(people.owner.id, orgId, template.id); await deleteReportTemplate(people.owner.id, orgId, own.id)
  })
  it('revokes saved-template access after a manager loses assignments', async () => {
    const template = await saveReportTemplate(people.admin.id, orgId, null, { name: 'После доступа', config: defaultReportConfig() })
    await prisma.locationMember.update({ where: { locationId_memberId: { locationId: point1, memberId: people.admin.memberId } }, data: { leftAt: now } })
    try { await assert.rejects(reportOptions(people.admin.id, orgId), code('INSUFFICIENT_PERMISSIONS')); await assert.rejects(buildReport(people.admin.id, orgId, input({ templateId: template.id }), now), code('INSUFFICIENT_PERMISSIONS')); await assert.rejects(deleteReportTemplate(people.admin.id, orgId, template.id), code('INSUFFICIENT_PERMISSIONS')) } finally { await prisma.locationMember.update({ where: { locationId_memberId: { locationId: point1, memberId: people.admin.memberId } }, data: { leftAt: null } }); await deleteReportTemplate(people.owner.id, orgId, template.id) }
  })
  it('exports custom ordered titles, typed dates/numbers and preserves leading zeroes and literal formulas', async () => {
    const config = defaultReportConfig(); config.layout = 'table'; config.sheets[0].columns = [{ key: 'personnelNumber', title: '=Код' }, { key: 'name', title: '+Сотрудник' }, { key: 'shifts', title: '-Смен' }, { key: 'hours', title: '@Часы' }, { key: 'locations', title: 'Заведение' }]
    const report = await buildReport(people.owner.id, orgId, input({ config }), now), preview = previewReport(report), workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await reportWorkbook(report)).buffer)
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Сводка', 'Смены', 'Отсутствия', 'Параметры'])
    const summary = workbook.getWorksheet('Сводка')!
    assert.deepEqual(Array.from(summary.getRow(1).values as unknown[]).slice(1), ['=Код', '+Сотрудник', '-Смен', '@Часы', 'Заведение'])
    assert.equal(summary.getCell('A2').value, '0041'); assert.equal(summary.getCell('A3').value, '0042')
    assert.equal(summary.getCell('D5').value, 28.5); assert.equal(summary.getCell('D2').numFmt, '0.00')
    assert.equal(summary.views[0].state, 'frozen'); assert.ok(summary.autoFilter)
    assert.ok(workbook.getWorksheet('Смены')!.getCell('F2').value instanceof Date)
    assert.equal(workbook.getWorksheet('Смены')!.getCell('F2').numFmt, 'dd.mm.yyyy hh:mm')
    assert.equal(summary.getCell('A2').numFmt, '@')
    assert.equal(workbook.getWorksheet('Отсутствия')!.getCell('K3').value, '=HYPERLINK("https://example.test")')
    assert.deepEqual(preview.sheets[0].rows[0], ['0041', 'Смирнова Анна Сергеевна', 1, 8, 'Парк'])
    assert.equal(summary.getCell('A1').type, ExcelJS.ValueType.String)
    for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => assert.notEqual(cell.type, ExcelJS.ValueType.Formula)))
  })
  it('keeps same-name employees and their location totals distinct; requires location columns', async () => {
    const previous = await prisma.user.findUniqueOrThrow({ where: { id: people.ivan.id } })
    await prisma.user.update({ where: { id: people.ivan.id }, data: { firstName: 'Анна', lastName: 'Смирнова', middleName: 'Сергеевна' } })
    try {
      const report = await buildReport(people.owner.id, orgId, input(), now)
      assert.equal(report.rows.summary.length, 3)
      assert.equal(report.metrics.employees, 2)
      assert.equal(new Set(report.rows.summary.map(row => row.name)).size, 2)
      assert.equal(report.rows.summary.reduce((sum, row) => sum + Number(row.hours), 0), 28.5)
      assert.equal(new Set(report.rows.summary.map(row => `${row.memberId}:${row.locationId}`)).size, 3)
      const config = defaultReportConfig()
      config.sheets[0].columns = config.sheets[0].columns.filter(column => column.key !== 'locations')
      await assert.rejects(buildReport(people.owner.id, orgId, input({ config }), now), code('REPORT_LOCATION_REQUIRED'))
    } finally { await prisma.user.update({ where: { id: people.ivan.id }, data: { firstName: previous.firstName, lastName: previous.lastName, middleName: previous.middleName } }) }
  })
  it('styles all sheets, retains local typed dates, hides technical IDs by default and supports them explicitly', async () => {
    const report = await buildReport(people.owner.id, orgId, input(), now), workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await reportWorkbook(report)).buffer)
    for (const sheet of workbook.worksheets) {
      assert.equal(sheet.getCell('A1').value, 'Accounting reports')
      assert.equal(sheet.getRow(7).font.bold, true)
      assert.equal(sheet.getRow(7).font.color?.argb, 'FFFFFFFF')
      assert.equal(sheet.views[0].showGridLines, false)
      assert.equal(sheet.pageSetup.printTitlesRow, '7:7')
    }
    assert.equal(workbook.getWorksheet('Смены')!.getCell('F8').value instanceof Date, true)
    assert.equal(workbook.getWorksheet('Смены')!.getCell('F8').numFmt, 'dd.mm.yyyy hh:mm')
    assert.equal(workbook.getWorksheet('Отсутствия')!.getCell('E8').value instanceof Date, true)
    assert.ok(!report.config.sheets.some(sheet => sheet.columns.some(column => ['memberId', 'id'].includes(column.key))))
    if (process.env.REPORT_REVIEW_DIR) {
      const sample = structuredClone(report)
      sample.rows.parameters.find(row => row.parameter === 'Организация')!.value = 'Кофейни «Пример» · демонстрационные данные'
      for (const row of sample.rows.absences) if (String(row.comment).startsWith('=HYPERLINK')) row.comment = 'Отпуск по заявлению сотрудника'
      await mkdir(process.env.REPORT_REVIEW_DIR, { recursive: true })
      await writeFile(path.join(process.env.REPORT_REVIEW_DIR, 'Staffly_report_example.xlsx'), await reportWorkbook(sample))
    }
    const config = defaultReportConfig(); config.layout = 'table'; config.sheets[0].columns.push({ key: 'memberId', title: 'Технический ID' })
    const withId = await buildReport(people.owner.id, orgId, input({ config }), now)
    assert.ok(previewReport(withId).sheets[0].rows.every(row => typeof row.at(-1) === 'string'))
  })
  it('exports all rows beyond the preview and updates totals after source changes', async () => {
    const created: string[] = []
    try {
      for (let day = 2; day <= 26; day++) { if ([5, 7].includes(day)) continue; created.push((await shift('ivan', point1, `2026-10-${String(day).padStart(2, '0')}`, '19:00', '19:01', `2026-10-${String(day).padStart(2, '0')}`, { breakMinutes: 0 })).id) }
      const report = await buildReport(people.owner.id, orgId, input(), now), preview = previewReport(report), workbook = new ExcelJS.Workbook()
      assert.equal(preview.sheets[1].rows.length, 20); assert.equal(preview.sheets[1].total, 27)
      await workbook.xlsx.load(new Uint8Array(await reportWorkbook(report)).buffer); assert.equal(workbook.getWorksheet('Смены')!.rowCount, 37)
      assert.equal(report.metrics.minutes, 1733)
    } finally { await prisma.workShift.deleteMany({ where: { id: { in: created } } }) }
    assert.equal((await buildReport(people.owner.id, orgId, input(), now)).metrics.minutes, 1710)
  })
  it('creates empty included sheets with headers and suppresses totals when disabled', async () => {
    const config = defaultReportConfig(); config.totals = false; config.sheets[2].enabled = false
    const report = await buildReport(people.owner.id, orgId, input({ from: '2026-12-01', to: '2026-12-31', config }), now), workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await reportWorkbook(report)).buffer); assert.equal(workbook.worksheets.length, 3); assert.equal(workbook.getWorksheet('Сводка')!.rowCount, 10); assert.equal(previewReport(report).sheets[0].totals, null)
    assert.equal(startOfZonedDate('2026-10-01', 'Asia/Vladivostok').toISOString(), '2026-09-30T14:00:00.000Z')
  })
})
