import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import AsyncPanel from '../../../../component/ui/async-panel.tsx'
import { accountedTimeLabel } from '../../../../app/schedule/time/time-correction.ts'
import TimeCorrectionAction from '../time/time-correction-action.tsx'
import MemberProfileLink from '../../../../component/ui/member-profile-link.tsx'
import MemberAvatar from '../../../../component/ui/member-avatar.tsx'
import ActionSurface from '../../../../component/ui/action-surface.tsx'
import DocumentActionsMenu from '../../documents/document-actions-menu.tsx'
import { useTeamSettings, useCoverage } from '../../../../app/schedule/planning/team-planning.ts'
import CoveragePanel, { CoverageIndicator } from '../planning/coverage-panel.tsx'
import { canAccess } from '../../../../app/access/catalog.ts'
import { ShiftOfferForm, ShiftOffersPanel } from '../offers/shift-offers.tsx'
import { useOffers, useOfferSettings } from '../../../../app/schedule/offers.ts'
import Select from '../../../../component/ui/select/select.tsx'
import ScheduleAgenda from './schedule-agenda.tsx'
import ScheduleHistory from './schedule-history.tsx'
import { lazy, Suspense } from 'react'
import { useToast } from '../../../../component/ui/toast/toast-context.ts'
import { absenceNames } from '../../../../app/schedule/absence-format.ts'
import AbsencePanel from '../absences/absence-panel.tsx'
import { invalidateOrganizationWork } from '../../../../app/live-query.ts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useOrganizationMembers, useLocations } from '../../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import { addDays, calendarRange, displayDate, formatDuration, formatMonth, monthKeyInZone, moveMonth, shiftState, shiftsByDate, shiftCoversDate, shiftTimeRange, zonedDateAndTime } from '../../../../app/schedule/date-utils.ts'
import { useSchedule, useShiftDetails } from '../../../../app/schedule/queries.ts'
import type { WorkShift } from '../../../../app/schedule/types.ts'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import ScheduleSectionHeader from '../shared/schedule-section-header.tsx'
import ShiftFormModal from '../shared/shift-form-modal.tsx'
import DaySchedulePanel from './day-schedule-panel.tsx'
import ModuleIcon from '../../../../component/ui/module-icon.tsx'
import '../schedule.scss'
import '../schedule-redesign.scss'

const RequestForm = lazy(() => import('../../requests/requests-page.tsx').then(module => ({ default: module.RequestForm })))

const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const shiftPlural = new Intl.PluralRules('ru')
const shiftWords = { one: 'смена', few: 'смены', many: 'смен', other: 'смен', zero: 'смен', two: 'смены' }

