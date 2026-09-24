import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useOrganizationMembers } from '../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { addDays, calendarRange, displayDate, formatDuration, formatMonth, formatTime, monthKeyInZone, moveMonth, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { useMyUpcomingShifts, useSchedule } from '../../../app/schedule/queries.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'
import AnimatedOverlay from './animated-overlay.tsx'
import ScheduleTabs from './schedule-tabs.tsx'
import ShiftFormModal from './shift-form-modal.tsx'
import './schedule.scss'

const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const absenceNames = { VACATION: 'Отпуск', DAY_OFF: 'Отгул', SICK_LEAVE: 'Больничный', ABSENCE: 'Отсутствие' } as const

function shiftCoversDate(shift: WorkShift, day: string, timezone: string) {
  const start = zonedDateAndTime(shift.scheduledStartAt, timezone)
  const end = zonedDateAndTime(shift.scheduledEndAt, timezone)
  const lastDay = end.time === '00:00' && end.date !== start.date ? addDays(end.date, -1) : end.date
  return day >= start.date && day <= lastDay
}

function shiftState(shift: WorkShift) {
  if (shift.status === 'CANCELLED') return { key: 'cancelled', label: 'Отменена' }
  const now = Date.now()
  const start = new Date(shift.actualStartAt ?? shift.scheduledStartAt).getTime()
  const end = new Date(shift.actualEndAt ?? shift.scheduledEndAt).getTime()
  if (now < start) return { key: 'future', label: 'Запланирована' }
  if (now >= end) return { key: 'completed', label: 'Завершена' }
  return { key: 'active', label: 'Идёт сейчас' }
}

