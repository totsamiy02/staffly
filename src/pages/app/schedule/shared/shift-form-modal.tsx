import { useSubscription } from '../../../../app/subscriptions/context.ts'
import { availabilityWarningFrom, type AvailabilityWarning, type AvailabilityIssue } from '../../../../shared/availability.ts'
import { AvailabilityWarningPanel } from '../availability/availability-elements.tsx'
import { RequestErrorState } from '../../../../component/ui/request-error-message.tsx'
import { openingHoursConfirmationFrom } from '../../../../shared/organization-profile.ts'
import OpeningHoursWarning from '../../organizations/opening-hours-warning.tsx'
import { OpeningHoursSummary } from '../../organizations/opening-hours.tsx'
import ProfileDisclosure from '../../organizations/profile-disclosure.tsx'
import { useFormSafety } from '../../../../app/forms/use-form-safety.ts'
import BatchShiftEditor from './batch-shift-editor.tsx'
import { batchShiftLabel, batchTimeError, retainBatchOverrides, type BatchShiftOverrides, type BatchShiftTime } from '../../../../app/schedule/batch-shifts.ts'
import '../schedule-redesign.scss'
import './shift-form-modal.scss'
import { useToast, useToastFeedback } from '../../../../component/ui/toast/toast-context.ts'
import Select from '../../../../component/ui/select/select.tsx'
import { useSchedulePlanning } from '../../../../app/schedule/planning/planning.ts'
import { invalidateOrganizationWork } from '../../../../app/live-query.ts'
import EmployeePicker from '../../shared/employee-picker.tsx'
import DatePicker, { TimeInput } from '../../../../component/ui/date-picker/date-picker.tsx'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import type { RequestFailure } from '../../../../app/auth/request-errors.ts'
import type { OrganizationMember, OrganizationSummary } from '../../../../app/organizations/types.ts'
import { addDays, displayDate, localDateTimeIso, zonedDateAndTime } from '../../../../app/schedule/date-utils.ts'
import type { WorkShift } from '../../../../app/schedule/types.ts'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'

type Props = {
  organization: OrganizationSummary
  members: OrganizationMember[]
  date: string
  shift?: WorkShift | null
  actual?: boolean
  onClose: () => void
  draft?: {
    id: string
    revision: number
    proposalId?: string
    sourceShiftId?: string
    published: boolean
    closed: boolean
    deadline?: string | null
  }
}

