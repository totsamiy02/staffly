import ExcelJS from 'exceljs'
import SSF from 'ssf'
import { parse } from 'csv-parse/sync'
import { xlsPreview } from './xls.ts'
import { compatibleSpreadsheetXml } from './ooxml.ts'
import type { PreviewCell, PreviewSheet, WorkbookPreview } from '../../app/file-preview/types.ts'

const MAX_CELLS = 200_000, MAX_ROWS = 50_000, MAX_COLUMNS = 512, MAX_SHEETS = 200
function oversized(): never { throw new Error('Таблица слишком велика для предпросмотра: до 200 листов, 50 000 строк, 512 столбцов и 200 000 заполненных ячеек. Скачайте оригинал.') }
function color(value?: Partial<ExcelJS.Color>) { return value?.argb && /^[a-f\d]{8}$/i.test(value.argb) ? `#${value.argb.slice(2)}` : undefined }
function emptySheet(name: string): PreviewSheet { return { name, hidden: false, rows: 0, columns: 0, cells: {}, merges: [], widths: {} } }
export async function workbookPreview(bytes: Buffer, csv: boolean): Promise<WorkbookPreview> {
  if (csv) return csvPreview(bytes)
  const book = new ExcelJS.Workbook()
  const compatible = await compatibleSpreadsheetXml(bytes)
  try {
    await book.xlsx.load((compatible ?? bytes) as unknown as Parameters<typeof book.xlsx.load>[0])
  } catch {
    return xlsPreview(bytes, false)
  }
  if (!book.worksheets.length) return xlsPreview(bytes, false)
  if (book.worksheets.length > MAX_SHEETS) oversized()
  let count = 0, formulas = false, missingResults = false
  const sheets = book.worksheets.map(ws => {
    const sheet = emptySheet(ws.name); sheet.hidden = ws.state !== 'visible'
    ws.eachRow(row => row.eachCell(cell => {
      if (cell.type === ExcelJS.ValueType.Merge) return
      if (++count > MAX_CELLS || row.number > MAX_ROWS || Number(cell.col) > MAX_COLUMNS) oversized()
      sheet.rows = Math.max(sheet.rows, row.number); sheet.columns = Math.max(sheet.columns, Number(cell.col))
      let value = cell.value
      if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
        formulas = true; value = cell.result
        if (value === undefined || value === null) { missingResults = true; value = 'Нет сохранённого результата' }
      }
      let text = cell.text
      if (value instanceof Date) {
        const serial = value.getTime() / 86400000 + (book.properties.date1904 ? 24107 : 25569)
        try { text = SSF.format((cell.numFmt || 'dd.mm.yyyy').replace(/\./g, '\\.'), serial, { date1904: book.properties.date1904 }) } catch { text = value.toISOString().slice(0, 10) }
      } else if (typeof value === 'number') {
        try { text = SSF.format(cell.numFmt || 'General', value) } catch { text = String(value) }
      } else if (typeof value === 'boolean') text = value ? 'TRUE' : 'FALSE'
      else if (typeof value === 'string') text = value
      else if (value && typeof value === 'object' && 'error' in value) text = value.error
      const fill = cell.fill
      const item: PreviewCell = { text, bold: cell.font?.bold, italic: cell.font?.italic, color: color(cell.font?.color), background: fill?.type === 'pattern' ? color(fill.fgColor) : undefined }
      if (['left', 'center', 'right'].includes(cell.alignment?.horizontal ?? '')) item.align = cell.alignment.horizontal as PreviewCell['align']
      if (cell.note) item.note = typeof cell.note === 'string' ? cell.note : cell.note.texts?.map(part => part.text).join('')
      sheet.cells[`${row.number}:${cell.col}`] = item
    }))
    if ((ws.model.merges?.length ?? 0) > 10000) oversized()
    for (const range of ws.model.merges ?? []) {
      const [first, last = first] = range.split(':'); const a = ws.getCell(first), b = ws.getCell(last)
      const merge = { top: Number(a.row), left: Number(a.col), bottom: Number(b.row), right: Number(b.col) }
      if (merge.bottom > MAX_ROWS || merge.right > MAX_COLUMNS) oversized()
      sheet.merges.push(merge); sheet.rows = Math.max(sheet.rows, merge.bottom); sheet.columns = Math.max(sheet.columns, merge.right)
    }
    for (let c = 1; c <= sheet.columns; c++) sheet.widths[c] = Math.max(64, Math.min(350, (ws.getColumn(c).width || 16) * 7))
    return sheet
  })
  const warnings = ['Табличный вид показывает значения и основное оформление. Графики, рисунки и параметры печати в табличном просмотре не отображаются.']
  if (formulas) warnings.push('Формулы не выполняются: показаны результаты, сохранённые в файле.')
  if (missingResults) warnings.push('У части формул нет сохранённого результата. Пересохраните файл в Excel и загрузите новую редакцию.')
  return { kind: 'workbook', sheets, warnings }
}
function csvPreview(bytes: Buffer): WorkbookPreview {
  let source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  let delimiter: string | undefined
  const declaration = /^sep=([,;\t|])\r?\n/i.exec(source)
  if (declaration) { delimiter = declaration[1]; source = source.slice(declaration[0].length) }
  // Find separators outside quoted fields in the first logical record, including quoted line breaks.
  if (!delimiter) {
    const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 }; let quoted = false
    for (let i = 0; i < source.length; i++) {
      const ch = source[i]
      if (ch === '"') { if (quoted && source[i + 1] === '"') i++; else quoted = !quoted }
      else if (!quoted && (ch === '\n' || ch === '\r')) break
      else if (!quoted && ch in counts) counts[ch]++
    }
    delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]
  }
  let count = 0
  const rows = parse(source, { delimiter, bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 1_000_000,
    on_record(record: string[], context: { records: number }) { count += record.length; if (context.records > MAX_ROWS || record.length > MAX_COLUMNS || count > MAX_CELLS) oversized(); return record },
  }) as string[][]
  const sheet = emptySheet('Таблица'); sheet.rows = rows.length
  rows.forEach((row, r) => { sheet.columns = Math.max(sheet.columns, row.length); row.forEach((text, c) => { if (text) sheet.cells[`${r + 1}:${c + 1}`] = { text } }) })
  return { kind: 'workbook', sheets: [sheet], warnings: [] }
}