export default function SchedulePage({ organization, historyMode = false }: { organization: OrganizationSummary; historyMode?: boolean }) {
  const [previewTab,setPreviewTab] = useState<'staff'|'demand'>('staff')
  const teamSettings = useTeamSettings(organization.id)
  const [showCoverage, setShowCoverage] = useState(true)
  const coverageEnabled = !historyMode && !!teamSettings.data?.coverageEnabled && canAccess(organization,'coverage.view')
  const offers = useOffers(organization.id)
  const offerSettings = useOfferSettings(organization.id)
  const [offeringShift, setOfferingShift] = useState<WorkShift | null>(null)
  const toast = useToast()
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const canManage = ['schedule.create','schedule.edit','schedule.cancel','schedule.actual'].some(p=>organization.permissions?.includes(p)) || !!organization.owner
  const currentMonth = monthKeyInZone(new Date(), organization.timezone)
  const todayDate = zonedDateAndTime(new Date().toISOString(), organization.timezone).date
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const offersOpen = searchParams.has('offers') || searchParams.has('offer')
  function openOffer(id: string | null = null) {
    setSelectedDate(null)
    setSearchParams(current => { const next = new URLSearchParams(current); next.set('offers', '1'); next.delete('shift'); next.delete('day'); if (id) next.set('offer', id); else next.delete('offer'); return next })
  }
  function closeOffers() { setSearchParams(current => { const next = new URLSearchParams(current); next.delete('offers'); next.delete('offer'); return next }, { replace: true }) }
  const offersEnabled = !!offerSettings.data && (offerSettings.data.transferMode !== 'DISABLED' || offerSettings.data.swapMode !== 'DISABLED')
  const requestId = searchParams.get('returnRequest')
  const returnTab = ['mine', 'incoming', 'history'].includes(searchParams.get('returnTab') ?? '') ? searchParams.get('returnTab')! : 'mine'
  const returnToRequest = requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? '/app/organizations/' + organization.id + '/requests?location=' + (organization.locationId ?? '') + '&tab=' + returnTab + '&request=' + requestId : null
  const requestedMonth = searchParams.get('month')
  const initialMonth = requestedMonth && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : currentMonth
  const [month, setMonth] = useState(initialMonth)
  const [shiftView, setShiftView] = useState<'all' | 'mine'>(searchParams.get('view') === 'mine' ? 'mine' : 'all')
  const [selectedDate, setSelectedDate] = useState<string | null>(searchParams.get('day'))
  const [focusedShiftId, setFocusedShiftId] = useState<string | null>(null)
  const [editing, setEditing] = useState<WorkShift | null>(null)
  const [dayOffShift, setDayOffShift] = useState<WorkShift | null>(null)
  const [adding, setAdding] = useState(false)
  const [cancelling, setCancelling] = useState<WorkShift | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [linkedShift, setLinkedShift] = useState<WorkShift | null>(null)
  const calendarRef = useRef<HTMLDivElement>(null)
  const range = useMemo(() => calendarRange(month, true), [month])
  const coverage = useCoverage(organization.id, range.from, range.to, coverageEnabled)
  const schedule = useSchedule(organization.id, range.from, range.to, historyMode ? 'history' : 'current')
  const calendarShifts = useMemo(() => shiftsByDate((schedule.data?.shifts ?? []).filter(shift => shift.status !== 'CANCELLED'), range.days, organization.timezone), [schedule.data?.shifts, range.days, organization.timezone])
  const members = useOrganizationMembers(organization.id)
  const ownMemberId = organization.viewerMemberId ?? members.data?.members.find((member) => member.userId === user?.id)?.id
  const [calendarView, setCalendarView] = useState<'month' | 'week' | 'day' | 'list'>('month')
  const [previewDate, setPreviewDate] = useState(searchParams.get('day') ?? (initialMonth === currentMonth ? todayDate : `${initialMonth}-01`))
  const points = useLocations(organization.id)
  const visibleShifts = (schedule.data?.shifts ?? []).filter(shift => (historyMode || shift.status !== 'CANCELLED') && (shiftView === 'all' || shift.memberId === ownMemberId))
  const previewShifts = visibleShifts.filter(shift => shiftCoversDate(shift, previewDate, organization.timezone)).sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt))
  const previewAbsences = (schedule.data?.absences ?? []).filter(absence => previewDate >= absence.startDate && previewDate <= absence.endDate && (shiftView === 'all' || absence.memberId === ownMemberId))
  const weekStart = addDays(previewDate, -((new Date(`${previewDate}T00:00:00Z`).getUTCDay() + 6) % 7))
  const displayedDays = calendarView === 'week' ? Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)) : range.days
  useLayoutEffect(() => { setPreviewDate(current => current.startsWith(month) ? current : month === currentMonth ? todayDate : `${month}-01`) }, [month, currentMonth, todayDate])
  const requestedShiftId = searchParams.get('shift')
  const linkedDetails = useShiftDetails(organization.id, requestedShiftId && schedule.data && !schedule.isPlaceholderData && !schedule.data.shifts.some(shift => shift.id === requestedShiftId) ? requestedShiftId : null)
  const visibleAbsences = (schedule.data?.absences ?? []).filter(absence => (shiftView === 'all' || absence.memberId === ownMemberId))
  const selectedShifts = selectedDate ? visibleShifts.filter((shift) => shiftCoversDate(shift, selectedDate, organization.timezone)) : []
  if (selectedDate && linkedShift && shiftCoversDate(linkedShift, selectedDate, organization.timezone) && !selectedShifts.some(shift => shift.id === linkedShift.id)) selectedShifts.unshift(linkedShift)
  const selectedAbsences = selectedDate ? visibleAbsences.filter((absence) => selectedDate >= absence.startDate && selectedDate <= absence.endDate) : []
  const monthHasShifts = visibleShifts.some((shift) => {
    const start = zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date
    const end = zonedDateAndTime(shift.scheduledEndAt, organization.timezone).date
    return start < `${moveMonth(month, 1)}-01` && end >= `${month}-01`
  }) ?? false

  useEffect(() => {
    const shiftId = searchParams.get('shift')
    if (!shiftId || !schedule.data || schedule.isPlaceholderData) return
    const shift = schedule.data.shifts.find((item) => item.id === shiftId) ?? linkedDetails.data?.shift
    if (!shift) return
    setLinkedShift(shift)
    const date = zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date
    setSelectedDate(date); setFocusedShiftId(shiftId); setAdding(false)
    setPreviewDate(date)
    setSearchParams((current) => { const next = new URLSearchParams(current); next.delete('shift'); return next }, { replace: true })
  }, [organization.timezone, schedule.data, schedule.isPlaceholderData, searchParams, setSearchParams, linkedDetails.data])

  useLayoutEffect(() => {
    const nextMonth = searchParams.get('month')
    if (nextMonth && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(nextMonth)) setMonth(nextMonth)
    setShiftView(searchParams.get('view') === 'mine' ? 'mine' : 'all')
  }, [searchParams])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const actualMonth = monthKeyInZone(new Date(), organization.timezone)
      if (month === currentMonth && actualMonth !== currentMonth) setMonth(actualMonth)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [currentMonth, month, organization.timezone])

  function moveCalendarFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -7 : event.key === 'ArrowDown' ? 7 : null
    if (delta === null) return
    const target = calendarRef.current?.querySelectorAll<HTMLButtonElement>('.schedule-day > .staffly-action-surface__open')[index + delta]
    if (target) { event.preventDefault(); target.focus() }
  }

  function changeView(view: 'all' | 'mine') {
    setShiftView(view)
    setSelectedDate(null)
    setLinkedShift(null)
    setFocusedShiftId(null)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (view === 'mine') next.set('view', 'mine'); else next.delete('view')
      next.set('month', month)
      return next
    }, { replace: true })
  }

  function chooseDay(day: string) {
    setSelectedDate(day); setActionError(''); setLinkedShift(null)
    setFocusedShiftId(null)
  }

  function movePeriod(amount: number) {
    if (calendarView === 'month' || calendarView === 'list') { setMonth(moveMonth(month, amount)); return }
    const next = addDays(previewDate, amount * (calendarView === 'week' ? 7 : 1))
    setPreviewDate(next); setMonth(next.slice(0, 7))
  }

  function openPreview(shift?: WorkShift) {
    chooseDay(previewDate)
    if (shift) setFocusedShiftId(shift.id)
  }

  async function cancel(close: () => void) {
    if (!cancelling || cancelReason.trim().length < 3) return
    setBusy(true); setActionError('')
    try {
      await apiRequest(`/organizations/${organization.id}/shifts/${cancelling.id}/cancel`, { method: 'POST', body: { reason: cancelReason } })
      await invalidateOrganizationWork(queryClient, organization.id)
      toast('Смена отменена', 'success')
      close()
    } catch (failure) { setActionError(failure instanceof Error ? failure.message : 'Не удалось отменить смену.') }
    finally { setBusy(false) }
  }

  return <section className="schedule-page schedule-redesign">
    {searchParams.has('absences') && <AbsencePanel organization={organization} focusId={searchParams.get('absence')} onClose={() => setSearchParams(current => { const next = new URLSearchParams(current); next.delete('absences'); next.delete('absence'); return next }, { replace: true })} />}
    {returnToRequest && <Link className="app-back" to={returnToRequest}>Вернуться к заявке</Link>}
    <ScheduleSectionHeader organization={organization} title={historyMode?'История смен':'Расписание'} description={historyMode?'Отменённые смены и история изменений.':'Планирование смен и контроль рабочего времени'}>{!historyMode && <div className="schedule-header-actions"><button className="app-secondary schedule-offers-button" onClick={() => openOffer()}>Предложения смен{!!offers.data && offers.data.counts.mine + offers.data.counts.available + offers.data.counts.approval > 0 && <span className="offer-count">{offers.data.counts.mine + offers.data.counts.available + offers.data.counts.approval}</span>}</button><button className="app-secondary" onClick={() => setSearchParams(current => { const next = new URLSearchParams(current); next.set('absences', '1'); return next })}>Отсутствия</button>{canAccess(organization,'schedule.create')&&<button className="app-primary" onClick={()=>{setSelectedDate(previewDate);setAdding(true)}}>＋ Добавить смену</button>}</div>}</ScheduleSectionHeader>

    {linkedDetails.isError && <p className="app-alert app-alert--error" role="alert">Не удалось открыть смену. Возможно, она больше недоступна.</p>}
    {historyMode ? <ScheduleHistory organization={organization} onShift={shift => { const day = zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date; setSelectedDate(day); setLinkedShift(shift); setFocusedShiftId(shift.id); setActionError('') }} /> : <>
    <div className="schedule-controls"><div className="schedule-toolbar"><button type="button" className="schedule-today" onClick={() => { setMonth(currentMonth); setPreviewDate(todayDate) }}>Сегодня</button><button className="schedule-toolbar__arrow" type="button" aria-label="Предыдущий период" onClick={() => movePeriod(-1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 5-7 7 7 7" /></svg></button><button className="schedule-toolbar__arrow" type="button" aria-label="Следующий период" onClick={() => movePeriod(1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m9 5 7 7-7 7" /></svg></button><h2>{calendarView === 'day' ? displayDate(previewDate) : formatMonth(month)}</h2></div><SegmentedNav className="schedule-mode-switch" label="Вид расписания">{([['month', 'Месяц'], ['week', 'Неделя'], ['day', 'День'], ['list', 'Список']] as const).map(([view, label]) => <button key={view} aria-pressed={calendarView === view} onClick={() => setCalendarView(view)}>{label}</button>)}</SegmentedNav><label className="schedule-point-filter"><span>Точка</span><Select value={organization.locationId ?? ''} onChange={event => { setSearchParams(current => { const next = new URLSearchParams(current); next.set('location', event.target.value); return next }) }}>{points.data?.locations.filter(point => !point.archivedAt).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label><DocumentActionsMenu label="Ещё: настройки календаря" trigger={<><span>Ещё</span><i className={`schedule-display-active${shiftView === 'mine' ? ' is-active' : ''}`} aria-hidden="true" /><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></>} className="schedule-display-options" closeOnSelect={false} closeOnMouseLeave={false}>
        <div className="schedule-display-heading"><strong>Настройки календаря</strong><span>Выберите, что показывать</span></div>
        <label className="schedule-display-row"><span><strong>Только мои смены</strong><small>Скрыть смены остальных сотрудников</small></span><button type="button" className="planning-toggle" role="switch" aria-checked={shiftView === 'mine'} aria-label="Только мои смены" disabled={!ownMemberId} onClick={() => changeView(shiftView === 'mine' ? 'all' : 'mine')}><i /></button></label>
        {coverageEnabled && <section className="schedule-display-coverage"><label className="schedule-display-row"><span><strong>Показывать потребность</strong><small>Отметки покрытия на календаре</small></span><button type="button" className="planning-toggle" role="switch" aria-checked={showCoverage} aria-label="Показывать потребность" onClick={() => setShowCoverage(value => !value)}><i /></button></label><div className="schedule-display-key"><span><i className="demand-dot is-short" />Не хватает сотрудников</span><span><i className="demand-dot is-covered" />Потребность закрыта</span><span><i className="demand-dot is-extra" />Работают сверх потребности</span></div><p>Нажмите дату и откройте «Потребность», чтобы посмотреть должности и время.</p>{canAccess(organization, 'coverage.manage') && <Link to={`/app/organizations/${organization.id}/schedule/demand?location=${organization.locationId}`}>Изменить потребность</Link>}</section>}
      </DocumentActionsMenu></div>

    <AsyncPanel pending={schedule.isLoading || schedule.isPlaceholderData} identity={`${month}:${calendarView}`} minHeight={630} label="Загружаем расписание" pendingContent={calendarView === 'month' || calendarView === 'week' ? <div className="schedule-calendar-skeleton" aria-hidden="true">{weekDays.map(day => <span key={day}>{day}</span>)}{displayedDays.map(day => <div key={day}><i /><i /><i /></div>)}</div> : undefined}>{schedule.isLoading ? <div className="schedule-state"><span className="app-spinner" />Загружаем расписание…</div> : schedule.isError ? <div className="schedule-state"><strong>Не удалось загрузить расписание</strong><p>{schedule.error instanceof Error ? schedule.error.message : 'Попробуйте ещё раз.'}</p><button className="app-secondary" onClick={() => void schedule.refetch()}>Повторить</button></div> : <>
      <div className="schedule-workspace"><div className="schedule-workspace__main" data-view={calendarView}>{calendarView === 'day' || calendarView === 'list' ? <ScheduleAgenda days={calendarView === 'day' ? [previewDate] : range.days.filter(day => day.startsWith(month))} shifts={visibleShifts} timezone={organization.timezone} timeline={calendarView === 'day'} onShift={(day, shift) => { setPreviewDate(day); chooseDay(day); setFocusedShiftId(shift.id) }} /> : <div className={`schedule-calendar-wrap${schedule.isPlaceholderData ? ' is-updating' : ''}`} ref={calendarRef} style={{ '--calendar-weeks': displayedDays.length / 7 } as CSSProperties} aria-busy={schedule.isPlaceholderData}>
        <div className={`schedule-calendar${coverageEnabled && showCoverage ? ' schedule-calendar--coverage' : ''}`} role="group" aria-label={`Календарь: ${formatMonth(month)}`}>
          {weekDays.map(day => <div className="schedule-calendar__weekday" aria-hidden="true" key={day}>{day}</div>)}
          {displayedDays.map((day, index) => {
            // Size the day from the same full dataset in both display filters.
            const dayShifts = calendarShifts.get(day) ?? []
            const shifts = dayShifts.filter(shift => shiftView === 'all' || shift.memberId === ownMemberId).sort((a, b) => Number(b.memberId === ownMemberId) - Number(a.memberId === ownMemberId))
            const absences = visibleAbsences.filter(absence => day >= absence.startDate && day <= absence.endDate)
            const ownCount = dayShifts.filter(shift => shift.memberId === ownMemberId).length
            const previewLimit = calendarView === 'week' ? 6 : 4
            const previews = shifts.slice(0, previewLimit)
            const daySlots = { '--day-shift-slots': Math.min(dayShifts.length, previewLimit), '--day-absence-slot': Number((schedule.data?.absences ?? []).some(absence => day >= absence.startDate && day <= absence.endDate)), '--day-more-slot': Number(dayShifts.length > previewLimit) } as CSSProperties
            const inMonth = day.startsWith(month)
            const today = day === todayDate
            return <ActionSurface type="button" className={`schedule-day${inMonth ? '' : ' schedule-day--outside'}${today ? ' schedule-day--today' : ''}${ownCount ? ' schedule-day--mine' : ''}${day === previewDate ? ' schedule-day--selected' : ''}`} key={day} aria-label={`${displayDate(day)}${today ? ', сегодня' : ''}, смен: ${shifts.length}, ваших: ${ownCount}, отсутствий: ${absences.length}${coverageEnabled&&showCoverage&&coverage.data?.days.find(d=>d.date===day)?.shortageIntervals?', не хватает сотрудников':''}`}  aria-pressed={day === previewDate} aria-current={today ? 'date' : undefined} disabled={schedule.isPlaceholderData} onClick={() => setPreviewDate(day)} onKeyDown={event => moveCalendarFocus(event, index)}>
              <span className="schedule-day__number">{Number(day.slice(-2))}</span>{coverageEnabled && showCoverage && <CoverageIndicator day={coverage.data?.days.find(d=>d.date===day)}/>}
              <span className="schedule-day__shifts" style={daySlots}>{previews.map(shift => { const state = shiftState(shift), mine = shift.memberId === ownMemberId; return <span key={shift.id} className={`schedule-shift-chip schedule-shift-chip--${state.key}${mine ? ' schedule-shift-chip--mine' : ''}`} title={`${shift.memberName} · ${state.label}${shift.activeOffer ? ' · есть предложение' : ''}`}><MemberAvatar memberId={shift.memberId} url={shift.memberAvatarUrl} name={shift.memberName} className="schedule-chip-avatar" /><span className="schedule-chip-copy"><span>{shift.memberName}</span><small>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, organization.timezone)}</small></span>{shift.activeOffer && <span className="offer-chip-indicator" title="Смена участвует в предложении" aria-label="Смена участвует в предложении">⇄</span>}</span> })}{absences.length > 0 && <small className="schedule-day__absence">{absences.some(item => item.memberId === ownMemberId) ? 'Вы отсутствуете' : `Отсутствуют: ${absences.length}`}</small>}{shifts.length > previews.length && <small className="schedule-day__more">+{shifts.length - previews.length}</small>}</span>
              <span className="schedule-day__mobile">
                {shifts[0] && <span className="schedule-day__faces"><MemberAvatar memberId={shifts[0].memberId} url={shifts[0].memberAvatarUrl} name={shifts[0].memberName} className="schedule-chip-avatar" /></span>}
                {shifts.length > 0 && <span className="schedule-day__count"><strong>{shifts.length}</strong><span>{shiftWords[shiftPlural.select(shifts.length)]}</span></span>}
                {ownCount > 0 && <strong className="schedule-day__own" title={`Ваших смен: ${ownCount}`}>Вы{ownCount > 1 ? `: ${ownCount}` : ''}</strong>}
                {absences.length > 0 && <small className="schedule-day__away" title={`Отсутствуют: ${absences.length}${absences.some(item => item.memberId === ownMemberId) ? ', в том числе вы' : ''}`}>{absences.some(item => item.memberId === ownMemberId) ? 'Нет вас' : 'Отс.'}</small>}
              </span>
            </ActionSurface>
          })}
        </div><span className="schedule-calendar-loading">Обновляем месяц…</span>
      </div>}</div><aside className="schedule-day-preview" aria-label="Смены выбранного дня"><header><h2>{displayDate(previewDate)}</h2><span>Смен: {previewShifts.length} · {organization.location?.name}</span></header>{schedule.isPlaceholderData ? <p className="schedule-preview-empty">Обновляем смены…</p> : <>{coverageEnabled&&showCoverage&&<div className="schedule-preview-tabs"><button aria-pressed={previewTab==='staff'} onClick={()=>setPreviewTab('staff')}>Смены · {previewShifts.length}</button><button aria-pressed={previewTab==='demand'} onClick={()=>setPreviewTab('demand')}>Потребность</button></div>}<div className="schedule-preview-body">{coverageEnabled&&showCoverage&&previewTab==='demand'?<CoveragePanel day={coverage.data?.days.find(d=>d.date===previewDate)} timezone={organization.timezone} loading={coverage.isLoading} error={coverage.error?.message}/>:<div className="schedule-preview-list">{previewShifts.map(shift => { const state = shiftState(shift); return <ActionSurface aria-label={`Открыть смену ${shift.memberName}`} className={`schedule-preview-shift schedule-preview-shift--${state.key}`} key={shift.id} onClick={() => openPreview(shift)}><strong>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, organization.timezone)}</strong><span className="schedule-preview-person"><MemberAvatar memberId={shift.memberId} url={shift.memberAvatarUrl} name={shift.memberName} className="app-avatar" /><span><MemberProfileLink memberId={shift.memberId}><strong>{shift.memberName}</strong></MemberProfileLink><small>{shift.positionName ?? 'Без должности'} · {formatDuration(shift.effectiveMinutes)}</small></span></span><small>{state.label}{shift.memberId === ownMemberId ? ' · ваша смена' : ''}</small>{(shift.actualStartAt || shift.actualEndAt || shift.attendance === 'NO_SHOW') && <small>Учтено: {accountedTimeLabel(shift, organization.timezone)}</small>}<TimeCorrectionAction shift={shift} />{shift.activeOffer && <small className="offer-calendar-badge">{shift.activeOffer.status === 'AWAITING_APPROVAL' ? 'На согласовании' : shift.activeOffer.kind === 'SWAP' ? 'Предложен обмен' : 'Предложена передача'}</small>}</ActionSurface> })}{previewAbsences.map(absence => <ActionSurface aria-label={`Открыть отсутствие ${absence.memberName}`} key={absence.id} className="schedule-preview-absence" onClick={() => openPreview()}><MemberProfileLink memberId={absence.memberId}><strong>{absence.memberName}</strong></MemberProfileLink><span>{absenceNames[absence.type]}</span></ActionSurface>)}{!previewShifts.length && !previewAbsences.length && <p className="schedule-preview-empty">На этот день смен и отсутствий нет.</p>}</div>}</div><footer><button className="app-secondary" onClick={() => openPreview()}>Подробнее о дне </button></footer></>}</aside></div>
      <p className="schedule-mobile-hint">Нажмите дату, чтобы увидеть сотрудников и потребность. Ваши смены выделены фоном.</p>
      <div className="schedule-legend"><span><i className="future" />Запланирована</span><span><i className="active" />Идёт сейчас</span><span><i className="completed" />Завершена</span><span className="schedule-legend__mine"><i />Мои смены</span><small>Часовой пояс: {organization.timezone}</small></div>
      {!monthHasShifts && <div className="schedule-empty"><h3>{shiftView === 'mine' ? 'У вас нет смен в этом месяце' : historyMode ? 'За этот месяц истории смен нет' : 'На этот месяц смен пока нет'}</h3><p>{shiftView === 'mine' ? 'Переключитесь на все смены или выберите другой месяц.' : historyMode ? 'Выберите другой месяц, чтобы посмотреть отменённые смены.' : canManage ? 'Выберите день и нажмите «Добавить смену», чтобы составить график.' : 'Когда администратор составит график, смены появятся здесь.'}</p></div>}
    </>}</AsyncPanel>

    </>}

    {offersOpen && <ShiftOffersPanel organization={organization} offerId={searchParams.get('offer')} onOffer={id => openOffer(id)} onClose={closeOffers} />}
    {offeringShift && <ShiftOfferForm organization={organization} shift={offeringShift} onClose={() => setOfferingShift(null)} onCreated={id => openOffer(id)} />}
    {dayOffShift && <AnimatedOverlay variant="modal" onClose={() => setDayOffShift(null)}>{close => <Suspense fallback={<div className="route-loading" role="status">Загрузка формы…</div>}><RequestForm organization={organization} initialSystemCode="DAY_OFF" initialShiftId={dayOffShift.id} onClose={close} /></Suspense>}</AnimatedOverlay>}
    {selectedDate && !adding && !editing && !offersOpen && !offeringShift && !searchParams.has('absences') && <AnimatedOverlay variant="modal" className="day-schedule-overlay" onClose={() => { setSelectedDate(null); setFocusedShiftId(null); setLinkedShift(null); if (returnToRequest) navigate(returnToRequest, { replace: true }) }}>{close => <DaySchedulePanel
      key={selectedDate}
      date={selectedDate}
      timezone={organization.timezone}
      locationName={organization.location?.name ?? points.data?.locations.find(point => point.id === organization.locationId)?.name}
      locationId={organization.locationId}
      shifts={selectedShifts}
      absences={selectedAbsences.map(absence => ({ ...absence, memberAvatarUrl: absence.memberAvatarUrl ?? members.data?.members.find(member => member.id === absence.memberId)?.avatarUrl }))}
      ownMemberId={ownMemberId}
      focusedShiftId={focusedShiftId}
      historical={linkedShift?.status === 'CANCELLED'}
      coverage={coverageEnabled ? <CoveragePanel day={coverage.data?.days.find(day => day.date === selectedDate)} timezone={organization.timezone} loading={coverage.isLoading} error={coverage.error?.message} /> : undefined}
      canOpenAbsence={absence => canManage || absence.memberId === ownMemberId}
      onAbsence={absence => setSearchParams(current => { const next = new URLSearchParams(current); next.set('absences', '1'); next.set('absence', absence.id); return next })}
      onClose={close}
      actions={!historyMode && <>
        {canAccess(organization,'schedule.create') && <button type="button" className="app-primary" onClick={() => setAdding(true)}><span aria-hidden="true">＋</span>Добавить смену</button>}
        {canAccess(organization,'requests.create') && !canManage && selectedDate >= todayDate && <Link className="app-primary" to={'/app/organizations/' + organization.id + '/requests?tab=mine&proposeShift=1&proposalDate=' + selectedDate}>Предложить свою смену</Link>}
        {canAccess(organization,'staffing.create') && <Link className="app-secondary" to={`/app/organizations/${organization.id}/requests?location=${organization.locationId ?? ''}&tab=staffing&staffing=1&proposalDate=${selectedDate}`}><ModuleIcon section="employees" />Создать заявку на подмену</Link>}
      </>}
      renderShiftActions={shift => {
        const state = shiftState(shift), mine = shift.memberId === ownMemberId
        return <>
          {shift.activeOffer && <button type="button" className="offer-shift-badge" onClick={() => openOffer(shift.activeOffer!.id)}>{shift.activeOffer.status === 'AWAITING_APPROVAL' ? 'Ожидает согласования' : shift.activeOffer.kind === 'SWAP' ? 'Предложен обмен' : 'Предложена передача'}</button>}
          {mine && (canAccess(organization,'offers.transfer') || canAccess(organization,'offers.swap')) && state.key === 'future' && !shift.activeOffer && <button type="button" className="app-secondary" disabled={!offersEnabled || !!shift.actualStartAt || !!shift.actualEndAt || shift.actualBreakMinutes !== null} title={!offersEnabled ? 'Передача и обмен выключены владельцем' : undefined} onClick={() => { setSelectedDate(null); setOfferingShift(shift) }}>Передать или обменять</button>}
          {mine && canAccess(organization,'requests.create') && state.key === 'future' && <button type="button" className="app-secondary" onClick={() => { setSelectedDate(null); setDayOffShift(shift) }}>Взять отгул</button>}
          {mine && canAccess(organization,'requests.create') && !canManage && state.key === 'future' && <Link className="app-secondary" to={'/app/organizations/' + organization.id + '/requests?tab=mine&changeShift=' + shift.id}>Попросить изменить смену</Link>}
          {canManage && shift.status !== 'CANCELLED' && <>
            <TimeCorrectionAction shift={shift} locationId={organization.locationId} icon />
            {canAccess(organization,'schedule.edit') && state.key !== 'completed' && <button type="button" className="app-secondary" onClick={() => setEditing(shift)}>Изменить расписание</button>}
            {canAccess(organization,'schedule.cancel') && <button type="button" className="schedule-cancel-button" onClick={() => { setCancelling(shift); setCancelReason(''); setActionError('') }}>Отменить смену</button>}
          </>}
        </>
      }}
    />}</AnimatedOverlay>}

    {(adding || editing) && selectedDate && <ShiftFormModal organization={organization} members={members.data?.members ?? []} date={selectedDate} shift={editing} onClose={() => { setAdding(false); setEditing(null); setSelectedDate(null); if (returnToRequest) navigate(returnToRequest, { replace: true }) }} />}
    {cancelling && <AnimatedOverlay variant="modal" onClose={() => { setCancelling(null); setCancelReason('') }}>{(close) => <div className="cancel-shift-modal"><p className="app-eyebrow">Отмена смены</p><h2>Отменить смену {cancelling.memberName}?</h2><p>Смена останется в истории и перестанет учитываться в рабочем времени.</p><label><span>Причина отмены</span><textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} maxLength={500} rows={3} autoFocus /></label>{actionError && <p className="form-inline-error">{actionError}</p>}<footer><button className="app-secondary" disabled={busy} onClick={close}>Назад</button><button className="app-danger" disabled={busy || cancelReason.trim().length < 3} onClick={() => void cancel(close)}>{busy ? 'Отменяем…' : 'Отменить смену'}</button></footer></div>}</AnimatedOverlay>}

  </section>
}