export default function SchedulePage({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const canManage = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const currentMonth = monthKeyInZone(new Date(), organization.timezone)
  const todayDate = zonedDateAndTime(new Date().toISOString(), organization.timezone).date
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedMonth = searchParams.get('month')
  const initialMonth = requestedMonth && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : currentMonth
  const [month, setMonth] = useState(initialMonth)
  const [shiftView, setShiftView] = useState<'all' | 'mine'>(searchParams.get('view') === 'mine' ? 'mine' : 'all')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [focusedShiftId, setFocusedShiftId] = useState<string | null>(null)
  const [editing, setEditing] = useState<WorkShift | null>(null)
  const [actual, setActual] = useState<WorkShift | null>(null)
  const [adding, setAdding] = useState(false)
  const [cancelling, setCancelling] = useState<WorkShift | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [myShiftsOpen, setMyShiftsOpen] = useState(false)
  const range = useMemo(() => calendarRange(month), [month])
  const schedule = useSchedule(organization.id, range.from, range.to)
  const members = useOrganizationMembers(organization.id)
  const ownMember = members.data?.members.find((member) => member.userId === user?.id)
  const myPlanned = useMyUpcomingShifts(organization.id, myShiftsOpen)
  const plannedOwnShifts = myPlanned.data?.shifts ?? []
  const visibleShifts = shiftView === 'mine' ? (schedule.data?.shifts.filter((shift) => shift.memberId === ownMember?.id) ?? []) : (schedule.data?.shifts ?? [])
  const visibleAbsences = shiftView === 'mine' ? (schedule.data?.absences.filter((absence) => absence.memberId === ownMember?.id) ?? []) : (schedule.data?.absences ?? [])
  const selectedShifts = selectedDate ? visibleShifts.filter((shift) => shiftCoversDate(shift, selectedDate, organization.timezone)) : []
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
    const shift = schedule.data.shifts.find((item) => item.id === shiftId)
    if (!shift) return
    const date = zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date
    setSelectedDate(date); setFocusedShiftId(shiftId); setAdding(false)
    setSearchParams((current) => { const next = new URLSearchParams(current); next.delete('shift'); return next }, { replace: true })
  }, [organization.timezone, schedule.data, schedule.isPlaceholderData, searchParams, setSearchParams])

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

  function changeView(view: 'all' | 'mine') {
    setShiftView(view)
    setSelectedDate(null)
    setFocusedShiftId(null)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (view === 'mine') next.set('view', 'mine'); else next.delete('view')
      next.set('month', month)
      return next
    }, { replace: true })
  }

  function chooseDay(day: string, shifts: WorkShift[], absenceCount: number) {
    setSelectedDate(day); setActionError('')
    setFocusedShiftId(null)
    if (canManage && shifts.length === 0 && absenceCount === 0) setAdding(true)
  }

  async function cancel(close: () => void) {
    if (!cancelling || cancelReason.trim().length < 3) return
    setBusy(true); setActionError('')
    try {
      await apiRequest(`/organizations/${organization.id}/shifts/${cancelling.id}/cancel`, { method: 'POST', body: { reason: cancelReason } })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['schedule', organization.id] }), queryClient.invalidateQueries({ queryKey: ['work-time-statistics', organization.id] }), queryClient.invalidateQueries({ queryKey: ['member-work-time', organization.id] }), queryClient.invalidateQueries({ queryKey: ['my-work-time', organization.id] }), queryClient.invalidateQueries({ queryKey: ['my-upcoming-shifts', organization.id] })])
      close()
    } catch (failure) { setActionError(failure instanceof Error ? failure.message : 'Не удалось отменить смену.') }
    finally { setBusy(false) }
  }

  return <section className="schedule-page">
    <header className="schedule-heading"><div><p className="app-eyebrow">Рабочий график</p><h1>Расписание</h1><p>Нажмите на нужную дату, чтобы посмотреть смены{canManage ? ' или добавить новую' : ''}.</p></div><button className="app-primary schedule-my-shifts-button" onClick={() => setMyShiftsOpen(true)}>Список моих смен</button></header>
    <ScheduleTabs organization={organization} />
    <div className="schedule-view-switch" aria-label="Какие смены показывать"><button className={shiftView === 'all' ? 'active' : ''} onClick={() => changeView('all')}>Все смены</button><button className={shiftView === 'mine' ? 'active' : ''} onClick={() => changeView('mine')}>Только мои</button></div>
    <div className="schedule-toolbar"><button className="schedule-toolbar__arrow" type="button" aria-label="Показать предыдущий месяц" title="Предыдущий месяц" onClick={() => setMonth(moveMonth(month, -1))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 5-7 7 7 7" /></svg></button><h2>{formatMonth(month)}</h2><button type="button" className="schedule-today" title="Вернуться к текущему месяцу" disabled={month === currentMonth} onClick={() => setMonth(currentMonth)}>К текущему месяцу</button><button className="schedule-toolbar__arrow" type="button" aria-label="Показать следующий месяц" title="Следующий месяц" onClick={() => setMonth(moveMonth(month, 1))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m9 5 7 7-7 7" /></svg></button></div>

    {schedule.isLoading ? <div className="schedule-state"><span className="app-spinner" />Загружаем расписание…</div> : schedule.isError ? <div className="schedule-state"><strong>Не удалось загрузить расписание</strong><p>{schedule.error instanceof Error ? schedule.error.message : 'Попробуйте ещё раз.'}</p><button className="app-secondary" onClick={() => void schedule.refetch()}>Повторить</button></div> : <>
      <div className={`schedule-calendar-wrap${schedule.isFetching ? ' is-updating' : ''}`}><div className="schedule-calendar" role="grid">
        {weekDays.map((day) => <div className="schedule-calendar__weekday" role="columnheader" key={day}>{day}</div>)}
        {range.days.map((day) => {
          const shifts = visibleShifts.filter((shift) => shiftCoversDate(shift, day, organization.timezone))
          const absences = visibleAbsences.filter((absence) => day >= absence.startDate && day <= absence.endDate)
          const inMonth = day.startsWith(month)
          const today = day === todayDate
          return <button type="button" role="gridcell" className={`schedule-day${inMonth ? '' : ' schedule-day--outside'}${today ? ' schedule-day--today' : ''}`} key={day} onClick={() => chooseDay(day, shifts, absences.length)}>
            <span className="schedule-day__number">{Number(day.slice(-2))}</span>
            <span className="schedule-day__shifts">{absences.slice(0, 1).map((absence) => <span className="schedule-absence-chip" key={absence.id}><strong>{absence.memberId === ownMember?.id ? `Мой ${absenceNames[absence.type].toLowerCase()}` : absence.memberName}</strong><small>{absenceNames[absence.type]}</small></span>)}{shifts.slice(0, absences.length ? 1 : 2).map((shift) => { const state = shiftState(shift); const mine = shift.memberId === ownMember?.id; return <span className={`schedule-shift-chip schedule-shift-chip--${state.key}${mine ? ' schedule-shift-chip--mine' : ''}`} key={shift.id}><strong>{mine ? 'Моя смена' : shift.memberName}</strong><small>{formatTime(shift.scheduledStartAt, organization.timezone)}–{formatTime(shift.scheduledEndAt, organization.timezone)}</small></span> })}{shifts.length + absences.length > 2 && <small className="schedule-day__more">Ещё {shifts.length + absences.length - 2}</small>}</span>
          </button>
        })}
      </div><span className="schedule-calendar-loading">Обновляем месяц…</span></div>
      <div className="schedule-legend"><span><i className="future" />Запланирована</span><span><i className="active" />Идёт сейчас</span><span><i className="completed" />Завершена</span><span><i className="mine" />Ваша смена</span><small>Часовой пояс: {organization.timezone}</small></div>
      {!monthHasShifts && <div className="schedule-empty"><h3>{shiftView === 'mine' ? 'У вас нет смен в этом месяце' : 'На этот месяц смен пока нет'}</h3><p>{shiftView === 'mine' ? 'Переключитесь на все смены или выберите другой месяц.' : canManage ? 'Нажмите на нужный день календаря, чтобы добавить первую смену.' : 'Когда администратор составит график, смены появятся здесь.'}</p></div>}
    </>}

    {selectedDate && !adding && !editing && !actual && <AnimatedOverlay variant="drawer" onClose={() => { setSelectedDate(null); setFocusedShiftId(null) }}>{(close) => <aside className="schedule-drawer" role="dialog" aria-modal="true" aria-labelledby="day-title"><header><div><p className="app-eyebrow">Расписание на день</p><h2 id="day-title">{displayDate(selectedDate)}</h2><p>{selectedShifts.length ? `${selectedShifts.length} ${selectedShifts.length === 1 ? 'смена' : 'смены'}` : 'Свободный день'}</p></div><button aria-label="Закрыть" onClick={close}>×</button></header><div className="schedule-drawer__list">
      {!selectedShifts.length && !selectedAbsences.length && <div className="schedule-drawer__empty">На этот день смен и отсутствий нет.</div>}
      {selectedAbsences.map((absence) => <article className="day-absence" key={absence.id}><strong>{absence.memberName}</strong><span>{absenceNames[absence.type]}</span><small>{displayDate(absence.startDate)} — {displayDate(absence.endDate)}</small></article>)}
      {selectedShifts.map((shift) => { const state = shiftState(shift); const mine = shift.memberId === ownMember?.id; return <article id={`day-shift-${shift.id}`} className={`day-shift day-shift--${state.key}${mine ? ' day-shift--mine' : ''}${focusedShiftId === shift.id ? ' day-shift--focused' : ''}`} key={shift.id}><div className="day-shift__heading"><span>{shift.memberName.slice(0, 1).toUpperCase()}</span><div><strong>{mine ? `${shift.memberName} · ваша смена` : shift.memberName}</strong><small>{state.label}{shift.adjusted ? ' · время изменено' : ''}</small></div></div><div className="day-shift__time"><strong>{formatTime(shift.scheduledStartAt, organization.timezone)}–{formatTime(shift.scheduledEndAt, organization.timezone)}</strong><span>{formatDuration(shift.effectiveMinutes)}</span></div>{shift.description && <p>{shift.description}</p>}{shift.cancellationReason && <p>Причина отмены: {shift.cancellationReason}</p>}{canManage && shift.status !== 'CANCELLED' && <footer>{state.key === 'completed' ? <button className="app-secondary" onClick={() => setActual(shift)}>Уточнить отработанное время</button> : <button className="app-secondary" onClick={() => setEditing(shift)}>Изменить расписание</button>}<button className="schedule-cancel-button" onClick={() => { setCancelling(shift); setCancelReason(''); setActionError('') }}>Отменить смену</button></footer>}</article> })}
    </div>{canManage && <button className="app-primary schedule-drawer__add" onClick={() => setAdding(true)}>Добавить смену на эту дату</button>}</aside>}</AnimatedOverlay>}

    {(adding || editing || actual) && selectedDate && <ShiftFormModal organization={organization} members={members.data?.members ?? []} date={selectedDate} shift={editing ?? actual} actual={Boolean(actual)} onClose={() => { setAdding(false); setEditing(null); setActual(null); setSelectedDate(null) }} />}
    {cancelling && <AnimatedOverlay variant="modal" onClose={() => { setCancelling(null); setCancelReason('') }}>{(close) => <div className="cancel-shift-modal"><p className="app-eyebrow">Отмена смены</p><h2>Отменить смену {cancelling.memberName}?</h2><p>Смена останется в истории и перестанет учитываться в рабочем времени.</p><label><span>Причина отмены</span><textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} maxLength={500} rows={3} autoFocus /></label>{actionError && <p className="form-inline-error">{actionError}</p>}<footer><button className="app-secondary" disabled={busy} onClick={close}>Назад</button><button className="app-danger" disabled={busy || cancelReason.trim().length < 3} onClick={() => void cancel(close)}>{busy ? 'Отменяем…' : 'Отменить смену'}</button></footer></div>}</AnimatedOverlay>}
    {myShiftsOpen && <AnimatedOverlay variant="drawer" onClose={() => setMyShiftsOpen(false)}>{(close) => <aside className="schedule-drawer schedule-drawer--my"><header><div><p className="app-eyebrow">Личный график</p><h2>Мои запланированные смены</h2><p>Все предстоящие смены по порядку</p></div><button aria-label="Закрыть" onClick={close}>×</button></header>{myPlanned.isLoading ? <div className="schedule-state"><span className="app-spinner" /></div> : myPlanned.isError ? <div className="schedule-state">Не удалось загрузить ваши смены.</div> : <div className="my-shifts-list">{plannedOwnShifts.map((shift) => <article key={shift.id}><div><strong>{displayDate(zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date)}</strong><span>{formatTime(shift.scheduledStartAt, organization.timezone)}–{formatTime(shift.scheduledEndAt, organization.timezone)}</span></div><small>{formatDuration(shift.effectiveMinutes)}</small></article>)}{!plannedOwnShifts.length && <div className="schedule-drawer__empty">Запланированных смен пока нет.</div>}</div>}</aside>}</AnimatedOverlay>}
  </section>
}
