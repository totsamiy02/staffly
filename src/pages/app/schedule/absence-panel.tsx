import { useToastFeedback } from '../../../component/ui/toast/toast-context.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import { absenceNames, absenceDays } from '../../../app/schedule/absence-format.ts'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { liveQueryOptions, invalidateOrganizationWork } from '../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import DatePicker from '../../../component/ui/date-picker/date-picker.tsx'
import { displayDate, formatTime, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import AnimatedOverlay from './animated-overlay.tsx'
import './schedule.scss'
import type { EmployeeAbsence } from '../../../app/schedule/types.ts'

type Absence = EmployeeAbsence & { sourceRequestId: string | null; updatedAt: string; cancelledAt: string | null; cancellationReason: string | null; formerMember: boolean; conflicts: Array<{ locationId?: string; id: string; scheduledStartAt: string; scheduledEndAt: string }> }

export default function AbsencePanel({ organization, focusId, onClose }: { organization: OrganizationSummary; focusId?: string | null; onClose: () => void }) {
  const { locationId, apiRequest } = useAuth()
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => { const previous = document.activeElement; const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); return () => { document.body.style.overflow = previousOverflow; if (previous instanceof HTMLElement && previous.isConnected) previous.focus() } }, [])
  const client = useQueryClient()
  const [history, setHistory] = useState(false)
  const [selectedAbsenceId, setSelectedAbsenceId] = useState(focusId)
  useEffect(() => { setSelectedAbsenceId(focusId) }, [focusId])
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Absence | null>(null)
  const [cancelling, setCancelling] = useState<Absence | null>(null)
  const today = zonedDateAndTime(new Date().toISOString(), organization.timezone).date
  const [start, setStart] = useState(today), [end, setEnd] = useState(today), [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(''), 5000); return () => window.clearTimeout(timer) }, [message])
  const manager = organization.role !== 'MEMBER'
  const list = useQuery({ ...liveQueryOptions, queryKey: ['absences', organization.id, history, page, selectedAbsenceId, locationId], queryFn: () => apiRequest<{ absences: Absence[]; pagination: { page: number; pages: number; total: number } }>(`/organizations/${organization.id}/absences?page=${selectedAbsenceId ? 1 : page}&history=${history}${selectedAbsenceId ? '&id=' + selectedAbsenceId : ''}`) })
  useEffect(() => {
    const focused = list.data?.absences.find(item => item.id === selectedAbsenceId)
    if (focused) setHistory(!!focused.cancelledAt || focused.endDate < today)
  }, [list.data, selectedAbsenceId, today])
  const mutation = useMutation({ mutationFn: async () => {
    if (cancelling) return apiRequest(`/organizations/${organization.id}/absences/${cancelling.id}/cancel`, { method: 'POST', body: { updatedAt: cancelling.updatedAt, reason } })
    if (editing) return apiRequest(`/organizations/${organization.id}/absences/${editing.id}`, { method: 'PATCH', body: { startDate: start, endDate: end, updatedAt: editing.updatedAt } })
    throw new Error('Выберите отсутствие для изменения.')
  }, onSuccess: async () => { setMessage(cancelling ? 'Отсутствие отменено. Смены не изменены.' : editing ? 'Период изменён. Проверьте смены в нём.' : ''); setEditing(null); setCancelling(null); await invalidateOrganizationWork(client, organization.id) } })
  useToastFeedback(message, mutation.error instanceof Error ? mutation.error.message : undefined)
  function edit(item: Absence) { mutation.reset(); setMessage(''); setEditing(item); setStart(item.startDate); setEnd(item.endDate) }
  const form = editing || cancelling
  const content = (close: () => void) => <aside ref={dialog} onKeyDown={event => { if (event.key !== 'Tab') return; const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length); const first = elements[0], last = elements.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }} className="schedule-drawer absence-panel" role="dialog" aria-modal="true" aria-labelledby="absence-title"><header><div><p className="app-eyebrow">Доступность сотрудников</p><h2 id="absence-title">{cancelling ? 'Отменить отсутствие' : editing ? 'Изменить период' : manager ? 'Отсутствия команды' : 'Мои отсутствия'}</h2><p>{form && !cancelling ? 'Даты включительно, в часовом поясе организации.' : 'Отпуск, отгул и сообщения об отсутствии.'}</p></div><button type="button" disabled={mutation.isPending} aria-label="Закрыть" onClick={close}>×</button></header>

    {form ? <form onSubmit={event => { event.preventDefault(); mutation.mutate() }} className="absence-form">
      {(editing || cancelling) && <strong>{(editing ?? cancelling)?.memberName}</strong>}
      {cancelling ? <><p>История сохранится. Назначенные смены не изменятся.</p><label><span>Причина отмены</span><textarea required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} rows={3} /></label></> : <><><div className="planning-time"><label><span>Первый день</span><DatePicker value={start} required onChange={event => { setStart(event.target.value); if (end < event.target.value) setEnd(event.target.value) }} /></label><label><span>Последний день</span><DatePicker value={end} min={start} required onChange={event => setEnd(event.target.value)} /></label></div><p>Календарных дней: <strong>{absenceDays(start, end)}</strong></p>{editing?.type === 'SICK' && start <= today && end > today && <button type="button" className="app-secondary" onClick={() => setEnd(today)}>Последний день болезни — сегодня</button>}</></>}
      {mutation.error && <p className="form-inline-error" role="alert">{mutation.error.message}</p>}
      <footer><button type="button" className="app-secondary" disabled={mutation.isPending} onClick={() => { setEditing(null); setCancelling(null); mutation.reset() }}>Назад</button><button className={cancelling ? 'app-danger' : 'app-primary'} disabled={mutation.isPending || (!cancelling && (end < start || absenceDays(start, end) > 367))}>{mutation.isPending ? 'Сохраняем…' : cancelling ? 'Подтвердить отмену' : editing ? 'Сохранить период' : ''}</button></footer>
    </form> : <>
      <div className="absence-toolbar"><nav className="schedule-view-switch" aria-label="Период отсутствий"><button className={!history ? 'active' : ''} aria-pressed={!history} onClick={() => { setSelectedAbsenceId(null); setHistory(false); setPage(1) }}>Текущие и будущие</button><button className={history ? 'active' : ''} aria-pressed={history} onClick={() => { setSelectedAbsenceId(null); setHistory(true); setPage(1) }}>История отсутствий</button></nav></div>
      {list.isLoading ? <p className="app-state">Загружаем отсутствия…</p> : list.isError ? <div className="app-state"><p>Не удалось загрузить отсутствия.</p><button className="app-secondary" onClick={() => void list.refetch()}>Повторить</button></div> : !list.data?.absences.length ? <p className="app-state">Отсутствий за этот период нет.</p> : <div className="absence-list">{list.data.absences.map(item => <article key={item.id} className={item.id === selectedAbsenceId ? 'absence-item absence-item--focused' : 'absence-item'}><header><div><div className="absence-person"><Avatar url={item.memberAvatarUrl} name={item.memberName} className="statistics-avatar" /><strong>{item.memberName}</strong></div><span>{item.reason === 'PERSONAL' ? 'Личные обстоятельства' : item.reason === 'OTHER' ? 'Другое' : absenceNames[item.type]}{item.formerMember ? ' · Бывший сотрудник' : ''}</span></div><span className="absence-state">{item.cancelledAt ? 'Отменено' : item.endDate < today ? 'Завершено' : item.startDate > today ? 'Запланировано' : 'Сейчас отсутствует'}</span></header><p>{displayDate(item.startDate)} — {displayDate(item.endDate)}</p><small>Календарных дней: {absenceDays(item.startDate, item.endDate)}</small>{item.comment && <p>{item.comment}</p>}{item.cancellationReason && <p className="absence-note">Причина отмены: {item.cancellationReason}</p>}{!item.cancelledAt && item.conflicts.length > 0 && <section className="absence-conflicts"><strong>В периоде назначено смен: {item.conflicts.length}</strong>{item.conflicts.map(shift => <Link onClick={onClose} key={shift.id} to={`/app/organizations/${organization.id}/schedule?location=${shift.locationId ?? organization.locationId ?? ''}&month=${zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date.slice(0,7)}&shift=${shift.id}`}>{displayDate(zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date)} · {formatTime(shift.scheduledStartAt, organization.timezone)}–{formatTime(shift.scheduledEndAt, organization.timezone)} →</Link>)}</section>}<footer>{item.sourceRequestId && <Link onClick={onClose} className="request-related-shift" to={`/app/organizations/${organization.id}/requests?tab=${manager ? 'history' : 'mine'}&request=${item.sourceRequestId}`}>Исходная заявка</Link>}{!item.cancelledAt && (manager || !item.sourceRequestId || item.reason !== null) && <><button className="app-secondary" disabled={item.formerMember} onClick={() => edit(item)}>Изменить период</button><button className="app-secondary" onClick={() => { mutation.reset(); setCancelling(item); setReason('') }}>Отменить отсутствие</button></>}</footer></article>)}</div>}
      {list.data && list.data.pagination.pages > 1 && <nav className="members-pagination"><button className="app-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Назад</button><span>{page} / {list.data.pagination.pages}</span><button className="app-secondary" disabled={page >= list.data.pagination.pages} onClick={() => setPage(page + 1)}>Далее</button></nav>}
    </>}
  </aside>
  return <AnimatedOverlay variant="drawer" dismissible={!mutation.isPending} onClose={onClose}>{content}</AnimatedOverlay>
}
