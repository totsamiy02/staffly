import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import { useDashboardRecords, useDashboardSchedule } from './dashboard-queries.ts'
import { addDays, calendarRange, formatMonth, moveMonth, shiftTimeRange, zonedDateAndTime } from '../../app/schedule/date-utils.ts'
import { useLocations, useNotificationActions, useNotificationHistory } from '../../app/organizations/queries.ts'
import { useInvitationClock } from '../../app/organizations/invitation-time.ts'
import Avatar from '../../component/ui/avatar/avatar.tsx'
import NotificationItem from './topbar/notification-item.tsx'
import NotificationHistoryModal from './topbar/notification-history-modal.tsx'
import DocumentDialog from './documents/document-dialog.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import './dashboard.scss'

function DashboardIcon({ kind }: { kind: 'people' | 'calendar' | 'document' | 'request' | 'arrow' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'people' ? <><circle cx="9" cy="7" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5" /></> : kind === 'calendar' ? <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4m8-4v4M4 11h16m-11 4h1m4 0h1" /></> : kind === 'document' ? <><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6" /></> : kind === 'request' ? <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8 12 3 3 5-6" /></> : <path d="M5 12h14m-5-5 5 5-5 5" />}</svg>
}

function Panel({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section id={className === 'dashboard-calendar' ? 'dashboard-calendar' : undefined} className={`dashboard-panel ${className}`}><header><h2>{title}</h2>{action}</header>{children}</section>
}

function QueryState({ loading, error, retry, empty, children }: { loading: boolean; error: boolean; retry: () => unknown; empty?: string; children?: ReactNode }) {
  if (loading) return <p className="dashboard-empty" role="status">Загружаем…</p>
  if (error) return <div className="dashboard-empty" role="alert">Не удалось загрузить данные. <button type="button" onClick={() => void retry()}>Повторить</button></div>
  return empty ? <p className="dashboard-empty">{empty}</p> : children
}

export default function DashboardOverview({ organization }: { organization: OrganizationSummary }) {
  const { user } = useAuth()
  const locations = useLocations(organization.id)
  const points = (locations.data?.locations ?? []).filter(point => !point.archivedAt)
  const filterKey = `staffly:dashboard:${user?.id}:${organization.id}`
  const [filter, setFilter] = useState(() => window.sessionStorage.getItem(filterKey) ?? 'all')
  const pointId = points.some(point => point.id === filter) ? filter : 'all'
  const selectedPoint = points.find(point => point.id === pointId)
  const visiblePoints = selectedPoint ? [selectedPoint] : points
  const anchorId = selectedPoint?.id ?? points[0]?.id
  const timezone = selectedPoint?.timezone ?? organization.organizationTimezone ?? 'Europe/Moscow'
  function selectPoint(value: string) { window.sessionStorage.setItem(filterKey, value); setFilter(value) }
  const now = useInvitationClock()
  const localNow = zonedDateAndTime(new Date(now).toISOString(), timezone)
  const today = localNow.date
  const hour = Number(localNow.time.slice(0, 2))
  const [month, setMonth] = useState(today.slice(0, 7))
  const [selectedDay, setSelectedDay] = useState(today)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [scheduleDay, setScheduleDay] = useState<string | null>(null)
  const range = calendarRange(month)
  const calendar = useDashboardSchedule(organization.id, visiblePoints, range.from, range.to, locations.isSuccess)
  const upcoming = useDashboardSchedule(organization.id, visiblePoints, addDays(today, -1), addDays(today, 14), locations.isSuccess)
  const manager = (organization.organizationRole ?? organization.role) === 'OWNER' || (selectedPoint ? selectedPoint.role === 'ADMIN' : points.some(point => point.role === 'ADMIN'))
  const scope = manager ? 'incoming' : 'mine'
  const { requests, pending, documents, members } = useDashboardRecords(organization.id, anchorId, pointId, manager)
  const notifications = useNotificationHistory({ organizationId: organization.id, limit: 4, locationId: selectedPoint?.id ?? null })
  const actions = useNotificationActions(organization.id)
  const base = `/app/organizations/${organization.id}`
  const href = (module: string, params: Record<string, string> = {}) => `${base}/${module}?${new URLSearchParams({ location: anchorId ?? '', ...(['requests', 'documents', 'employees'].includes(module) ? { pointId } : {}), ...params })}`
  const dayHref = (day: string, locationId = anchorId ?? '') => href('schedule', { month: day.slice(0, 7), day, location: locationId })
  const dateLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  const shifts = (upcoming.data?.shifts ?? []).filter(shift => shift.status !== 'CANCELLED').sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt))
  const todayShifts = shifts.filter(shift => zonedDateAndTime(shift.scheduledStartAt, shift.timezone).date === zonedDateAndTime(new Date(now).toISOString(), shift.timezone).date)
  const nextShifts = shifts.filter(shift => new Date(shift.actualEndAt ?? shift.scheduledEndAt).getTime() > now).slice(0, 4)
  const calendarShifts = calendar.isPlaceholderData ? [] : (calendar.data?.shifts ?? []).filter(shift => shift.status !== 'CANCELLED')
  const dayShifts = calendarShifts.filter(shift => zonedDateAndTime(shift.scheduledStartAt, shift.timezone).date === selectedDay).sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt))
  const markedDays = new Set(calendarShifts.map(shift => zonedDateAndTime(shift.scheduledStartAt, shift.timezone).date))
  const link = (to: string, label: string) => <Link className="dashboard-link" to={to}>{label}<DashboardIcon kind="arrow" /></Link>
  const scheduleLink = (day: string, label: string) => selectedPoint ? link(dayHref(day), label) : <button className="dashboard-link" onClick={() => setScheduleDay(day)}>{label}<DashboardIcon kind="arrow" /></button>
  const shiftRows = (items: typeof shifts, showDate = false) => <div className="dashboard-shifts">{items.map(shift => <Link key={shift.id} to={dayHref(zonedDateAndTime(shift.scheduledStartAt, shift.timezone).date, shift.locationId)} className="dashboard-shift"><span className="dashboard-shift__time">{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, shift.timezone)}{showDate && <small>{dateLabel(zonedDateAndTime(shift.scheduledStartAt, shift.timezone).date)}</small>}</span><span><strong>{shift.positionName || 'Рабочая смена'}</strong><small>{shift.memberName}</small>{!selectedPoint && <small className="dashboard-point-label">{shift.locationName}</small>}</span><DashboardIcon kind="arrow" /></Link>)}</div>
  return <div className="dashboard-layout">
    <div className="dashboard-main">
      <header className="dashboard-greeting"><p>{hour < 6 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'},</p><h1>{user?.firstName || user?.displayName || 'Добро пожаловать'}</h1><span>{selectedPoint ? `Сегодня в «${selectedPoint.name}»` : 'Сегодня во всей организации'} · {dateLabel(today)}</span></header>
      <nav className="dashboard-scope" aria-label="Область сводки"><button aria-pressed={pointId === 'all'} onClick={() => selectPoint('all')}>Все точки</button>{points.map(point => <button key={point.id} title={[point.city, point.address].filter(Boolean).join(', ')} aria-pressed={pointId === point.id} onClick={() => selectPoint(point.id)}>{point.name}</button>)}</nav>
      {locations.isError && <p className="form-inline-error" role="alert">Не удалось загрузить точки. <button onClick={() => void locations.refetch()}>Повторить</button></p>}
      {!selectedPoint && <p className="dashboard-scope-note">Смены указаны по местному времени каждой точки.{manager ? ' Заявки — по точкам, которыми вы управляете.' : ''}</p>}
      <div className="dashboard-metrics">
        {([{ kind: 'people', value: members.isError ? '—' : members.isPending ? '…' : members.data?.pagination.total ?? 0, label: 'Сотрудники', note: selectedPoint ? 'в выбранной точке' : 'во всей организации', to: href('employees') }, { kind: 'calendar', value: upcoming.isError ? '—' : upcoming.isLoading ? '…' : todayShifts.length, label: 'Смены', note: 'на сегодня', to: selectedPoint ? dayHref(today) : '#dashboard-calendar' }, { kind: 'request', value: pending.isError ? '—' : pending.isPending ? '…' : pending.data?.pagination.total ?? 0, label: 'Заявки', note: manager ? 'на рассмотрении' : 'ожидают решения', to: href('requests', { tab: scope }) }, { kind: 'document', value: documents.isError ? '—' : documents.isPending ? '…' : documents.data?.pagination.total ?? 0, label: 'Документы', note: 'для ознакомления', to: href('documents', { section: 'acknowledgements' }) }] as const).map(item => <Link className="dashboard-metric" to={item.to} key={item.kind}><span className="dashboard-metric__icon"><DashboardIcon kind={item.kind} /></span><span><strong>{item.value}</strong><span>{item.label}</span><small>{item.note}</small></span></Link>)}
      </div>
      <div className="dashboard-panels">
        <Panel title="Ближайшие смены" action={scheduleLink(today, 'Расписание')}><QueryState loading={upcoming.isLoading} error={upcoming.isError} retry={upcoming.refetch} empty={!nextShifts.length ? 'На ближайшие две недели смен нет.' : undefined}>{shiftRows(nextShifts, true)}</QueryState></Panel>
        <Panel title={manager ? 'Заявки на рассмотрении' : 'Мои заявки'} action={link(href('requests', { tab: scope }), 'Все заявки')}><QueryState loading={requests.isPending} error={requests.isError} retry={requests.refetch} empty={!requests.data?.requests.length ? 'Заявок пока нет.' : undefined}><div className="dashboard-requests">{requests.data?.requests.slice(0, 4).map(request => <Link key={request.id} to={href('requests', { tab: scope, request: request.id, location: request.locationId })}><Avatar className="app-avatar" url={request.creatorAvatarUrl} name={request.creatorName} /><span><strong>{request.creatorName}</strong><small>{request.typeNameSnapshot}</small>{!selectedPoint && <small>{request.locationName}</small>}</span><span className={`dashboard-status dashboard-status--${request.status.toLowerCase()}`}>{({ PENDING: 'На рассмотрении', APPROVED: 'Одобрена', REJECTED: 'Отклонена', CANCELLED: 'Отменена' })[request.status]}</span></Link>)}</div></QueryState></Panel>
        <Panel title="Мои документы" action={link(href('documents', { section: 'acknowledgements' }), 'Все документы')}><div className="dashboard-panel-caption">Требуют ознакомления <span>{documents.data?.pagination.total ?? '—'}</span></div><QueryState loading={documents.isPending} error={documents.isError} retry={documents.refetch} empty={!documents.data?.documents.length ? 'Всё готово. Нет документов, требующих ознакомления.' : undefined}><div className="dashboard-document-list">{documents.data?.documents.map(item => <Link key={item.id} to={href('documents', { section: 'acknowledgements', document: item.id, ...(item.locationId ? { location: item.locationId } : {}) })}><DashboardIcon kind="document" /><span><strong>{item.displayName}</strong><small>{item.locationName || 'Вся организация'}</small></span><DashboardIcon kind="arrow" /></Link>)}</div></QueryState></Panel>
        <Panel title="Уведомления" action={<button className="dashboard-link" onClick={() => setHistoryOpen(true)}>Все уведомления<DashboardIcon kind="arrow" /></button>}><QueryState loading={notifications.isLoading} error={notifications.isError} retry={notifications.refetch} empty={!notifications.data?.notifications.length ? 'Новых событий пока нет.' : undefined}><div className="dashboard-notifications">{notifications.data?.notifications.map(item => <NotificationItem key={item.id} item={item} now={now} compact showOrganization={false} busy={actions.read.isPending || actions.invitation.isPending} onRead={(id, unread) => actions.read.mutate({ id, unread })} onInvite={(id, action) => actions.invitation.mutate({ id, action })} />)}</div></QueryState>{actions.error && <p className="form-inline-error">{actions.error.message}</p>}</Panel>
      </div>
    </div>
    <Panel title="Календарь" className="dashboard-calendar" action={scheduleLink(selectedDay, 'Открыть')}>
      <div className="dashboard-calendar__month"><button aria-label="Предыдущий месяц" onClick={() => { const next = moveMonth(month, -1); setMonth(next); setSelectedDay(`${next}-01`) }}>‹</button><button aria-label="Следующий месяц" onClick={() => { const next = moveMonth(month, 1); setMonth(next); setSelectedDay(`${next}-01`) }}>›</button><strong>{formatMonth(month)}</strong>{month !== today.slice(0, 7) && <button className="dashboard-calendar__today" onClick={() => { setMonth(today.slice(0, 7)); setSelectedDay(today) }}>Сегодня</button>}</div>
      <div className="dashboard-calendar__grid" aria-label={formatMonth(month)}>{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <span key={day}>{day}</span>)}{range.days.map(day => <button key={day} className={`${day.slice(0, 7) !== month ? 'is-outside ' : ''}${day === today ? 'is-today' : ''}`} aria-pressed={day === selectedDay} aria-current={day === today ? 'date' : undefined} aria-label={`${dateLabel(day)}${markedDays.has(day) ? ', есть смены' : ''}`} onClick={() => { setSelectedDay(day); if (day.slice(0, 7) !== month) setMonth(day.slice(0, 7)) }}><span>{Number(day.slice(8))}</span><i data-marked={markedDays.has(day)} /></button>)}</div>
      <div className="dashboard-calendar__day"><strong>{selectedDay === today ? 'Сегодня, ' : ''}{dateLabel(selectedDay)}</strong><span>{calendar.isLoading || calendar.isPlaceholderData ? '…' : `Смены: ${dayShifts.length}`}</span></div>
      <QueryState loading={calendar.isLoading || calendar.isPlaceholderData} error={calendar.isError} retry={calendar.refetch} empty={!dayShifts.length ? 'На этот день смены не назначены.' : undefined}>{shiftRows(dayShifts.slice(0, 5))}{dayShifts.length > 5 && scheduleLink(selectedDay, `Ещё ${dayShifts.length - 5} смен`)}</QueryState>
    </Panel>
    {scheduleDay && <AnimatedOverlay variant="modal" onClose={() => setScheduleDay(null)}>{close => <DocumentDialog title="Расписание точек" eyebrow={dateLabel(scheduleDay)} onClose={close}><div className="dashboard-point-choices">{visiblePoints.map(point => <Link key={point.id} to={dayHref(scheduleDay, point.id)}><strong>{point.name}</strong><small>{[point.city, point.address].filter(Boolean).join(', ')}</small><DashboardIcon kind="arrow" /></Link>)}</div></DocumentDialog>}</AnimatedOverlay>}
    {historyOpen && <NotificationHistoryModal locationId={selectedPoint?.id ?? null} organizationId={organization.id} onClose={() => setHistoryOpen(false)} />}
  </div>
}
