import { useToast, useToastFeedback } from '../../../component/ui/toast/toast-context.ts'
import Select from '../../../component/ui/select/select.tsx'
import { useSchedulePlanning } from '../../../app/schedule/planning.ts'
import { invalidateOrganizationWork } from '../../../app/live-query.ts'
import EmployeePicker from './employee-picker.tsx'
import DatePicker, { TimeInput } from '../../../component/ui/date-picker/date-picker.tsx'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationMember, OrganizationSummary } from '../../../app/organizations/types.ts'
import { addDays, calendarRange, formatMonth, moveMonth, displayDate, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'
import AnimatedOverlay from './animated-overlay.tsx'

type Props = { organization: OrganizationSummary; members: OrganizationMember[]; date: string; shift?: WorkShift | null; actual?: boolean; onClose: () => void }

export default function ShiftFormModal({ organization, members, date, shift, actual = false, onClose }: Props) {
  const toast = useToast()
  const { apiRequest } = useAuth()
  const queryClient = useQueryClient()
  const scheduledStart = shift ? zonedDateAndTime(shift.scheduledStartAt, organization.timezone) : { date, time: '09:00' }
  const scheduledEnd = shift ? zonedDateAndTime(shift.scheduledEndAt, organization.timezone) : { date, time: '18:00' }
  const actualStart = shift ? zonedDateAndTime(shift.actualStartAt ?? shift.scheduledStartAt, organization.timezone) : scheduledStart
  const actualEnd = shift ? zonedDateAndTime(shift.actualEndAt ?? shift.scheduledEndAt, organization.timezone) : scheduledEnd
  const [memberId, setMemberId] = useState(shift?.memberId ?? members[0]?.id ?? '')
  const [startDate, setStartDate] = useState(actual ? actualStart.date : scheduledStart.date)
  const [startTime, setStartTime] = useState(actual ? actualStart.time : scheduledStart.time)
  const [endDate, setEndDate] = useState(actual ? actualEnd.date : scheduledEnd.date)
  const [endTime, setEndTime] = useState(actual ? actualEnd.time : scheduledEnd.time)
  const [description, setDescription] = useState(shift?.description ?? '')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  useToastFeedback('', error)
  const [busy, setBusy] = useState(false)
  const planning = useSchedulePlanning(organization.id)

  const [positionId, setPositionId] = useState(shift?.positionId ?? '')
  const [templateId, setTemplateId] = useState('')
  const [batch, setBatch] = useState(false)
  const [batchMonth, setBatchMonth] = useState(date.slice(0, 7))
  const [dates, setDates] = useState<string[]>([date])
  const [overrides, setOverrides] = useState<Record<string, { startTime: string; endTime: string; overnight: boolean }>>({})
  const [acknowledgeWorkload, setAcknowledgeWorkload] = useState(false)
  const [acknowledgeAbsence, setAcknowledgeAbsence] = useState(false)
  const [absenceWarning, setAbsenceWarning] = useState(false)
  useEffect(() => { setAcknowledgeAbsence(false); setAbsenceWarning(false) }, [memberId, startDate, endDate, startTime, endTime, description, dates, overrides, positionId, batch])
  const [workloadWarning, setWorkloadWarning] = useState(false)
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current || !planning.data || shift || actual) return
    initialized.current = true
    const assigned = planning.data.assignments.find(item => item.memberId === memberId && planning.data!.positions.some(position => position.id === item.positionId && position.isActive))
    const selected = assigned?.positionId ?? ''
    setPositionId(selected)
    const template = planning.data.templates.find(item => item.isActive && item.positionId === (selected || null))
    if (template) { setTemplateId(template.id); setStartTime(template.startTime); setEndTime(template.endTime); setEndDate(addDays(startDate, template.endDayOffset)) }
  }, [planning.data, shift, actual, memberId, startDate])
  const positions = planning.data?.positions.filter(item => item.isActive && planning.data?.assignments.some(assignment => assignment.memberId === memberId && assignment.positionId === item.id)) ?? []
  const templates = planning.data?.templates.filter(item => item.isActive && (!item.positionId || item.positionId === positionId) && (!item.positionId || planning.data?.positions.some(position => position.id === item.positionId && position.isActive))) ?? []
  function applyTemplate(id: string) {
    setTemplateId(id)
    const item = planning.data?.templates.find(template => template.id === id)
    if (!item) { setStartTime(scheduledStart.time); setEndTime(scheduledEnd.time); setStartDate(scheduledStart.date); setEndDate(scheduledEnd.date); setOverrides({}) }
    if (item) { setStartTime(item.startTime); setEndTime(item.endTime); setEndDate(addDays(startDate, item.endDayOffset)); setOverrides({}) }
    setAcknowledgeWorkload(false); setWorkloadWarning(false)
  }
  function choosePosition(id: string) {
    setPositionId(id)
    const item = planning.data?.templates.find(template => template.isActive && template.positionId === (id || null))
    applyTemplate(item?.id ?? '')
  }
  function chooseEmployee(id: string) {
    setMemberId(id)
    const assigned = planning.data?.assignments.find(item => item.memberId === id && planning.data?.positions.some(position => position.id === item.positionId && position.isActive))
    const nextPosition = assigned?.positionId ?? ''
    setPositionId(nextPosition)
    const item = planning.data?.templates.find(template => template.isActive && template.positionId === (nextPosition || null))
    applyTemplate(item?.id ?? '')
  }


  async function submit(event: FormEvent, close: () => void) {
    event.preventDefault(); setError('')
    const start = Date.parse(`${startDate}T${startTime}:00Z`)
    const end = Date.parse(`${endDate}T${endTime}:00Z`)
    if (!batch && end <= start) { setError('Окончание должно быть позже начала. Для ночной смены выберите следующий день.'); return }
    if (actual && reason.trim().length < 3) { setError('Укажите причину изменения отработанного времени.'); return }
    setBusy(true)
    try {
      if (actual && shift) await apiRequest(`/organizations/${organization.id}/shifts/${shift.id}/actual`, { method: 'POST', body: { startDate, startTime, endDate, endTime, breakMinutes: 0, reason } })
      else if (batch && !shift) {
        await apiRequest('/organizations/' + organization.id + '/shifts/batch', { method: 'POST', body: { acknowledgeAbsence, acknowledgeWorkload, shifts: dates.map(day => {
          const times = overrides[day] ?? { startTime, endTime, overnight: endDate > startDate }
          return { memberId, positionId: positionId || null, startDate: day, endDate: addDays(day, times.overnight ? 1 : 0), startTime: times.startTime, endTime: times.endTime, breakMinutes: 0, description }
        }) } })
      }
      else await apiRequest(`/organizations/${organization.id}/shifts${shift ? `/${shift.id}` : ''}`, { method: shift ? 'PATCH' : 'POST', body: { acknowledgeAbsence, acknowledgeWorkload, positionId: positionId || null, memberId, startDate, startTime, endDate, endTime, breakMinutes: 0, description } })
      await invalidateOrganizationWork(queryClient, organization.id)
      toast(actual ? 'Рабочее время обновлено' : shift ? 'Смена изменена' : 'Смены добавлены', 'success')
      close()
    } catch (failure) { if ((failure as { code?: string }).code === 'EMPLOYEE_ABSENT') setAbsenceWarning(true); if ((failure as { code?: string }).code === 'WORKLOAD_WARNING') setWorkloadWarning(true); setError(failure instanceof Error ? failure.message : 'Не удалось сохранить смену.') }
    finally { setBusy(false) }
  }

  return <AnimatedOverlay variant="modal" onClose={onClose}>{(close) => <form className="shift-form" onChangeCapture={event => { if (!(event.target instanceof HTMLInputElement && ['ackWorkload', 'ackAbsence'].includes(event.target.name))) { setAcknowledgeWorkload(false); if (workloadWarning) { setWorkloadWarning(false); setError('') } } }} onSubmit={(event) => void submit(event, close)}>
    <header><div><p className="app-eyebrow">{actual ? 'Завершённая смена' : shift ? 'Редактирование графика' : displayDate(date)}</p><h2>{actual ? 'Изменить отработанное время' : shift ? 'Изменить смену' : 'Новая смена'}</h2><p>{actual ? 'План сохранится без изменений. Укажите фактическое время и причину.' : 'Выберите сотрудника и время его работы.'}</p></div><button type="button" aria-label="Закрыть" onClick={close}>×</button></header>
    {actual && shift && <div className="shift-form__plan"><span>Запланированное время</span><strong>{scheduledStart.time}–{scheduledEnd.time}</strong><small>{displayDate(scheduledStart.date)}{scheduledEnd.date !== scheduledStart.date ? ` → ${displayDate(scheduledEnd.date)}` : ''}</small></div>}

    {!actual && <EmployeePicker members={members} value={memberId} onChange={chooseEmployee} />}
    {!actual && <div className="planning-time"><label><span>Должность в смене</span><Select value={positionId} onChange={event => choosePosition(event.target.value)}><option value="">Без должности</option>{positions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label><label><span>Шаблон времени</span><Select value={templateId} onChange={event => applyTemplate(event.target.value)}><option value="">Свободное время</option>{templates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.startTime}–{item.endTime}</option>)}</Select></label></div>}
    {!shift && !actual && <label className="planning-checkbox"><input type="checkbox" checked={batch} onChange={event => setBatch(event.target.checked)} /><span>Добавить смены на несколько дат</span></label>}
    {!batch && <div className="shift-form__timeline"><fieldset><legend>Начало смены</legend>{!batch && <label><span>Дата</span><DatePicker value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label>}<label><span>Время</span><TimeInput value={startTime} onChange={(event) => setStartTime(event.target.value)} required /></label></fieldset><span className="shift-form__timeline-arrow">→</span><fieldset><legend>Окончание смены</legend>{!batch && <label><span>Дата</span><DatePicker value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} required /></label>}<label><span>Время</span><TimeInput value={endTime} onChange={(event) => setEndTime(event.target.value)} required /></label></fieldset></div>}
    {batch && !shift && <section className="batch-dates"><h3>Выберите даты смен</h3><div className="my-shifts-period"><button type="button" aria-label="Предыдущий месяц выбора дат" onClick={() => setBatchMonth(moveMonth(batchMonth, -1))}>‹</button><strong>{formatMonth(batchMonth)}</strong><button type="button" aria-label="Следующий месяц выбора дат" onClick={() => setBatchMonth(moveMonth(batchMonth, 1))}>›</button></div><div className="batch-calendar">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <span key={day}>{day}</span>)}{calendarRange(batchMonth).days.map(day => <button type="button" key={day} disabled={!day.startsWith(batchMonth) || (!dates.includes(day) && dates.length >= 62)} aria-label={displayDate(day)} aria-pressed={dates.includes(day)} onClick={() => { setDates(current => current.includes(day) ? current.filter(item => item !== day) : [...current, day].sort()); setWorkloadWarning(false); setAcknowledgeWorkload(false) }}>{Number(day.slice(-2))}</button>)}</div><p>Выбрано дат: {dates.length}. Все смены сохраняются вместе; при конфликте весь пакет остаётся без изменений.</p><div className="batch-rows">{dates.map(day => {
      const times = overrides[day] ?? { startTime, endTime, overnight: endDate > startDate }
      const change = (value: Partial<typeof times>) => { setOverrides(current => ({ ...current, [day]: { ...times, ...value } })); setWorkloadWarning(false); setAcknowledgeWorkload(false) }
      return <fieldset key={day}><legend>{displayDate(day)}</legend><div className="planning-time"><label><span>Начало</span><TimeInput value={times.startTime} required onChange={event => change({ startTime: event.target.value })} /></label><label><span>Окончание</span><TimeInput value={times.endTime} required onChange={event => change({ endTime: event.target.value })} /></label></div><label className="planning-checkbox"><input type="checkbox" checked={times.overnight} onChange={event => change({ overnight: event.target.checked })} /><span>Окончание на следующий день</span></label></fieldset>
    })}</div></section>}
    {actual ? <label className="shift-form__wide"><span>Почему меняется отработанное время</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} placeholder="Например: сотрудник закончил смену раньше" required /></label> : <label className="shift-form__wide"><span>Комментарий к смене</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={3} placeholder="Например: работа в основном зале" /></label>}
    {absenceWarning && <label className="planning-checkbox"><input type="checkbox" name="ackAbsence" checked={acknowledgeAbsence} onChange={event => setAcknowledgeAbsence(event.target.checked)} /><span>Подтверждаю назначение смены несмотря на отсутствие сотрудника</span></label>}
    {workloadWarning && <label className="planning-checkbox"><input type="checkbox" name="ackWorkload" checked={acknowledgeWorkload} onChange={event => setAcknowledgeWorkload(event.target.checked)} /><span>Подтверждаю сохранение с превышением месячной нормы</span></label>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}
    <footer><button className="app-secondary" type="button" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy || (!actual && !memberId) || (batch && !dates.length) || (workloadWarning && !acknowledgeWorkload) || (absenceWarning && !acknowledgeAbsence)}>{busy ? 'Сохраняем…' : actual ? 'Сохранить отработанное время' : 'Добавить в расписание'}</button></footer>
  </form>}</AnimatedOverlay>
}
