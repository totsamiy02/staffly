import Select from '../../../component/ui/select/select.tsx'
import DatePicker, { TimeInput } from '../../../component/ui/date-picker/date-picker.tsx'
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationMember, OrganizationSummary } from '../../../app/organizations/types.ts'
import { displayDate, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'
import AnimatedOverlay from './animated-overlay.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'

type Props = { organization: OrganizationSummary; members: OrganizationMember[]; date: string; shift?: WorkShift | null; actual?: boolean; onClose: () => void }

function EmployeePicker({ members, value, onChange }: { members: OrganizationMember[]; value: string; onChange: (id: string) => void }) {
  return <label className="employee-picker"><span>Сотрудник</span><Select aria-label="Сотрудник" searchable value={value} onChange={event => onChange(event.target.value)} required><option value="">Выберите сотрудника</option>{members.map(member => <option key={member.id} value={member.id} data-search={`${member.displayName} ${member.email}`}><span className="staffly-select__person"><Avatar url={member.avatarUrl} name={member.displayName} className="employee-picker__avatar" /><span><strong>{member.displayName}</strong><small>{member.email}</small></span></span></option>)}</Select></label>
}

export default function ShiftFormModal({ organization, members, date, shift, actual = false, onClose }: Props) {
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
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent, close: () => void) {
    event.preventDefault(); setError('')
    const start = Date.parse(`${startDate}T${startTime}:00Z`)
    const end = Date.parse(`${endDate}T${endTime}:00Z`)
    if (end <= start) { setError('Окончание должно быть позже начала. Для ночной смены выберите следующий день.'); return }
    if (actual && reason.trim().length < 3) { setError('Укажите причину изменения отработанного времени.'); return }
    setBusy(true)
    try {
      if (actual && shift) await apiRequest(`/organizations/${organization.id}/shifts/${shift.id}/actual`, { method: 'POST', body: { startDate, startTime, endDate, endTime, breakMinutes: 0, reason } })
      else await apiRequest(`/organizations/${organization.id}/shifts${shift ? `/${shift.id}` : ''}`, { method: shift ? 'PATCH' : 'POST', body: { memberId, startDate, startTime, endDate, endTime, breakMinutes: 0, description } })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['schedule', organization.id] }), queryClient.invalidateQueries({ queryKey: ['work-time-statistics', organization.id] }), queryClient.invalidateQueries({ queryKey: ['member-work-time', organization.id] }), queryClient.invalidateQueries({ queryKey: ['my-work-time', organization.id] }), queryClient.invalidateQueries({ queryKey: ['my-upcoming-shifts', organization.id] })])
      close()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить смену.') }
    finally { setBusy(false) }
  }

  return <AnimatedOverlay variant="modal" onClose={onClose}>{(close) => <form className="shift-form" onSubmit={(event) => void submit(event, close)}>
    <header><div><p className="app-eyebrow">{actual ? 'Завершённая смена' : shift ? 'Редактирование графика' : displayDate(date)}</p><h2>{actual ? 'Изменить отработанное время' : shift ? 'Изменить смену' : 'Новая смена'}</h2><p>{actual ? 'План сохранится без изменений. Укажите фактическое время и причину.' : 'Выберите сотрудника и время его работы.'}</p></div><button type="button" aria-label="Закрыть" onClick={close}>×</button></header>
    {actual && shift && <div className="shift-form__plan"><span>Запланированное время</span><strong>{scheduledStart.time}–{scheduledEnd.time}</strong><small>{displayDate(scheduledStart.date)}{scheduledEnd.date !== scheduledStart.date ? ` → ${displayDate(scheduledEnd.date)}` : ''}</small></div>}
    {!actual && <EmployeePicker members={members} value={memberId} onChange={setMemberId} />}
    <div className="shift-form__timeline"><fieldset><legend>Начало смены</legend><label><span>Дата</span><DatePicker value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label><label><span>Время</span><TimeInput value={startTime} onChange={(event) => setStartTime(event.target.value)} required /></label></fieldset><span className="shift-form__timeline-arrow">→</span><fieldset><legend>Окончание смены</legend><label><span>Дата</span><DatePicker value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} required /></label><label><span>Время</span><TimeInput value={endTime} onChange={(event) => setEndTime(event.target.value)} required /></label></fieldset></div>
    {actual ? <label className="shift-form__wide"><span>Почему меняется отработанное время</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} placeholder="Например: сотрудник закончил смену раньше" required /></label> : <label className="shift-form__wide"><span>Комментарий к смене</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={3} placeholder="Например: работа в основном зале" /></label>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}
    <footer><button className="app-secondary" type="button" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy || (!actual && !memberId)}>{busy ? 'Сохраняем…' : actual ? 'Сохранить отработанное время' : 'Добавить в расписание'}</button></footer>
  </form>}</AnimatedOverlay>
}
