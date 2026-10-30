import ExcelJS from 'exceljs'
import { reportCatalog, type ReportSheet } from '../../../app/schedule/reports/reporting.ts'
import type { BuiltReport } from './report-service.ts'

type Cell = string | number | Date | null

export function totalCells(report: BuiltReport, key: ReportSheet, columns: Array<{ key: string }>): Array<string | number | null> | null {
  if (key !== 'summary' || !report.config.totals) return null
  return columns.map(column => column.key === 'shifts' ? report.metrics.shifts : column.key === 'hours' ? report.metrics.hours : null)
}
export async function reportWorkbook(report: BuiltReport) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Staffly'; workbook.created = report.generatedAt
  const metadata = new Map(report.rows.parameters.map(row => [row.parameter, row.value]))
  const presentation = report.config.layout === 'report'
  const headerRow = presentation ? 7 : 1
  const ink = 'FF202124', muted = 'FF717680', line = 'FFDDE0E4'
  for (const sheet of report.config.sheets.filter(sheet => sheet.enabled)) {
    const worksheet = workbook.addWorksheet(reportCatalog[sheet.key].title)
    worksheet.properties.defaultRowHeight = 28
    worksheet.columns = sheet.columns.map(column => {
      const field = reportCatalog[sheet.key].fields.find(field => field.key === column.key)!
      return { key: column.key, width: field.width, style: { font: { name: 'Arial', size: 11, color: { argb: ink } }, numFmt: field.type === 'hours' ? '0.00' : field.type === 'number' ? '0' : field.type === 'date' ? 'dd.mm.yyyy' : field.type === 'datetime' ? 'dd.mm.yyyy hh:mm' : '@', alignment: { vertical: 'middle', horizontal: ['number', 'hours'].includes(field.type) ? 'right' : 'left', wrapText: true } } }
    })
    if (presentation) {
      worksheet.getCell('A1').value = String(metadata.get('Организация') ?? 'Staffly')
      worksheet.getCell('A1').font = { name: 'Arial', size: 11, color: { argb: muted } }
      worksheet.getCell('A2').value = `${reportCatalog[sheet.key].title} · отчёт рабочего времени`
      worksheet.getCell('A2').font = { name: 'Arial', size: 17, bold: true, color: { argb: ink } }
      worksheet.getRow(2).height = 32
      worksheet.getCell('A3').value = String(metadata.get('Период включительно') ?? '')
      worksheet.getCell('A4').value = `Сформирован: ${String(metadata.get('Время формирования') ?? '')}`
      for (const row of [1, 2, 3, 4]) worksheet.getCell(row, 1).alignment = { vertical: 'middle', wrapText: false }
      for (const row of [3, 4]) worksheet.getCell(row, 1).font = { name: 'Arial', size: 10, color: { argb: muted } }
      worksheet.getRow(5).height = 10; worksheet.getRow(6).height = 12
      sheet.columns.forEach((_, index) => { worksheet.getCell(5, index + 1).border = { bottom: { style: 'thin', color: { argb: line } } } })
    }
    const header = worksheet.getRow(headerRow)
    header.values = sheet.columns.map(column => column.title)
    header.height = 42; header.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF30343B' } }
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    header.eachCell(cell => { cell.numFmt = '@' })
    let previousLocation: Cell | undefined
    for (const [index, row] of report.rows[sheet.key].entries()) {
      const added = worksheet.addRow(sheet.columns.map(column => row[column.key] ?? null))
      added.height = Math.max(34, ...sheet.columns.map((column, col) => {
        const value = row[column.key], width = worksheet.getColumn(col + 1).width ?? 24
        return typeof value === 'string' ? value.split('\n').reduce((count, text) => count + Math.max(1, Math.ceil(text.length / Math.max(1, width - 3))), 0) * 15 + 10 : 34
      }))
      const point = row.locationId ?? row.locations
      added.eachCell({ includeEmpty: true }, (cell, col) => {
        if (index % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F7F8' } }
        if (index && point !== undefined && point !== previousLocation) cell.border = { top: { style: 'thin', color: { argb: 'FFBBC1C9' } } }
        const key = sheet.columns[col - 1].key
        if (key === 'id' || key === 'memberId') cell.font = { name: 'Arial', size: 10, color: { argb: muted } }
      })
      previousLocation = point
    }
    const dataEnd = worksheet.rowCount
    worksheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: dataEnd, column: sheet.columns.length } }
    const totals = totalCells(report, sheet.key, sheet.columns)
    if (totals) {
      const total = worksheet.addRow(totals)
      total.font = { name: 'Arial', size: 11, bold: true, color: { argb: ink } }; total.height = 34
      total.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECEF' } }
      total.eachCell({ includeEmpty: true }, cell => { cell.border = { top: { style: 'thin', color: { argb: 'FFBBC1C9' } } } })
      const label = totals.findIndex(value => value === null)
      if (label >= 0) total.getCell(label + 1).value = 'Итого'
    }
    const lastTableRow = worksheet.rowCount
    if (presentation) {
      worksheet.addRow([])
      const note = worksheet.addRow([sheet.key === 'absences' ? 'Отсутствия не уменьшают часы. Заведения показывают область учёта; дни не суммируются между точками.' : sheet.key === 'summary' ? 'Отдельная строка на сотрудника и заведение. Фактическое время, иначе план; неявка — 0 часов; перерыв включён.' : sheet.key === 'shifts' ? 'Даты и время местные для заведения; часовой пояс указан в строке. Отменённые смены исключены.' : 'Правила и фильтры на момент формирования отчёта.'])
      note.font = { name: 'Arial', size: 10, color: { argb: muted } }; note.getCell(1).alignment = { wrapText: false }
    }
    const nameIndex = sheet.columns.findIndex(column => column.key === 'name')
    worksheet.views = [{ state: 'frozen', ySplit: headerRow, xSplit: nameIndex >= 0 && nameIndex < sheet.columns.length - 1 ? nameIndex + 1 : 0, showGridLines: false }]
    worksheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow}:${headerRow}`, printArea: `A1:${worksheet.getColumn(sheet.columns.length).letter}${lastTableRow}` }
    worksheet.headerFooter.oddFooter = '&LStaffly&RСтраница &P из &N'
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