export default function ShiftFormModal({ organization, members, date, shift, actual = false, onClose, draft }: Props) {
  const subscription = useSubscription()
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
  const [attendance, setAttendance] = useState<'WORKED' | 'PARTIAL' | 'NO_SHOW'>(
    shift?.attendance === 'NO_SHOW' ? 'NO_SHOW' : shift?.attendance === 'PARTIAL' ? 'PARTIAL' : 'WORKED',
  )
  const [error, setError] = useState('')
  useToastFeedback('', error)
  const [busy, setBusy] = useState(false)
  const [confirmWindow, setConfirmWindow] = useState(false)
  const [extendWindow, setExtendWindow] = useState(draft?.closed ?? false)
  const suggestedDeadline = zonedDateAndTime(new Date(Date.now() + 24 * 3600000).toISOString(), organization.timezone)
  const [deadlineDate, setDeadlineDate] = useState(suggestedDeadline.date)
  const [deadlineTime, setDeadlineTime] = useState(suggestedDeadline.time)
  const planning = useSchedulePlanning(organization.id, organization.locationId, !actual)

  const [positionId, setPositionId] = useState(shift?.positionId ?? '')
  const [templateId, setTemplateId] = useState('')
  const [batch, setBatch] = useState(false)
  const [batchMonth, setBatchMonth] = useState(date.slice(0, 7))
  const [dates, setDates] = useState<string[]>([date])
  const [overrides, setOverrides] = useState<BatchShiftOverrides>({})
  const [invalidDate, setInvalidDate] = useState<string>()
  const commonTime = { startTime, endTime, overnight: endDate > startDate }
  const [openingWarning, setOpeningWarning] = useState<string>()
  const [outsideAccepted, setOutsideAccepted] = useState(false)
  useEffect(() => {
    setOpeningWarning(undefined)
    setOutsideAccepted(false)
    setInvalidDate(undefined)
    setError('')
  }, [memberId, startDate, endDate, startTime, endTime, dates, overrides, batch, positionId])
  const openingHoursConfirmation = outsideAccepted ? openingWarning : undefined
  const [acknowledgeWorkload, setAcknowledgeWorkload] = useState(false)
  const [acknowledgeAbsence, setAcknowledgeAbsence] = useState(false)
  const [absenceWarning, setAbsenceWarning] = useState(false)
  useEffect(() => {
    setAcknowledgeAbsence(false)
    setAbsenceWarning(false)
  }, [memberId, startDate, endDate, startTime, endTime, description, dates, overrides, positionId, batch])
  const [workloadWarning, setWorkloadWarning] = useState(false)
  useEffect(() => {
    setWorkloadWarning(false)
    setAcknowledgeWorkload(false)
  }, [memberId, startDate, endDate, startTime, endTime, dates, overrides, batch, positionId])
  const [availabilityServerWarning, setAvailabilityServerWarning] = useState<AvailabilityWarning | null>(null)
  const [availabilityAgreement, setAvailabilityAgreement] = useState<{ token: string; reason: string } | null>(null)
  const availabilityPeriods: Array<{ start: string; end: string }> = []
  try {
    const inputs = batch && !shift ? dates.map(day => {
      const times = overrides[day] ?? commonTime
      if (batchTimeError(times)) throw new Error('Invalid time')
      return { day, start: times.startTime, endDay: addDays(day, times.overnight ? 1 : 0), end: times.endTime }
    }) : [{ day: startDate, start: startTime, endDay: endDate, end: endTime }]
    for (const item of inputs) {
      const start = localDateTimeIso(item.day, item.start, organization.timezone)
      const end = localDateTimeIso(item.endDay, item.end, organization.timezone)
      if (end <= start) throw new Error('Invalid time')
      availabilityPeriods.push({ start, end })
    }
  } catch {
    availabilityPeriods.length = 0
  }
  const assignmentUnchanged = !!shift && memberId === shift.memberId && availabilityPeriods.length === 1
    && availabilityPeriods[0].start === shift.scheduledStartAt && availabilityPeriods[0].end === shift.scheduledEndAt
  const preservesAgreement = assignmentUnchanged && !!shift?.availabilityOverride
  const previewEnabled = !actual && !draft && !preservesAgreement && !!memberId && availabilityPeriods.length > 0 && subscription.available('availability')
  const availabilityPreview = useQuery({
    queryKey: ['availability-preview', organization.id, organization.locationId, memberId, availabilityPeriods],
    queryFn: ({ signal }) => apiRequest<{ issues: AvailabilityIssue[]; warning: AvailabilityWarning | null }>(`/organizations/${organization.id}/availability/${memberId}/preview`, {
      method: 'POST', body: { periods: availabilityPeriods }, signal, notifySubscription: false,
    }),
    enabled: previewEnabled,
    retry: false,
    staleTime: 15000,
    refetchOnWindowFocus: 'always',
  })
  const availabilityWarning = availabilityServerWarning ?? (previewEnabled && availabilityPreview.isSuccess ? availabilityPreview.data.warning : null)
  const availabilityAgreed = !!availabilityWarning && availabilityAgreement?.token === availabilityWarning.availabilityConfirmation
  const availabilityReason = availabilityAgreed ? availabilityAgreement?.reason ?? '' : ''
  const availabilityConfirmation = availabilityAgreed ? availabilityAgreement?.token : undefined
  const availabilityByDate: Record<string, string> = {}
  for (const issue of availabilityWarning?.availabilityConflicts ?? []) {
    const day = zonedDateAndTime(issue.start, organization.timezone).date
    availabilityByDate[day] = `${issue.message} · ${issue.timezone}`
  }
  useEffect(() => {
    setAvailabilityServerWarning(null)
    setAvailabilityAgreement(null)
  }, [memberId, startDate, endDate, startTime, endTime, dates, overrides, batch])
  const safety = useFormSafety({
    scope: 'shift:' + organization.id + ':' + organization.locationId + ':' + (shift?.id ?? 'new'),
    value: { memberId, startDate, startTime, endDate, endTime, description, reason, attendance, extendWindow, deadlineDate, deadlineTime, positionId, templateId, batch, batchMonth, dates, overrides },
    busy,
  })
  const initializeDefaults = safety.initialize
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current || !planning.data || shift || actual) return
    initialized.current = true
    const assigned = planning.data.assignments.find(item => item.memberId === memberId && planning.data!.positions.some(position => position.id === item.positionId && position.isActive))
    const selected = assigned?.positionId ?? ''
    setPositionId(selected)
    initializeDefaults({ positionId: selected })
    const template = planning.data.templates.find(item => item.isActive && item.positionId === (selected || null))
    if (template && startTime === '09:00' && endTime === '18:00' && endDate === startDate) {
      initializeDefaults({ templateId: template.id, startTime: template.startTime, endTime: template.endTime, endDate: addDays(startDate, template.endDayOffset) })
      setTemplateId(template.id)
      setStartTime(template.startTime)
      setEndTime(template.endTime)
      setEndDate(addDays(startDate, template.endDayOffset))
    }
  }, [planning.data, shift, actual, memberId, startDate, startTime, endTime, endDate, initializeDefaults])
  const positions = planning.data?.positions.filter(item => item.isActive && planning.data?.assignments.some(assignment => assignment.memberId === memberId && assignment.positionId === item.id)) ?? []
  const templates = planning.data?.templates.filter(item => item.isActive && (!item.positionId || item.positionId === positionId) && (!item.positionId || planning.data?.positions.some(position => position.id === item.positionId && position.isActive))) ?? []
  function applyTemplate(id: string) {
    setTemplateId(id)
    const item = planning.data?.templates.find(template => template.id === id)
    if (!item) {
      setStartTime(scheduledStart.time)
      setEndTime(scheduledEnd.time)
      setEndDate(addDays(startDate, scheduledEnd.date > scheduledStart.date ? 1 : 0))
    } else {
      setStartTime(item.startTime)
      setEndTime(item.endTime)
      setEndDate(addDays(startDate, item.endDayOffset))
    }
    setAcknowledgeWorkload(false)
    setWorkloadWarning(false)
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


  function changeDates(next: string[]) {
    setDates(next)
    setOverrides(current => retainBatchOverrides(current, next))
    setInvalidDate(undefined)
  }

  function changeOverride(day: string, value: BatchShiftTime | null) {
    setOverrides(current => {
      const next = { ...current }
      if (value) next[day] = value
      else delete next[day]
      return next
    })
    setInvalidDate(undefined)
  }

  function changeCommonTime(value: Partial<BatchShiftTime>) {
    setTemplateId('')
    if (value.startTime !== undefined) setStartTime(value.startTime)
    if (value.endTime !== undefined) setEndTime(value.endTime)
    if (value.overnight !== undefined) setEndDate(addDays(startDate, value.overnight ? 1 : 0))
  }

  async function submit(event: FormEvent, close: () => void) {
    event.preventDefault()
    setError('')
    setInvalidDate(undefined)
    if (batch && !shift) {
      for (const day of dates) {
        const message = batchTimeError(overrides[day] ?? commonTime)
        if (message) {
          setInvalidDate(day)
          setError(`${displayDate(day)}: ${message}`)
          return
        }
      }
    }
    const start = Date.parse(`${startDate}T${startTime}:00Z`)
    const end = Date.parse(`${endDate}T${endTime}:00Z`)
    if (!batch && !(actual && attendance === 'NO_SHOW') && end <= start) {
      setError('Окончание должно быть позже начала. Для ночной смены выберите следующий день.')
      return
    }
    if (actual && reason.trim().length < 3) {
      setError('Укажите причину изменения отработанного времени.')
      return
    }
    setBusy(true)
    try {
      const batchInputs = batch && !shift ? dates.map(day => {
        const times = overrides[day] ?? commonTime
        return {
          memberId, positionId: positionId || null, startDate: day,
          endDate: addDays(day, times.overnight ? 1 : 0),
          startTime: times.startTime, endTime: times.endTime, breakMinutes: 0, description,
        }
      }) : []
      if (draft) {
        const shifts = batch && !shift ? batchInputs : [{ memberId, positionId: positionId || null, startDate, endDate, startTime, endTime, breakMinutes: shift?.breakMinutes ?? 0, description }]
        await apiRequest(`/organizations/${organization.id}/schedule/drafts/${draft.id}/proposals`, {
          method: 'POST',
          body: {
            revision: draft.revision, proposalId: draft.proposalId, sourceShiftId: draft.sourceShiftId,
            kind: draft.sourceShiftId ? 'UPDATE' : 'CREATE', shifts, confirmResponseWindow: confirmWindow,
            deadline: extendWindow ? localDateTimeIso(deadlineDate, deadlineTime, organization.timezone) : undefined,
          },
        })
      } else if (actual && shift) {
        await apiRequest(`/organizations/${organization.id}/schedule/shifts/${shift.id}/attendance${organization.locationId ? `?locationId=${organization.locationId}` : ''}`, {
          method: 'POST',
          body: { attendance, reason, startAt: localDateTimeIso(startDate, startTime, organization.timezone), endAt: localDateTimeIso(endDate, endTime, organization.timezone) },
        })
      } else if (batch && !shift) {
        await apiRequest(`/organizations/${organization.id}/shifts/batch`, {
          method: 'POST',
          body: { availabilityConfirmation, availabilityReason, timesheetReason: reason, openingHoursConfirmation, acknowledgeAbsence, acknowledgeWorkload, shifts: batchInputs },
        })
      } else {
        await apiRequest(`/organizations/${organization.id}/shifts${shift ? `/${shift.id}` : ''}`, {
          method: shift ? 'PATCH' : 'POST',
          body: { availabilityConfirmation, availabilityReason, timesheetReason: reason, openingHoursConfirmation, acknowledgeAbsence, acknowledgeWorkload, positionId: positionId || null, memberId, startDate, startTime, endDate, endTime, breakMinutes: 0, description },
        })
      }
      await invalidateOrganizationWork(queryClient, organization.id)
      toast(draft ? 'Предварительный график сохранён' : actual ? 'Рабочее время обновлено' : shift ? 'Смена изменена' : 'Смены добавлены', 'success')
      safety.markSaved()
      close()
    } catch (failure) {
      const availability = availabilityWarningFrom(failure)
      if (availability) { setAvailabilityServerWarning(availability); setAvailabilityAgreement(null) }
      const token = openingHoursConfirmationFrom(failure)
      if (token) {
        setOpeningWarning(token)
        setOutsideAccepted(false)
      }
      const requestFailure = failure as RequestFailure
      if (requestFailure.code === 'EMPLOYEE_ABSENT') setAbsenceWarning(true)
      if (requestFailure.code === 'WORKLOAD_WARNING') setWorkloadWarning(true)
      const details = requestFailure.errors
      if (batch && details && typeof details === 'object' && 'date' in details && typeof details.date === 'string' && dates.includes(details.date)) {
        setInvalidDate(details.date)
      }
      setError(failure instanceof Error ? failure.message : 'Не удалось сохранить смену.')
    } finally {
      setBusy(false)
    }
  }

  const title = actual ? 'Изменить отработанное время' : shift ? 'Редактировать смену' : batch ? 'Создать смены' : 'Создать смену'
  const submitDisabled = busy || (!!openingWarning && !outsideAccepted) || (!!draft?.published && !confirmWindow)
    || (!actual && !memberId) || (batch && !dates.length) || (workloadWarning && !acknowledgeWorkload) || (absenceWarning && !acknowledgeAbsence)
    || (previewEnabled && (availabilityPreview.isPending || availabilityPreview.isError))
    || (!!availabilityWarning && (!availabilityAgreed || availabilityReason.trim().length < 3))

  return <AnimatedOverlay variant="modal" dismissible={!busy} onClose={onClose} beforeClose={safety.confirmClose}>
    {close => <DocumentDialog className={`schedule-shift-dialog${batch && !shift ? ' schedule-shift-dialog--batch' : ''}`} title={title} headerContent={<></>} busy={busy} onClose={close}>
      <form className="shift-form" onChangeCapture={event => {
        if ((event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) && ['ackWorkload', 'ackAbsence', 'ackOpeningHours', 'availabilityReason'].includes(event.target.name)) return
        setInvalidDate(undefined)
        setAcknowledgeWorkload(false)
        if (workloadWarning) { setWorkloadWarning(false); setError('') }
      }} onSubmit={event => void submit(event, close)}>
        <header>
          <div><h2>{title}</h2><p>{draft ? 'Предварительный график. Основной календарь пока не изменится.' : actual ? 'План сохранится без изменений. Укажите фактическое время и причину.' : batch ? 'Одно время для всех дат. Отдельные дни можно изменить.' : 'Выберите сотрудника и время его работы.'}</p></div>
          <button type="button" disabled={busy} aria-label="Закрыть" onClick={close}>×</button>
        </header>
        <div className="shift-form__body" role="region" aria-label="Параметры смены" tabIndex={0}>
          <fieldset className="shift-form__fields" disabled={busy}>
            {actual && shift && <div className="shift-form__plan"><span>Запланированное время</span><strong>{scheduledStart.time}–{scheduledEnd.time}</strong><small>{displayDate(scheduledStart.date)}{scheduledEnd.date !== scheduledStart.date ? ` → ${displayDate(scheduledEnd.date)}` : ''}</small></div>}
            {actual && <label><span>Результат смены</span><Select value={attendance} onChange={event => setAttendance(event.target.value as typeof attendance)}><option value="WORKED">Отработана</option><option value="PARTIAL">Частично отработана</option><option value="NO_SHOW">Неявка · 0 отработанных часов</option></Select><small>План сохраняется. Это отметка учёта времени, а не дисциплинарное решение.</small></label>}
            <div className="shift-form__identity">
              {!actual && <EmployeePicker members={members} value={memberId} onChange={chooseEmployee} />}
              <div className="shift-form__location"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></svg><span><small>Точка смены</small><strong>{organization.location?.name ?? organization.name}</strong></span></div>
            </div>
            {!actual && <div className="planning-time">
              <label><span>Должность в смене</span><Select value={positionId} onChange={event => choosePosition(event.target.value)}><option value="">Без должности</option>{positions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
              <label><span>Шаблон времени</span><Select value={templateId} onChange={event => applyTemplate(event.target.value)}><option value="">Свободное время</option>{templates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.startTime}–{item.endTime}</option>)}</Select></label>
            </div>}
            {!shift && !actual && <label className="planning-checkbox shift-form__batch-toggle"><input type="checkbox" checked={batch} onChange={event => setBatch(event.target.checked)} /><span>Добавить смены на несколько дат</span></label>}
            {!batch && <div className="shift-form__timeline">
              <fieldset><legend>Начало смены</legend><label><span>Дата</span><DatePicker value={startDate} onChange={event => setStartDate(event.target.value)} required /></label><label><span>Время</span><TimeInput value={startTime} onChange={event => setStartTime(event.target.value)} required /></label></fieldset>
              <span className="shift-form__timeline-arrow">→</span>
              <fieldset><legend>Окончание смены</legend><label><span>Дата</span><DatePicker value={endDate} min={startDate} onChange={event => setEndDate(event.target.value)} required /></label><label><span>Время</span><TimeInput value={endTime} onChange={event => setEndTime(event.target.value)} required /></label></fieldset>
            </div>}
            {batch && !shift && <>
              <section className="batch-common" aria-label="Общее время смен">
                <h3>Общее время смен</h3>
                <div className="batch-common__controls">
                  <label><span>Начало</span><TimeInput value={startTime} required onChange={event => changeCommonTime({ startTime: event.target.value })} /></label>
                  <label><span>Окончание</span><TimeInput value={endTime} required onChange={event => changeCommonTime({ endTime: event.target.value })} /></label>
                  <label className="planning-checkbox"><input type="checkbox" checked={commonTime.overnight} onChange={event => changeCommonTime({ overnight: event.target.checked })} /><span>На следующий день</span></label>
                </div>
                <p>Применяется ко всем датам без индивидуальных изменений.</p>
              </section>
              <BatchShiftEditor month={batchMonth} onMonth={setBatchMonth} dates={dates} onDates={changeDates} common={commonTime} overrides={overrides} onOverride={changeOverride} invalidDate={invalidDate} availability={availabilityByDate} />
            </>}
            {previewEnabled && availabilityPreview.isError && <RequestErrorState error={availabilityPreview.error} onRetry={() => void availabilityPreview.refetch()} />}
            {availabilityWarning && <AvailabilityWarningPanel warning={availabilityWarning} agreed={availabilityAgreed} reason={availabilityReason}
              onAgree={() => setAvailabilityAgreement({ token: availabilityWarning.availabilityConfirmation, reason: '' })}
              onReason={value => setAvailabilityAgreement({ token: availabilityWarning.availabilityConfirmation, reason: value })} />}
            {actual
              ? <label className="shift-form__wide"><span>Почему меняется отработанное время</span><textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} rows={3} placeholder="Например: сотрудник закончил смену раньше" required /></label>
              : <label className="shift-form__wide"><span>{batch ? 'Комментарий ко всем сменам' : 'Комментарий к смене'}</span><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} rows={2} placeholder="Например: работа в основном зале" /></label>}
            {!actual && <ProfileDisclosure title="Часы работы точки"><OpeningHoursSummary value={organization.location?.openingHours} /><p className="planning-footnote">Смена вне этих часов требует отдельного подтверждения. Часы можно изменить в настройках организации → Точки → Изменить → Часы работы.</p></ProfileDisclosure>}
            {draft?.published && <section className="draft-response-window">
              <p>Существенная правка запросит повторное ознакомление у затронутых сотрудников.</p>
              <label className="planning-checkbox"><input type="checkbox" checked={confirmWindow} onChange={event => setConfirmWindow(event.target.checked)} /><span>Подтверждаю, что времени для ответа достаточно</span></label>
              <label className="planning-checkbox"><input type="checkbox" checked={extendWindow} disabled={draft.closed} onChange={event => setExtendWindow(event.target.checked)} /><span>{draft.closed ? 'Открыть обсуждение повторно' : 'Продлить срок обсуждения'}</span></label>
              {extendWindow && <div className="planning-time"><label><span>Новый срок · {organization.timezone}</span><DatePicker value={deadlineDate} required onChange={event => setDeadlineDate(event.target.value)} /></label><label><span>Время</span><TimeInput value={deadlineTime} required onChange={event => setDeadlineTime(event.target.value)} /></label></div>}
            </section>}
            {absenceWarning && <label className="planning-checkbox"><input type="checkbox" name="ackAbsence" checked={acknowledgeAbsence} onChange={event => setAcknowledgeAbsence(event.target.checked)} /><span>Подтверждаю назначение смены несмотря на отсутствие сотрудника</span></label>}
            {workloadWarning && <label className="planning-checkbox"><input type="checkbox" name="ackWorkload" checked={acknowledgeWorkload} onChange={event => setAcknowledgeWorkload(event.target.checked)} /><span>Подтверждаю сохранение с превышением месячной нормы</span></label>}
            {openingWarning && <OpeningHoursWarning checked={outsideAccepted} onChange={setOutsideAccepted} />}
            {error && <p className="form-inline-error" role="alert">{error}</p>}
            {!actual && !draft && <ProfileDisclosure title="Причина исправления закрытого табеля"><label><span>Причина изменения</span><textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} rows={2} /><small>Обязательно для изменений в ранее закрытом и повторно открытом периоде.</small></label></ProfileDisclosure>}
          </fieldset>
        </div>
        <footer>
          {batch && !shift && <div className="shift-form__summary"><strong>Смен: {dates.length} · {organization.location?.name ?? organization.name}</strong><span>Все смены будут сохранены вместе</span></div>}
          <div className="shift-form__actions">
            <button className="app-secondary" type="button" disabled={busy} onClick={close}>Отмена</button>
            <button className="app-primary" disabled={submitDisabled}>{busy ? 'Сохраняем…' : actual ? 'Сохранить отработанное время' : shift ? 'Сохранить изменения' : batch ? `Создать ${batchShiftLabel(dates.length)}` : 'Создать смену'}</button>
          </div>
        </footer>
      </form>
    </DocumentDialog>}
  </AnimatedOverlay>
}
