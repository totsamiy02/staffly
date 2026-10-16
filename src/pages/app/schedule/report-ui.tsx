import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ReportPreview, ReportConfig, ReportSheet } from '../../../app/schedule/reporting.ts'
import { reportSheets, reportCatalog } from '../../../app/schedule/reporting.ts'

const reportNumber = (value: number) => value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function ReportIcon({ kind }: { kind: 'download' | 'copy' | 'clock' | 'break' | 'cancel' | 'calendar' | 'night' | 'document' | 'info' }) {
  const paths = { download: 'M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5', copy: 'M9 8h11v13H9zM15 8V3H4v13h5', clock: 'M12 7v5l3 2', break: 'M4 4h12v8a5 5 0 0 1-12 0V4Zm12 1h2a3 3 0 0 1 0 6h-2M3 21h15', cancel: 'm5 5 14 14', calendar: 'M4 5h16v16H4zM8 3v4m8-4v4M4 10h16', night: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z', document: 'M6 3h12v18H6zM9 8h6m-6 4h6m-6 4h4', info: 'M12 11v6m0-10v1' }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{['clock', 'cancel', 'info'].includes(kind) && <circle cx="12" cy="12" r="9" />}<path d={paths[kind]} /></svg>
}

export function ReportRules({ compact = false }: { compact?: boolean }) {
  const rules = [ ['clock', 'Фактическое время, иначе план'], ['break', 'Перерыв включён'], ['cancel', 'Отменённые смены исключены'], ['calendar', 'Будущие смены включены'], ['night', 'Ночная смена относится к местной дате начала в часовом поясе точки'], ['document', 'Неявка даёт 0 часов; отсутствие требует обработки смен'] ] as const
  return compact ? <div className="report-rules-inline"><ReportIcon kind="info" /><p>Фактические часы, иначе план · Перерыв включён · Отменённые смены исключены · Будущие смены входят в отчёт.<br />Ночная смена относится к местной дате начала в часовом поясе точки. Неявка даёт 0 часов; отсутствие требует обработки смен.</p></div> : <section className="report-rules"><h3>Правила расчёта</h3><ul>{rules.map(([kind, text]) => <li key={kind}><ReportIcon kind={kind} /><span>{text}</span></li>)}</ul></section>
}

export function ReportSheets({ config, selected, onSelect, onToggle }: { config: ReportConfig; selected: ReportSheet; onSelect: (key: ReportSheet) => void; onToggle: (key: ReportSheet, enabled: boolean) => void }) {
  return <div className="report-sheet-nav" role="group" aria-label="Листы отчёта: включение и предпросмотр">{reportSheets.map(key => <div key={key} className={`report-sheet-tab${selected === key ? ' is-active' : ''}`}><input type="checkbox" aria-label={`Включить лист «${reportCatalog[key].title}»`} checked={config.sheets.find(sheet => sheet.key === key)?.enabled ?? false} onChange={event => onToggle(key, event.target.checked)} /><button type="button" aria-pressed={selected === key} onClick={() => onSelect(key)}>{reportCatalog[key].title}</button></div>)}</div>
}

export function ReportMetrics({ result }: { result?: ReportPreview }) {
  return <div className="report-metrics" aria-label="Итоги всего отчёта"><span><strong>{result?.metrics.employees ?? '—'}</strong> сотрудников</span><span><strong>{result?.metrics.shifts ?? '—'}</strong> смен</span><span><strong>{result ? reportNumber(result.metrics.hours) : '—'} ч</strong> учтено</span></div>
}

export function ReportChecks({ result }: { result: ReportPreview }) {
  const issues = result.metrics.futureShifts || result.warnings.missingNumber.length || result.warnings.incompleteName.length
  if (!issues) return null
  return <section className="report-checks" aria-label="Проверка перед выгрузкой"><h3>Проверка перед выгрузкой</h3>{!!result.warnings.missingNumber.length && <p className="report-hint">Табельный номер необязателен. Заполните его, если бухгалтерия использует номера в своей системе.</p>}{!!result.metrics.futureShifts && <p className="report-future"><ReportIcon kind="clock" /><span>Будущих смен: {result.metrics.futureShifts} · {reportNumber(result.metrics.futureHours)} ч — включены в итог.</span></p>}{(['missingNumber', 'incompleteName'] as const).map(key => !!result.warnings[key].length && <details key={key}><summary>{key === 'missingNumber' ? 'Без табельного номера' : 'Неполное ФИО'}: {result.warnings[key].length}</summary><ul>{result.warnings[key].map(member => <li key={member.id}>{member.name}</li>)}</ul></details>)}</section>
}

// Full identifiers stay available to assistive technology, by hover and by copy.
export function ReportCell({ value, fieldKey, type, onCopy }: { value: string | number | null; fieldKey: string; type: string; onCopy: (value: string) => void }) {
  if (value === null || value === '') return <span className="report-empty">—</span>
  if ((fieldKey === 'memberId' || fieldKey === 'id') && typeof value === 'string') return <span className="report-id"><span title={value} aria-label={value}>{value.length > 22 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value}</span><button type="button" aria-label={`Скопировать ID ${value}`} title="Скопировать полный ID" onClick={() => onCopy(value)}><ReportIcon kind="copy" /></button></span>
  if (type === 'hours' && typeof value === 'number') return <>{reportNumber(value)}</>
  if ((type === 'date' || type === 'datetime') && typeof value === 'string') return <>{new Date(value).toLocaleString('ru-RU', { timeZone: 'UTC', ...(type === 'date' ? { dateStyle: 'short' as const } : { dateStyle: 'short' as const, timeStyle: 'short' as const }) })}</>
  return <>{String(value)}</>
}

export function ReportLocationMenu({ label, disabled, children }: { label: string; disabled: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div ref={ref} className="report-location-menu" onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); ref.current?.querySelector('button')?.focus() } }}><span className="report-label">Точки</span><button type="button" className="report-location-trigger" disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}><span>{label}</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span></button>{open && <div className="report-location-popover" role="group" aria-label="Выберите точки">{children}</div>}</div>
}
