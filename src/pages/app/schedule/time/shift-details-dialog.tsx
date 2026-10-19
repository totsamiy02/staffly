import type { ReactNode } from 'react'
import type { ShiftDetails } from '../../../../app/schedule/types.ts'
import { accountedTimeLabel } from '../../../../app/schedule/time/time-correction.ts'
import { formatTime } from '../../../../app/schedule/date-utils.ts'
import AsyncPanel from '../../../../component/ui/async-panel.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import TimeCorrectionAction from './time-correction-action.tsx'
import { CorrectionAuditRange } from './time-correction-summary.tsx'
import './shift-details-dialog.scss'

function Icon({ history = false }: { history?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={history ? 'M3 11a9 9 0 1 1 2 7M3 5v6h6m3-5v6l4 2' : 'M4 5h16v16H4zM8 3v4m8-4v4M4 10h16'} /></svg>
}
/** The same shift summary and paginated audit from profiles and statistics. The caller owns the query. */
export default function ShiftDetailsDialog({ shift, pending, error, onRetry, timezone, locationId, page, onPage, onClose }: { shift?: ShiftDetails; pending: boolean; error?: string; onRetry: () => void; timezone: string; locationId?: string; page: number; onPage: (page: number) => void; onClose: () => void }) {
  const pages = shift?.adjustmentPagination.pages ?? 1
  const button = (children: ReactNode, value: number, disabled: boolean) => <button type="button" className="app-secondary" disabled={disabled} onClick={() => onPage(value)}>{children}</button>
  return <DocumentDialog title="Смена и корректировки" eyebrow="Рабочее время" className="shift-details-dialog" onClose={onClose}><div className="shift-details-body"><AsyncPanel pending={pending} identity={`${shift?.id ?? ''}:${page}`} minHeight={280}>
    {error ? <div className="shift-details-state" role="alert"><p>{error}</p><button type="button" className="app-secondary" onClick={onRetry}>Повторить</button></div> : shift && <>
      <div className="shift-details-date"><Icon /><strong>{new Date(shift.scheduledStartAt).toLocaleDateString('ru-RU', { timeZone: timezone, day: 'numeric', month: 'long' })}</strong></div>
      <dl className="shift-details-summary"><div><dt>План</dt><dd>{formatTime(shift.scheduledStartAt, timezone)}–{formatTime(shift.scheduledEndAt, timezone)}</dd></div><div><dt>Учтено</dt><dd>{shift.status === 'CANCELLED' ? 'Отменена' : shift.attendance === 'NO_SHOW' ? 'Неявка · 0 ч' : accountedTimeLabel(shift, timezone)}</dd></div></dl>
      <TimeCorrectionAction shift={shift} locationId={locationId} className="shift-details-correct" icon />
      <section className="shift-details-history"><h3>История изменений</h3>{shift.adjustments.length ? <div className="shift-details-audits">{shift.adjustments.map(item => <article key={item.id}><header><strong>{item.changedByName}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('ru-RU', { timeZone: timezone })}</time></header><p>{item.reason}</p>{item.assignmentChange ? <dl><div><dt>Было</dt><dd>{item.assignmentChange.previousMemberName}</dd></div><div><dt>Стало</dt><dd>{item.assignmentChange.newMemberName}</dd></div>{item.assignmentChange.initiatorMemberName && <div><dt>Предложил</dt><dd>{item.assignmentChange.initiatorMemberName}</dd></div>}{item.assignmentChange.acceptedByMemberName && <div><dt>Принял</dt><dd>{item.assignmentChange.acceptedByMemberName}</dd></div>}{item.assignmentChange.reviewedByMemberName && <div><dt>Согласовал</dt><dd>{item.assignmentChange.reviewedByMemberName}</dd></div>}</dl> : <CorrectionAuditRange item={item} timezone={timezone} />}</article>)}</div> : <div className="shift-details-empty"><Icon history /><p>Корректировок пока нет</p><span>Здесь появятся изменения рабочего времени</span></div>}
      {pages > 1 && <nav className="shift-details-pagination" aria-label="Страницы истории смены">{button('Назад', page - 1, page <= 1)}<span>{page} / {pages}</span>{button('Далее', page + 1, page >= pages)}</nav>}</section>
    </>}
  </AsyncPanel></div></DocumentDialog>
}
