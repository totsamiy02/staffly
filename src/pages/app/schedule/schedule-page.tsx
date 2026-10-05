import EmployeePicker from './employee-picker.tsx'
import Select from '../../../component/ui/select/select.tsx'
import { useSchedulePlanning } from '../../../app/schedule/planning.ts'
import ScheduleAgenda from './schedule-agenda.tsx'
import ScheduleHistory from './schedule-history.tsx'
import { RequestForm } from '../requests/requests-page.tsx'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import { absenceNames } from '../../../app/schedule/absence-format.ts'
import AbsencePanel from './absence-panel.tsx'
import { invalidateOrganizationWork } from '../../../app/live-query.ts'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useOrganizationMembers, useLocations } from '../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { addDays, calendarRange, displayDate, formatDuration, formatMonth, monthKeyInZone, moveMonth, shiftState, shiftCoversDate, shiftTimeRange, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { useSchedule, useShiftDetails } from '../../../app/schedule/queries.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'
import MyShiftsDrawer from './my-shifts-drawer.tsx'
import AnimatedOverlay from './animated-overlay.tsx'
import ScheduleTabs from './schedule-tabs.tsx'
import ShiftFormModal from './shift-form-modal.tsx'
import './schedule.scss'
import './schedule-redesign.scss'

const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']


function MyShiftIcon() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="6" r="3" /><path d="M4 17v-2a6 6 0 0 1 12 0v2" /></svg>
}

