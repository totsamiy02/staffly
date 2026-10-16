import { useState } from 'react'
import type { WorkbookPreview } from '../../../app/file-preview/types.ts'
import { columnLabel } from '../../../app/file-preview/types.ts'
import Select from '../select/select.tsx'
import { PageControls } from './controls.tsx'
const ROWS = 100, COLUMNS = 30
export default function TablePreview({ workbook }: { workbook: WorkbookPreview }) {
  const [index, setIndex] = useState(Math.max(0, workbook.sheets.findIndex(sheet => !sheet.hidden))), [page, setPage] = useState(1), [columnPage, setColumnPage] = useState(1)
  const sheet = workbook.sheets[index]
  if (!sheet) return <p className="file-preview-status">В книге нет листов.</p>
  const rowStart = (page - 1) * ROWS + 1, rowEnd = Math.min(sheet.rows, rowStart + ROWS - 1)
  const colStart = (columnPage - 1) * COLUMNS + 1, colEnd = Math.min(sheet.columns, colStart + COLUMNS - 1)
  const visibleMerges = sheet.merges.filter(m => m.top <= rowEnd && m.bottom >= rowStart && m.left <= colEnd && m.right >= colStart)
  const columns = Array.from({ length: Math.max(0, colEnd - colStart + 1) }, (_, i) => colStart + i)
  return <div className="file-preview-reader">
    <div className="file-preview-toolbar"><label className="file-preview-sheet-select">Лист<Select value={String(index)} onChange={event => { setIndex(Number(event.target.value)); setPage(1); setColumnPage(1) }}>{workbook.sheets.map((s, i) => <option key={i} value={i}>{s.name}{s.hidden ? ' (скрытый)' : ''}</option>)}</Select></label><span>{sheet.rows.toLocaleString('ru-RU')} строк · {sheet.columns} столбцов</span></div>
    {workbook.warnings.length > 0 && <details className="file-preview-notes"><summary>Особенности просмотра</summary>{workbook.warnings.map(note => <p key={note}>{note}</p>)}</details>}
    <div key={`${index}:${page}:${columnPage}`} className="file-preview-table-scroll" tabIndex={0} aria-label={`Лист ${sheet.name}`}>
      {!sheet.rows || !sheet.columns ? <p className="file-preview-status">Пустой лист</p> : <table className="file-preview-table"><colgroup><col style={{ width: 52 }} />{columns.map(c => <col key={c} style={{ width: sheet.widths[c] || 150 }} />)}</colgroup><thead><tr><th aria-label="Номер строки" />{columns.map(c => <th key={c} scope="col">{columnLabel(c)}</th>)}</tr></thead><tbody>{Array.from({ length: rowEnd - rowStart + 1 }, (_, offset) => {
        const r = rowStart + offset
        return <tr key={r}><th scope="row">{r}</th>{columns.map(c => {
          const merge = visibleMerges.find(m => r >= m.top && r <= m.bottom && c >= m.left && c <= m.right)
          if (merge && (r !== Math.max(rowStart, merge.top) || c !== Math.max(colStart, merge.left))) return null
          const cell = sheet.cells[`${merge?.top ?? r}:${merge?.left ?? c}`]
          return <td key={c} rowSpan={merge ? Math.min(rowEnd, merge.bottom) - r + 1 : undefined} colSpan={merge ? Math.min(colEnd, merge.right) - c + 1 : undefined} style={{ fontWeight: cell?.bold ? 700 : undefined, fontStyle: cell?.italic ? 'italic' : undefined, color: cell?.color, background: cell?.background, textAlign: cell?.align }}><span>{cell?.text}</span>{cell?.note && <details className="file-preview-cell-note"><summary aria-label="Примечание к ячейке">Примечание</summary>{cell.note}</details>}</td>
        })}</tr>
      })}</tbody></table>}
    </div>
    <div className="file-preview-toolbar file-preview-table-footer"><PageControls page={page} count={Math.max(1, Math.ceil(sheet.rows / ROWS))} onChange={setPage} /><span>Строки {sheet.rows ? rowStart : 0}–{rowEnd}</span>{sheet.columns > COLUMNS && <><span>Столбцы {columnLabel(colStart)}–{columnLabel(colEnd)}</span><PageControls page={columnPage} count={Math.ceil(sheet.columns / COLUMNS)} onChange={setColumnPage} noun="Блок" /></>}</div>
    <div className="file-preview-sheets" role="tablist" aria-label="Листы книги">{workbook.sheets.map((s, i) => <button type="button" role="tab" aria-selected={i === index} key={i} onClick={() => { setIndex(i); setPage(1); setColumnPage(1) }}>{s.name}{s.hidden ? ' · скрытый' : ''}</button>)}</div>
  </div>
}
