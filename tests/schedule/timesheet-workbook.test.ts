import assert from 'node:assert/strict'
import { it } from 'node:test'
import ExcelJS from 'exceljs'
import { timesheetWorkbook } from '../../src/server/schedule/timesheets/workbook.ts'
import type { TimesheetSnapshot } from '../../src/app/schedule/timesheets/types.ts'

it('keeps employees with identical names distinguishable in accounting Excel', async () => {
  const snapshot: TimesheetSnapshot = {
    organization: 'Тестовая организация',
    location: 'Тестовая точка',
    timezone: 'Europe/Moscow',
    month: '2025-10',
    generatedAt: '2025-11-01T00:00:00Z',
    approval: { reviewerMemberId: 'legacy-accountant', reviewerName: 'Автор прежней версии' },
    members: ['employee-one', 'employee-two'].map(id => ({
      id, name: 'Иван Иванов', number: null, former: false, positions: '',
      plannedMinutes: 0, actualMinutes: 0, workedShifts: 0, noShows: 0,
      vacationDays: 0, sickDays: 0, otherAbsenceDays: 0,
    })),
    shifts: [],
    absences: [],
    issues: [],
  }
  const bytes = await timesheetWorkbook(snapshot, {
    version: 1, currentVersion: 1, closedAt: new Date(snapshot.generatedAt), status: 'CLOSED',
  })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(bytes).buffer)
  const sheet = workbook.getWorksheet('Сводка')!
  assert.equal(sheet.getCell('B2').value, sheet.getCell('B3').value)
  assert.equal(sheet.getCell('M1').value, 'ID сотрудника')
  assert.equal(sheet.getCell('M2').value, 'employee-one')
  assert.equal(sheet.getCell('M3').value, 'employee-two')
  assert.equal(workbook.getWorksheet('Параметры')!.getCell('B10').value, 'Автор прежней версии')
  assert.equal(workbook.getWorksheet('Параметры')!.getCell('B11').value, 'legacy-accountant')
})
