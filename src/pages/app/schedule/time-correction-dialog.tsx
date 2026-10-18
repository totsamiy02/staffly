import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { invalidateOrganizationWork } from '../../../app/live-query.ts'
import { correctionLabels, correctionReason, resolveTimeCorrection, canCorrectShift, type CorrectionMode, type CorrectionInput } from '../../../app/schedule/time-correction.ts'
import { displayDate, formatDuration, localDateTimeIso, shiftTimeRange, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import DatePicker, { TimeInput } from '../../../component/ui/date-picker/date-picker.tsx'
import DocumentDialog from '../documents/document-dialog.tsx'
import AnimatedOverlay from './animated-overlay.tsx'
import './schedule.scss'
import './time-correction.scss'

type Data = { shift: WorkShift & { updatedAt: string }; timezone: string; locationName: string }
export default function TimeCorrectionDialog({ organizationId, shiftId, locationId, onClose }: { organizationId: string; shiftId: string; locationId: string; onClose: () => void }) {
  const { apiRequest } = useAuth()
  const endpoint = `/organizations/${organizationId}/schedule/shifts/${shiftId}/time-correction?locationId=${locationId}`
  const query = useQuery({ queryKey: ['time-correction', organizationId, locationId, shiftId], queryFn: () => apiRequest<Data>(endpoint), staleTime: 0, refetchOnWindowFocus: false, gcTime: 0 })
  const [busy, setBusy] = useState(false)
  return <AnimatedOverlay variant="modal" className="time-correction-overlay" dismissible={!busy} onClose={onClose}>{close => <DocumentDialog title="Исправить рабочее время" eyebrow="Учёт времени" className="time-correction-dialog" busy={busy} onClose={close}>{query.isPending ? <div className="app-state" role="status"><span className="app-spinner" />Загружаем смену…</div> : query.isError ? <div className="app-state" role="alert"><p>{query.error.message}</p><button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : <CorrectionForm key={query.data.shift.updatedAt} data={query.data} endpoint={endpoint} organizationId={organizationId} close={close} onBusy={setBusy} refresh={() => void query.refetch()} saved={onClose} />}</DocumentDialog>}</AnimatedOverlay>
}

function CorrectionForm({ data, endpoint, organizationId, close, onBusy, refresh, saved }: { data: Data; endpoint: string; organizationId: string; close: () => void; onBusy: (busy: boolean) => void; refresh: () => void; saved: () => void }) {
  const { shift, timezone, locationName } = data
  const start = zonedDateAndTime(shift.actualStartAt ?? shift.scheduledStartAt, timezone), end = zonedDateAndTime(shift.actualEndAt ?? shift.scheduledEndAt, timezone)
  const [mode, setMode] = useState<CorrectionMode>(shift.attendance === 'NO_SHOW' ? 'RESTORE' : 'LATE')
  const [startDate, setStartDate] = useState(start.date), [startTime, setStartTime] = useState(start.time), [endDate, setEndDate] = useState(end.date), [endTime, setEndTime] = useState(end.time)
  const [comment, setComment] = useState(''), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [busy, setBusy] = useState(false)
  const { apiRequest } = useAuth(), client = useQueryClient(), toast = useToast()
  let input: CorrectionInput | null = null, preview: ReturnType<typeof resolveTimeCorrection> | null = null, validation = ''
  try {
    input = { mode, comment, ...(mode === 'LATE' || mode === 'CUSTOM' ? { startAt: localDateTimeIso(startDate, startTime, timezone) } : {}), ...(mode === 'EARLY' || mode === 'CUSTOM' ? { endAt: localDateTimeIso(endDate, endTime, timezone) } : {}) }
    preview = resolveTimeCorrection(shift, input)
  } catch (failure) { validation = failure instanceof Error ? failure.message : 'Проверьте время.' }
  const plannedMinutes = Math.floor((Date.parse(shift.scheduledEndAt) - Date.parse(shift.scheduledStartAt)) / 60000)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!input || !preview || busy || conflict) { setError(validation); return }
    setBusy(true); onBusy(true); setError('')
    try {
      await apiRequest(endpoint, { method: 'POST', body: { ...input, expectedUpdatedAt: shift.updatedAt } })
      await invalidateOrganizationWork(client, organizationId)
      toast('Рабочее время обновлено', 'success')
      onBusy(false); setBusy(false)
      saved()
    } catch (failure) { setConflict((failure as { code?: string }).code === 'SHIFT_CHANGED'); setError(failure instanceof Error ? failure.message : 'Не удалось сохранить время.'); setBusy(false); onBusy(false) }
  }
  const changeMode = (next: CorrectionMode) => { setMode(next); setError('') }
  const field = (kind: 'start' | 'end') => <fieldset><legend>{kind === 'start' ? 'Когда пришёл' : 'Когда ушёл'}</legend><div className="time-correction-fields"><label><span>Дата</span><DatePicker value={kind === 'start' ? startDate : endDate} onChange={event => (kind === 'start' ? setStartDate : setEndDate)(event.target.value)} required /></label><label><span>Время</span><TimeInput value={kind === 'start' ? startTime : endTime} onChange={event => (kind === 'start' ? setStartTime : setEndTime)(event.target.value)} required /></label></div></fieldset>
  return <form className="time-correction-form" onSubmit={event => void submit(event)}>
    <div className="time-correction-person"><Avatar name={shift.memberName} url={shift.memberAvatarUrl} className="app-avatar" /><div><strong>{shift.memberName}</strong><small>{locationName} · {displayDate(zonedDateAndTime(shift.scheduledStartAt, timezone).date)}</small></div></div>
    <div className="time-correction-plan"><span>По расписанию</span><strong>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, timezone)}</strong><small>{formatDuration(plannedMinutes)}</small></div>
    {!canCorrectShift(shift) ? <p role="alert">Корректировка доступна после начала действующей смены.</p> : <><SegmentedNav label="Причина корректировки">{(Object.keys(correctionLabels) as CorrectionMode[]).filter(value => value !== 'RESTORE').map(value => <button type="button" key={value} disabled={busy} className={mode === value ? 'active' : ''} aria-pressed={mode === value} onClick={() => changeMode(value)}>{correctionLabels[value]}</button>)}</SegmentedNav>
    <div className="time-correction-inputs">{(mode === 'LATE' || mode === 'CUSTOM') && field('start')}{(mode === 'EARLY' || mode === 'CUSTOM') && field('end')}{mode === 'NO_SHOW' && <p>Неявка · 0 учтённых часов. Смена остаётся в расписании.</p>}{mode === 'RESTORE' && <p>Ручные отметки будут сняты. Часы снова считаются по расписанию; история правок сохранится.</p>}</div>
    <div className="time-correction-result" aria-live="polite"><span>{preview ? preview.provisional ? 'Будет учтено по плановому окончанию' : 'Будет учтено' : 'Проверьте время'}</span><strong>{preview ? formatDuration(preview.minutes) : '—'}</strong>{preview && preview.minutes !== plannedMinutes && <small>{preview.minutes < plannedMinutes ? 'Меньше' : 'Больше'} плана на {formatDuration(Math.abs(preview.minutes - plannedMinutes))}</small>}{preview?.provisional && <small>Окончание по расписанию, фактический уход не отмечен.</small>}{!preview && <small>{validation}</small>}</div>
    <label className="time-correction-comment"><span>Комментарий <small>необязательно</small></span><textarea value={comment} maxLength={400} rows={2} disabled={busy} onChange={event => setComment(event.target.value)} placeholder="При необходимости уточните причину" /></label><button type="button" className="time-correction-restore" disabled={busy} aria-pressed={mode === 'RESTORE'} onClick={() => changeMode('RESTORE')}>Вернуть по плану</button><p className="time-correction-note">Причина: {correctionReason({ mode })}. План сохраняется. Автор и время изменения попадут в историю.</p></>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}{conflict && <button className="app-secondary" type="button" disabled={busy} onClick={refresh}>Обновить данные смены</button>}
    <footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy || !preview || conflict}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></footer>
  </form>
}