export default function SchedulePage({ organization, historyMode = false }: { organization: OrganizationSummary; historyMode?: boolean }) {
  const toast = useToast()
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const canManage = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const currentMonth = monthKeyInZone(new Date(), organization.timezone)
  const todayDate = zonedDateAndTime(new Date().toISOString(), organization.timezone).date
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
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
  const [actual, setActual] = useState<WorkShift | null>(null)
  const [adding, setAdding] = useState(false)
  const [cancelling, setCancelling] = useState<WorkShift | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [myShiftsOpen, setMyShiftsOpen] = useState(false)
  const [linkedShift, setLinkedShift] = useState<WorkShift | null>(null)
  const calendarRef = useRef<HTMLDivElement>(null)
  const range = useMemo(() => calendarRange(month), [month])
  const schedule = useSchedule(organization.id, range.from, range.to, historyMode ? 'history' : 'current')
  const members = useOrganizationMembers(organization.id)
  const ownMemberId = organization.viewerMemberId ?? members.data?.members.find((member) => member.userId === user?.id)?.id
  const [employeeId, setEmployeeId] = useState('')
  const [calendarView, setCalendarView] = useState<'month' | 'week' | 'day' | 'list'>('month')
  const [previewDate, setPreviewDate] = useState(searchParams.get('day') ?? (initialMonth === currentMonth ? todayDate : `${initialMonth}-01`))
  const [positionId, setPositionId] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [listOrder, setListOrder] = useState<'asc' | 'desc'>('asc')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const points = useLocations(organization.id)
  const planning = useSchedulePlanning(organization.id)
  const visibleShifts = (schedule.data?.shifts ?? []).filter(shift => (historyMode || shift.status !== 'CANCELLED') && (!employeeId || shift.memberId === employeeId) && (shiftView === 'all' || shift.memberId === ownMemberId) && (!positionId || shift.positionId === positionId) && (!stateFilter || shiftState(shift).key === stateFilter))
  const previewShifts = visibleShifts.filter(shift => shiftCoversDate(shift, previewDate, organization.timezone)).sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt))
  const previewAbsences = (schedule.data?.absences ?? []).filter(absence => previewDate >= absence.startDate && previewDate <= absence.endDate && (!employeeId || absence.memberId === employeeId) && (shiftView === 'all' || absence.memberId === ownMemberId))
  const weekStart = addDays(previewDate, -((new Date(`${previewDate}T00:00:00Z`).getUTCDay() + 6) % 7))
  const displayedDays = calendarView === 'week' ? Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)) : range.days
  useEffect(() => { setPreviewDate(current => current.startsWith(month) ? current : month === currentMonth ? todayDate : `${month}-01`) }, [month, currentMonth, todayDate])
  const requestedShiftId = searchParams.get('shift')
  const linkedDetails = useShiftDetails(organization.id, requestedShiftId && schedule.data && !schedule.isPlaceholderData && !schedule.data.shifts.some(shift => shift.id === requestedShiftId) ? requestedShiftId : null)
  const visibleAbsences = (schedule.data?.absences ?? []).filter(absence => (!employeeId || absence.memberId === employeeId) && (shiftView === 'all' || absence.memberId === ownMemberId))
  const selectedShifts = selectedDate ? visibleShifts.filter((shift) => shiftCoversDate(shift, selectedDate, organization.timezone)) : []
  if (selectedDate && linkedShift && shiftCoversDate(linkedShift, selectedDate, organization.timezone) && !selectedShifts.some(shift => shift.id === linkedShift.id)) selectedShifts.unshift(linkedShift)
  const focusedShiftVisible = selectedShifts.some((shift) => shift.id === focusedShiftId)
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

  useEffect(() => {
    if (!focusedShiftId || !selectedDate || !focusedShiftVisible) return
    const frame = window.requestAnimationFrame(() => document.getElementById(`day-shift-${focusedShiftId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    return () => window.cancelAnimationFrame(frame)
  }, [focusedShiftId, focusedShiftVisible, selectedDate])

  useEffect(() => {
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
    const target = calendarRef.current?.querySelectorAll<HTMLButtonElement>('.schedule-day')[index + delta]
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
    <header className="schedule-heading"><div><h1>{historyMode ? 'История смен' : 'Расписание'}</h1><p>{historyMode ? 'Отменённые смены и подробности их истории.' : 'Планирование смен и контроль рабочего времени'}</p></div>{!historyMode && <div className="schedule-header-actions"><button className="app-secondary" onClick={() => setSearchParams(current => { const next = new URLSearchParams(current); next.set('absences', '1'); return next })}>Отсутствия</button><button className="app-secondary schedule-my-shifts-button" onClick={() => setMyShiftsOpen(true)}>Мои смены</button>{canManage && <button className="app-primary" onClick={() => { setSelectedDate(previewDate); setAdding(true) }}><span aria-hidden="true">+</span> Добавить смену</button>}</div>}</header>
    <ScheduleTabs organization={organization} />
    {linkedDetails.isError && <p className="app-alert app-alert--error" role="alert">Не удалось открыть смену. Возможно, она больше недоступна.</p>}
    {historyMode ? <ScheduleHistory organization={organization} onShift={shift => { const day = zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date; setSelectedDate(day); setLinkedShift(shift); setFocusedShiftId(shift.id); setActionError('') }} /> : <>
    <div className={`schedule-controls${filtersOpen ? ' schedule-controls--expanded' : ''}`}><div className="schedule-toolbar"><button type="button" className="schedule-today" onClick={() => { setMonth(currentMonth); setPreviewDate(todayDate) }}>Сегодня</button><button className="schedule-toolbar__arrow" type="button" aria-label="Предыдущий период" onClick={() => movePeriod(-1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 5-7 7 7 7" /></svg></button><button className="schedule-toolbar__arrow" type="button" aria-label="Следующий период" onClick={() => movePeriod(1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m9 5 7 7-7 7" /></svg></button><h2>{calendarView === 'day' ? displayDate(previewDate) : formatMonth(month)}</h2></div><div className="schedule-mode-switch" aria-label="Вид расписания">{([['month', 'Месяц'], ['week', 'Неделя'], ['day', 'День'], ['list', 'Список']] as const).map(([view, label]) => <button key={view} aria-pressed={calendarView === view} onClick={() => setCalendarView(view)}>{label}</button>)}</div><button className="schedule-filter-toggle app-secondary" aria-expanded={filtersOpen} aria-controls="schedule-extra-filters" onClick={() => setFiltersOpen(value => !value)}>Фильтры{employeeId || positionId || stateFilter || shiftView !== 'all' ? ' · активны' : ''}</button><label className="schedule-point-filter"><span>Точка</span><Select value={organization.locationId ?? ''} onChange={event => { setEmployeeId(''); setPositionId(''); setSearchParams(current => { const next = new URLSearchParams(current); next.set('location', event.target.value); return next }) }}>{points.data?.locations.filter(point => !point.archivedAt).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label><div className="schedule-member-filter"><EmployeePicker members={members.data?.members ?? []} value={employeeId} onChange={setEmployeeId} required={false} emptyLabel="Все сотрудники" /></div></div>
    <div id="schedule-extra-filters" className={`schedule-filter-bar${filtersOpen ? ' schedule-filter-bar--expanded' : ''}`}><div className="schedule-view-switch" aria-label="Какие смены показывать"><button className={shiftView === 'all' ? 'active' : ''} onClick={() => changeView('all')}>Все смены</button><button className={shiftView === 'mine' ? 'active' : ''} onClick={() => changeView('mine')}>Только мои</button></div><Select aria-label="Должность" value={positionId} onChange={event => setPositionId(event.target.value)}><option value="">Все должности</option>{planning.data?.positions.filter(position => position.isActive).map(position => <option key={position.id} value={position.id}>{position.name}</option>)}</Select><Select aria-label="Статус смены" value={stateFilter} onChange={event => setStateFilter(event.target.value)}><option value="">Все статусы</option>{historyMode ? <option value="cancelled">Отменённые</option> : <><option value="future">Запланированные</option><option value="active">Идут сейчас</option><option value="completed">Завершённые</option></>}</Select>{calendarView === 'list' && <Select aria-label="Порядок списка" value={listOrder} onChange={event => setListOrder(event.target.value as 'asc' | 'desc')}><option value="asc">Сначала ранние даты</option><option value="desc">Сначала поздние даты</option></Select>}{(employeeId || positionId || stateFilter || shiftView !== 'all') && <button className="schedule-reset-filters" onClick={() => { setEmployeeId(''); setPositionId(''); setStateFilter(''); changeView('all') }}>Сбросить фильтры</button>}</div>

    {schedule.isLoading ? <div className="schedule-state"><span className="app-spinner" />Загружаем расписание…</div> : schedule.isError ? <div className="schedule-state"><strong>Не удалось загрузить расписание</strong><p>{schedule.error instanceof Error ? schedule.error.message : 'Попробуйте ещё раз.'}</p><button className="app-secondary" onClick={() => void schedule.refetch()}>Повторить</button></div> : <>
      <div className="schedule-workspace"><div className="schedule-workspace__main" key={calendarView}>{calendarView === 'day' || calendarView === 'list' ? <ScheduleAgenda days={calendarView === 'day' ? [previewDate] : range.days.filter(day => day.startsWith(month))} shifts={visibleShifts} timezone={organization.timezone} timeline={calendarView === 'day'} order={listOrder} onShift={(day, shift) => { setPreviewDate(day); chooseDay(day); setFocusedShiftId(shift.id) }} /> : <div className={`schedule-calendar-wrap${schedule.isPlaceholderData ? ' is-updating' : ''}`} ref={calendarRef} style={{ '--calendar-weeks': displayedDays.length / 7 } as CSSProperties} aria-busy={schedule.isPlaceholderData}>
        <div className="schedule-calendar" role="group" aria-label={`Календарь: ${formatMonth(month)}`}>
          {weekDays.map(day => <div className="schedule-calendar__weekday" aria-hidden="true" key={day}>{day}</div>)}
          {displayedDays.map((day, index) => {
            const shifts = visibleShifts.filter(shift => shiftCoversDate(shift, day, organization.timezone)).sort((a, b) => Number(b.memberId === ownMemberId) - Number(a.memberId === ownMemberId))
            const absences = visibleAbsences.filter(absence => day >= absence.startDate && day <= absence.endDate)
            const ownCount = shifts.filter(shift => shift.memberId === ownMemberId).length
            const previews = shifts.slice(0, calendarView === 'week' ? 6 : 2)
            const inMonth = day.startsWith(month)
            const today = day === todayDate
            return <button type="button" className={`schedule-day${inMonth ? '' : ' schedule-day--outside'}${today ? ' schedule-day--today' : ''}${ownCount ? ' schedule-day--mine' : ''}${day === previewDate ? ' schedule-day--selected' : ''}`} key={day} aria-label={`${displayDate(day)}${today ? ', сегодня' : ''}, смен: ${shifts.length}, ваших: ${ownCount}, отсутствий: ${absences.length}`} aria-pressed={day === previewDate} aria-current={today ? 'date' : undefined} disabled={schedule.isPlaceholderData} onClick={() => setPreviewDate(day)} onKeyDown={event => moveCalendarFocus(event, index)}>
              <span className="schedule-day__number">{Number(day.slice(-2))}</span>
              <span className="schedule-day__shifts">{previews.map(shift => { const state = shiftState(shift), mine = shift.memberId === ownMemberId; return <span key={shift.id} className={`schedule-shift-chip schedule-shift-chip--${state.key}${mine ? ' schedule-shift-chip--mine' : ''}`} title={`${shift.memberName} · ${state.label}`}><Avatar url={shift.memberAvatarUrl} name={shift.memberName} className="schedule-chip-avatar" /><small>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, organization.timezone)}</small>{mine && <MyShiftIcon />}</span> })}{absences.length > 0 && <small className="schedule-day__absence">{absences.some(item => item.memberId === ownMemberId) ? 'Вы отсутствуете' : `Отсутствуют: ${absences.length}`}</small>}{shifts.length > previews.length && <small className="schedule-day__more">+{shifts.length - previews.length}</small>}</span>
              <span className="schedule-day__mobile">{ownCount > 0 ? <strong><MyShiftIcon />Вы{ownCount > 1 ? `: ${ownCount}` : ''}</strong> : shifts.length > 0 ? <span>{shifts.length} смен.</span> : absences.length > 0 ? <span>Отсут.</span> : null}{absences.some(item => item.memberId === ownMemberId) && shifts.length > 0 && <small>Вы отсутствуете</small>}{ownCount > 0 && shifts.length > ownCount && <small>Всего {shifts.length}</small>}</span>
            </button>
          })}
        </div><span className="schedule-calendar-loading">Обновляем месяц…</span>
      </div>}</div><aside className="schedule-day-preview" aria-label="Смены выбранного дня"><header><h2>{displayDate(previewDate)}</h2><span>Смен: {previewShifts.length} · {organization.location?.name}</span></header>{schedule.isPlaceholderData ? <p className="schedule-preview-empty">Обновляем смены…</p> : <><div className="schedule-preview-list">{previewShifts.map(shift => { const state = shiftState(shift); return <button className={`schedule-preview-shift schedule-preview-shift--${state.key}`} key={shift.id} onClick={() => openPreview(shift)}><strong>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, organization.timezone)}</strong><span className="schedule-preview-person"><Avatar url={shift.memberAvatarUrl} name={shift.memberName} className="app-avatar" /><span><strong>{shift.memberName}</strong><small>{shift.positionName ?? 'Без должности'} · {formatDuration(shift.effectiveMinutes)}</small></span></span><small>{state.label}{shift.memberId === ownMemberId ? ' · ваша смена' : ''}</small></button> })}{previewAbsences.map(absence => <button key={absence.id} className="schedule-preview-absence" onClick={() => openPreview()}><strong>{absence.memberName}</strong><span>{absenceNames[absence.type]}</span></button>)}{!previewShifts.length && !previewAbsences.length && <p className="schedule-preview-empty">На этот день смен и отсутствий нет.</p>}</div><footer><button className="app-secondary" onClick={() => openPreview()}>Подробнее о дне <span aria-hidden="true">↗</span></button>{canManage && !historyMode && <button className="app-primary" onClick={() => { setSelectedDate(previewDate); setAdding(true) }}>+ Добавить смену</button>}</footer></>}</aside></div>
      <p className="schedule-mobile-hint">Вы — ваша смена. Нажмите на дату, чтобы увидеть время и сотрудников.</p>
      <div className="schedule-legend"><span><i className="future" />Запланирована</span><span><i className="active" />Идёт сейчас</span><span><i className="completed" />Завершена</span><span className="schedule-legend__mine"><MyShiftIcon />Моя смена · выделена рамкой</span><small>Часовой пояс: {organization.timezone}</small></div>
      {!monthHasShifts && <div className="schedule-empty"><h3>{shiftView === 'mine' ? 'У вас нет смен в этом месяце' : historyMode ? 'За этот месяц истории смен нет' : 'На этот месяц смен пока нет'}</h3><p>{shiftView === 'mine' ? 'Переключитесь на все смены или выберите другой месяц.' : historyMode ? 'Выберите другой месяц, чтобы посмотреть отменённые смены.' : canManage ? 'Выберите день и нажмите «Добавить смену», чтобы составить график.' : 'Когда администратор составит график, смены появятся здесь.'}</p></div>}
    </>}

    </>}

    {dayOffShift && <AnimatedOverlay variant="modal" onClose={() => setDayOffShift(null)}>{close => <RequestForm organization={organization} initialSystemCode="DAY_OFF" initialShiftId={dayOffShift.id} onClose={close} />}</AnimatedOverlay>}
    {selectedDate && !adding && !editing && !actual && !myShiftsOpen && !searchParams.has('absences') && <AnimatedOverlay variant="drawer" onClose={() => { setSelectedDate(null); setFocusedShiftId(null); setLinkedShift(null); if (returnToRequest) navigate(returnToRequest, { replace: true }) }}>{(close) => <aside className="schedule-drawer" role="dialog" aria-modal="true" aria-labelledby="day-title"><header><div><p className="app-eyebrow">{linkedShift?.status === 'CANCELLED' ? 'История смены' : 'Расписание на день'}</p><h2 id="day-title">{displayDate(selectedDate)}</h2><p>{selectedShifts.length ? `${selectedShifts.length} ${selectedShifts.length === 1 ? 'смена' : 'смены'}` : 'Свободный день'}</p></div><button aria-label="Закрыть" onClick={close}>×</button></header><div className="schedule-drawer__list">
      {!selectedShifts.length && !selectedAbsences.length && <div className="schedule-drawer__empty">На этот день смен и отсутствий нет.</div>}
      {selectedAbsences.map((absence) => <article className="day-absence" key={absence.id}><div className="absence-person"><Avatar url={absence.memberAvatarUrl ?? members.data?.members.find(member => member.id === absence.memberId)?.avatarUrl} name={absence.memberName} className="statistics-avatar" /><strong>{absence.memberName}</strong></div><span>{absenceNames[absence.type]}</span><small>{displayDate(absence.startDate)} — {displayDate(absence.endDate)}</small>{(canManage || absence.memberId === ownMemberId) && <button className="app-secondary" onClick={() => setSearchParams(current => { const next = new URLSearchParams(current); next.set('absences', '1'); next.set('absence', absence.id); return next })}>Открыть отсутствие</button>}</article>)}
      {canManage && !historyMode && <Link className="app-secondary" to={`/app/organizations/${organization.id}/requests?location=${organization.locationId}&tab=staffing&staffing=1&proposalDate=${selectedDate}`}>Нужен сотрудник на подмену</Link>}
      {selectedShifts.map((shift) => { const state = shiftState(shift); const mine = shift.memberId === ownMemberId; return <article id={`day-shift-${shift.id}`} className={`day-shift day-shift--${state.key}${mine ? ' day-shift--mine' : ''}${focusedShiftId === shift.id ? ' day-shift--focused' : ''}`} key={shift.id}><div className="day-shift__heading"><Avatar url={shift.memberAvatarUrl} name={shift.memberName} className="day-shift__avatar" /><div><strong>{mine ? `${shift.memberName} · ваша смена` : shift.memberName}</strong><small>{state.label}{shift.adjusted ? ' · время изменено' : ''}</small></div></div><div className="day-shift__time"><strong>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, organization.timezone)}</strong><span>{formatDuration(shift.effectiveMinutes)}</span></div>{shift.positionName && <p>Должность: {shift.positionName}</p>}{shift.description && <p>{shift.description}</p>}{shift.cancellationReason && <p>Причина отмены: {shift.cancellationReason}</p>}{mine && !canManage && state.key === 'future' && <footer><button className="app-secondary" onClick={() => { setSelectedDate(null); setDayOffShift(shift) }}>Взять отгул</button><Link className="app-secondary" to={'/app/organizations/' + organization.id + '/requests?tab=mine&changeShift=' + shift.id}>Попросить изменить смену</Link></footer>}{canManage && shift.status !== 'CANCELLED' && <footer>{mine && state.key === 'future' && <button className="app-secondary" onClick={() => { setSelectedDate(null); setDayOffShift(shift) }}>Взять отгул</button>}{state.key === 'completed' ? <button className="app-secondary" onClick={() => setActual(shift)}>Уточнить отработанное время</button> : <button className="app-secondary" onClick={() => setEditing(shift)}>Изменить расписание</button>}<button className="schedule-cancel-button" onClick={() => { setCancelling(shift); setCancelReason(''); setActionError('') }}>Отменить смену</button></footer>}</article> })}
    </div>{!historyMode && !canManage && selectedDate >= todayDate && <Link className="app-primary schedule-drawer__add" to={'/app/organizations/' + organization.id + '/requests?tab=mine&proposeShift=1&proposalDate=' + selectedDate}>Предложить свою смену на эту дату</Link>}{!historyMode && canManage && <button className="app-primary schedule-drawer__add"  onClick={() => setAdding(true)}>Добавить смену на эту дату</button>}</aside>}</AnimatedOverlay>}

    {(adding || editing || actual) && selectedDate && <ShiftFormModal organization={organization} members={members.data?.members ?? []} date={selectedDate} shift={editing ?? actual} actual={Boolean(actual)} onClose={() => { setAdding(false); setEditing(null); setActual(null); setSelectedDate(null); if (returnToRequest) navigate(returnToRequest, { replace: true }) }} />}
    {cancelling && <AnimatedOverlay variant="modal" onClose={() => { setCancelling(null); setCancelReason('') }}>{(close) => <div className="cancel-shift-modal"><p className="app-eyebrow">Отмена смены</p><h2>Отменить смену {cancelling.memberName}?</h2><p>Смена останется в истории и перестанет учитываться в рабочем времени.</p><label><span>Причина отмены</span><textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} maxLength={500} rows={3} autoFocus /></label>{actionError && <p className="form-inline-error">{actionError}</p>}<footer><button className="app-secondary" disabled={busy} onClick={close}>Назад</button><button className="app-danger" disabled={busy || cancelReason.trim().length < 3} onClick={() => void cancel(close)}>{busy ? 'Отменяем…' : 'Отменить смену'}</button></footer></div>}</AnimatedOverlay>}
    {myShiftsOpen && <MyShiftsDrawer organization={organization} initialMonth={month} onClose={() => setMyShiftsOpen(false)} onShift={(id, selectedMonth) => {
      setMonth(selectedMonth)
      setSearchParams(current => { const next = new URLSearchParams(current); next.set('view', 'mine'); next.set('month', selectedMonth); next.set('shift', id); return next }, { replace: true })
    }} />}
  </section>
}
