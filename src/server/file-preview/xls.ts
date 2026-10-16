import * as XLSX from 'xlsx'
import type { PreviewSheet, WorkbookPreview } from '../../app/file-preview/types.ts'
export function xlsPreview(bytes: Buffer, legacy = true): WorkbookPreview {
  if (!legacy && !bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) throw new Error('Некорректный XLSX.')
  const book = XLSX.read(bytes, { type: 'buffer', cellNF: true, cellText: true, cellStyles: true })
  if (!book.SheetNames.length) throw new Error('В книге нет доступных листов.')
  if (book.SheetNames.length > 200) throw new Error('Таблица слишком велика для предпросмотра.')
  let count = 0, formulas = false, missingResults = false
  const sheets = book.SheetNames.map((name, index) => {
    const source = book.Sheets[name]
    const sheet: PreviewSheet = { name, hidden: !!book.Workbook?.Sheets?.[index]?.Hidden, rows: 0, columns: 0, cells: {}, merges: [], widths: {} }
    for (const [address, cell] of Object.entries(source)) {
      if (address.startsWith('!')) continue
      const { r, c } = XLSX.utils.decode_cell(address)
      if (++count > 200000 || r >= 50000 || c >= 512) throw new Error('Таблица слишком велика для предпросмотра.')
      sheet.rows = Math.max(sheet.rows, r + 1); sheet.columns = Math.max(sheet.columns, c + 1)
      formulas ||= !!cell.f
      const missing = !!cell.f && cell.v == null
      missingResults ||= missing
      const background = cell.s?.fgColor?.rgb
      sheet.cells[`${r + 1}:${c + 1}`] = { text: missing ? 'Нет сохранённого результата' : cell.w ?? XLSX.utils.format_cell(cell), background: typeof background === 'string' && /^[a-f\d]{6}$/i.test(background) ? `#${background}` : undefined, note: cell.c?.map((comment: { t?: string }) => comment.t ?? '').join('\n') }
    }
    for (const merge of source['!merges'] ?? []) {
      if (merge.e.r >= 50000 || merge.e.c >= 512 || sheet.merges.length >= 10000) throw new Error('Таблица слишком велика для предпросмотра.')
      sheet.merges.push({ top: merge.s.r + 1, left: merge.s.c + 1, bottom: merge.e.r + 1, right: merge.e.c + 1 })
      sheet.rows = Math.max(sheet.rows, merge.e.r + 1); sheet.columns = Math.max(sheet.columns, merge.e.c + 1)
    }
    source['!cols']?.forEach((column, index) => { sheet.widths[index + 1] = Math.max(64, Math.min(350, column.wpx ?? (column.wch ?? 16) * 7)) })
    return sheet
  })
  return { kind: 'workbook', sheets, warnings: [legacy ? 'Старый формат XLS: показаны значения, листы и объединённые ячейки. Графики, рисунки и сложное оформление не отображаются.' : 'Показаны значения, листы и объединённые ячейки. Часть оформления, графики и рисунки в этой книге не отображаются.', ...(formulas ? ['Формулы не выполняются: показаны сохранённые результаты.'] : []), ...(missingResults ? ['У части формул нет сохранённого результата.'] : [])] }
}
