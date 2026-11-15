import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../../../app/auth/auth-context.tsx';
import { invalidateOrganizationWork } from '../../../../app/live-query.ts';
import { correctionLabels, correctionReason, resolveTimeCorrection, canCorrectShift, canConfirmShiftPlan, type CorrectionMode, type CorrectionInput } from '../../../../app/schedule/time/time-correction.ts';
import { displayDate, formatDuration, localDateTimeIso, shiftTimeRange, zonedDateAndTime } from '../../../../app/schedule/date-utils.ts';
import { useFormSafety } from '../../../../app/forms/use-form-safety.ts';
import type { WorkShift } from '../../../../app/schedule/types.ts';
import { useToast } from '../../../../component/ui/toast/toast-context.ts';
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx';
import Avatar from '../../../../component/ui/avatar/avatar.tsx';
import DatePicker, { TimeInput } from '../../../../component/ui/date-picker/date-picker.tsx';
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx';
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx';
import '../schedule.scss';
import './time-correction.scss';

type Data = { shift: WorkShift & { updatedAt: string }; timezone: string; locationName: string };
export default function TimeCorrectionDialog({ organizationId, shiftId, locationId, onClose }: {
  organizationId: string; shiftId: string; locationId: string; onClose: () => void;
}) {
  const { apiRequest } = useAuth();
  const endpoint = `/organizations/${organizationId}/schedule/shifts/${shiftId}/time-correction?locationId=${locationId}`;
  const query = useQuery({ queryKey: ['time-correction', organizationId, locationId, shiftId], queryFn: () => apiRequest<Data>(endpoint), staleTime: 0, refetchOnWindowFocus: false, gcTime: 0 });
  const [busy, setBusy] = useState(false);
  return <AnimatedOverlay variant="modal" className="time-correction-overlay" dismissible={!busy} onClose={onClose}>{close => <DocumentDialog title="Исправить рабочее время" eyebrow="Учёт времени" className="time-correction-dialog" busy={busy} onClose={close}>
    {query.isPending ? <div className="app-state" role="status"><span className="app-spinner" />Загружаем смену…</div> : query.isError ? <div className="app-state" role="alert"><p>{query.error.message}</p><button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : <CorrectionForm key={query.data.shift.updatedAt} data={query.data} endpoint={endpoint} organizationId={organizationId} close={close} onBusy={setBusy} refresh={() => void query.refetch()} saved={onClose} />}
  </DocumentDialog>}</AnimatedOverlay>;
}
function CorrectionForm({ data, endpoint, organizationId, close, onBusy, refresh, saved }: {
  data: Data; endpoint: string; organizationId: string; close: () => void; onBusy: (busy: boolean) => void; refresh: () => void; saved: () => void;
}) {
  const { shift, timezone, locationName } = data;
  const start = zonedDateAndTime(shift.actualStartAt ?? shift.scheduledStartAt, timezone);
  const end = zonedDateAndTime(shift.actualEndAt ?? shift.scheduledEndAt, timezone);
  const [mode, setMode] = useState<CorrectionMode>(shift.attendance === 'NO_SHOW' ? 'NO_SHOW' : 'MARKS');
  const [startDate, setStartDate] = useState(start.date);
  const [startTime, setStartTime] = useState(shift.actualStartAt ? start.time : '');
  const [endDate, setEndDate] = useState(end.date);
  const [endTime, setEndTime] = useState(shift.actualEndAt ? end.time : '');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const { apiRequest } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const safety = useFormSafety({ scope: `time-marks:${shift.id}`, value: { mode, startDate, startTime, endDate, endTime, comment }, busy });
  let input: CorrectionInput | null = null;
  let preview: ReturnType<typeof resolveTimeCorrection> | null = null;
  let validation = '';
  try {
    const hasStart = ['MARKS', 'CUSTOM', 'LATE'].includes(mode);
    const hasEnd = ['MARKS', 'CUSTOM', 'EARLY'].includes(mode);
    input = {
      mode, comment,
      ...(hasStart ? { startAt: startTime ? localDateTimeIso(startDate, startTime, timezone) : null } : {}),
      ...(hasEnd ? { endAt: endTime ? localDateTimeIso(endDate, endTime, timezone) : null } : {}),
    };
    preview = resolveTimeCorrection(shift, input);
  } catch (failure) { validation = failure instanceof Error ? failure.message : 'Проверьте время.'; }
  async function save(value: CorrectionInput) {
    if (busy || conflict) return;
    setBusy(true); onBusy(true); setError('');
    try {
      await apiRequest(endpoint, { method: 'POST', body: { ...value, expectedUpdatedAt: shift.updatedAt } });
      safety.markSaved();
      await invalidateOrganizationWork(client, organizationId);
      toast('Отметки рабочего времени сохранены', 'success');
      onBusy(false); setBusy(false); saved();
    } catch (failure) {
      setConflict((failure as { code?: string }).code === 'SHIFT_CHANGED');
      setError(failure instanceof Error ? failure.message : 'Не удалось сохранить время.');
      setBusy(false); onBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!input || !preview) { setError(validation); return; }
    void save(input);
  }
  function changeMode(next: CorrectionMode) { setMode(next); setError(''); }
  const field = (kind: 'start' | 'end') => <fieldset><legend>{kind === 'start' ? 'Фактический приход' : 'Фактический уход'}</legend><div className="time-correction-fields">
    <label><span>Дата</span><DatePicker value={kind === 'start' ? startDate : endDate} onChange={event => (kind === 'start' ? setStartDate : setEndDate)(event.target.value)} required /></label>
    <label><span>Время</span><TimeInput aria-label={kind === 'start' ? 'Фактический приход' : 'Фактический уход'} value={kind === 'start' ? startTime : endTime} onChange={event => (kind === 'start' ? setStartTime : setEndTime)(event.target.value)} required={mode !== 'MARKS'} /></label>
  </div></fieldset>;
  return <form className="time-correction-form" ref={safety.ref} onSubmit={submit}>
    <div className="time-correction-scroll">
    <div className="time-correction-person"><Avatar name={shift.memberName} url={shift.memberAvatarUrl} className="app-avatar" /><div><strong>{shift.memberName}</strong><small>{locationName} · {displayDate(zonedDateAndTime(shift.scheduledStartAt, timezone).date)}</small></div></div>
    <div className="time-correction-plan"><span>По расписанию</span><strong>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, timezone)}</strong></div>
    {!canCorrectShift(shift) ? <p role="alert">Корректировка доступна после начала действующей смены.</p> : <>
      <SegmentedNav label="Результат и отметки">{(['MARKS', 'LATE', 'EARLY', 'NO_SHOW', 'CUSTOM'] as CorrectionMode[]).map(value => <button type="button" key={value} disabled={busy} aria-pressed={mode === value} onClick={() => changeMode(value)}>{correctionLabels[value]}</button>)}</SegmentedNav>
      <div className="time-correction-inputs">
        {['MARKS', 'LATE', 'CUSTOM'].includes(mode) && field('start')}
        {['MARKS', 'EARLY', 'CUSTOM'].includes(mode) && field('end')}
        {mode === 'NO_SHOW' && <p>Подтверждённая неявка · 0 часов. План смены сохраняется.</p>}
        {mode === 'RESTORE' && <p>Фактические отметки будут сняты. Часы останутся только в предварительном расчёте; история сохранится.</p>}
      </div>
      <div className="time-correction-result" aria-live="polite"><span>{preview ? preview.provisional ? 'Предварительно' : 'Будет подтверждено' : 'Факт ещё не заполнен'}</span><strong>{preview ? formatDuration(preview.minutes) : '—'}</strong>{preview?.provisional && <small>Недостающая отметка взята из расписания только для оценки. Подтверждённого факта пока нет.</small>}{!preview && <small>{validation}</small>}</div>
      <label className="time-correction-comment"><span>Комментарий <small>необязательно</small></span><textarea value={comment} maxLength={400} rows={2} disabled={busy} onChange={event => setComment(event.target.value)} placeholder="При необходимости уточните причину" /></label>
      {canConfirmShiftPlan(shift) && !startTime && !endTime && <button type="button" className="app-secondary" disabled={busy || !!startTime || !!endTime} onClick={() => void save({ mode: 'CONFIRM', comment })}>Подтвердить по плану</button>}
      {(shift.actualStartAt || shift.actualEndAt || shift.attendance === 'NO_SHOW') && <button type="button" className="time-correction-restore" disabled={busy} aria-pressed={mode === 'RESTORE'} onClick={() => changeMode('RESTORE')}>Снять подтверждение</button>}
      <p className="time-correction-note">Причина: {correctionReason({ mode })}. План сохраняется. Автор и изменение попадут в историю. Перерывы входят в длительность.</p>
    </>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}
    {conflict && <button className="app-secondary" type="button" disabled={busy} onClick={refresh}>Обновить данные смены</button>}
    </div>
    <footer><button type="button" className="app-secondary" disabled={busy} onClick={() => void safety.close(close)}>Отмена</button><button className="app-primary" disabled={busy || !preview || conflict}>{busy ? 'Сохраняем…' : 'Сохранить отметки'}</button></footer>
  </form>;
}
