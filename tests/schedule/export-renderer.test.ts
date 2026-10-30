import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { serialize } from 'node:v8'
import ExcelJS from 'exceljs'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'
import type { BuiltReport } from '../../src/server/schedule/reports/report-service.ts'

it('renders a production XLSX without database or application secrets and preserves typed cells', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'staffly-render-test-'))
  try {
    const source = path.join(directory, 'report.bin'), output = path.join(directory, 'report.xlsx')
    const start = new Date('2026-10-30T09:00:00Z'), config = defaultReportConfig()
    config.layout = 'table'
    const report: BuiltReport = { generatedAt: start, config,
      metrics: { employees: 1, shifts: 1, minutes: 480, hours: 8, futureShifts: 0, futureHours: 0 }, warnings: { incompleteName: [] },
      rows: { summary: [{ name: '=HYPERLINK("https://example.test")', shifts: 1, hours: 8 }], shifts: [{ name: 'Анна', start, hours: 8 }], absences: [], parameters: [] } }
    await writeFile(source, serialize(report), { mode: 0o600 })
    await promisify(execFile)(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')),
      fileURLToPath(new URL('../../src/server/schedule/reports/export-child.ts', import.meta.url)), source, output], {
      env: { PATH: process.env.PATH, TMPDIR: directory, NODE_ENV: 'production' }, timeout: 60000,
    })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await readFile(output)).buffer)
    const summary = workbook.getWorksheet('Сводка')!, shifts = workbook.getWorksheet('Смены')!
    assert.equal(summary.getCell('A2').value, report.rows.summary[0].name)
    assert.equal(summary.getCell('E2').value, 1)
    assert.equal(summary.getCell('F2').value, 8)
    assert.deepEqual(shifts.getCell('E2').value, start)
    assert.equal((await stat(output)).mode & 0o777, 0o600)
    // The renderer cannot overwrite an existing output file on accidental replay.
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/server/schedule/reports/export-child.ts', source, output], { env: { PATH: process.env.PATH, NODE_ENV: 'production' } }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
