import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { eventDate } from '../../../app/events/format.ts'
import type { StaffEvent } from '../../../app/events/types.ts'
import { useEvents } from '../../../app/events/queries.ts'
import { useLocations } from '../../../app/organizations/queries.ts'
import { addDays, calendarRange, displayDate, formatMonth, moveMonth, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import Select from '../../../component/ui/select/select.tsx'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import { EventIcon, EventRowContent, EventState } from './event-elements.tsx'
import EventForm from './event-form.tsx'
import EventDetail from './event-detail.tsx'
export default function EventsPage({ organization }: { organization: OrganizationSummary }) {
  const [params, setParams] = useSearchParams(), locations = useLocations(organization.id)
  const today = zonedDateAndTime(new Date().toISOString(), organization.organizationTimezone ?? organization.timezone).date
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming'), [search, setSearch] = useState(''), [debouncedSearch, setDebouncedSearch] = useState('')
  const [pointId, setPointId] = useState(params.get('pointId') ?? 'all'), [page, setPage] = useState(1), [month, setMonth] = useState(today.slice(0, 7)), [day, setDay] = useState<string | undefined>()
  const [form, setForm] = useState<StaffEvent | 'new' | null>(null)
  const eventId = params.get('event')
  const points = locations.data?.locations ?? []
  const owner = (organization.organizationRole ?? organization.role) === 'OWNER'
  const manager = owner || points.some(point => point.role === 'ADMIN' && !point.archivedAt)
  const filter = pointId === 'all' || points.some(point => point.id === pointId) ? pointId : 'all'
  const events = useEvents(organization.id, { tab, search: debouncedSearch, pointId: filter, page, ...(day ? { from: day, to: addDays(day, 1) } : {}) })
  const range = calendarRange(month)
  const calendar = useEvents(organization.id, { tab, search: debouncedSearch, pointId: filter, from: range.from, to: range.to, pageSize: 1 })
  const marked = new Set(calendar.data?.markedDays ?? [])
  useEffect(() => { const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1) }, 250); return () => clearTimeout(timer) }, [search])
  function openEvent(id: string | null) { const next = new URLSearchParams(params); if (id) next.set('event', id); else next.delete('event'); setParams(next, { replace: true }) }
  const groups = new Map<string, StaffEvent[]>()
  for (const event of events.data?.events ?? []) { const key = eventDate(event).slice(0, 7); groups.set(key, [...groups.get(key) ?? [], event]) }
  return <section className="events-page">
    <header className="events-heading"><div><h1>События</h1><p>Ближайшие встречи, обучение и проверки</p></div>{manager && <button className="app-primary" onClick={() => setForm('new')}><span aria-hidden="true">＋</span> Создать событие</button>}</header>
    <SegmentedNav label="Период событий"><button aria-pressed={tab === 'upcoming'} className={tab === 'upcoming' ? 'active' : ''} onClick={() => { setTab('upcoming'); setPage(1); setDay(undefined) }}>Предстоящие</button><button aria-pressed={tab === 'past'} className={tab === 'past' ? 'active' : ''} onClick={() => { setTab('past'); setPage(1); setDay(undefined) }}>Прошедшие</button></SegmentedNav>
    <div className="events-layout"><div className="events-main">
      <div className="events-filters"><Select aria-label="Точка событий" value={filter} onChange={action => { setPointId(action.target.value); setPage(1); const next = new URLSearchParams(params); next.set('pointId', action.target.value); setParams(next, { replace: true }) }}><option value="all">Все точки</option>{points.map(point => <option value={point.id} key={point.id}>{point.name}{point.archivedAt ? ' · закрыта' : ''}</option>)}</Select><label className="events-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><input aria-label="Поиск событий" value={search} placeholder="Поиск событий" maxLength={160} onChange={action => setSearch(action.target.value)} /></label></div>
      {day && <div className="events-day-filter"><span>{displayDate(day)}</span><button type="button" onClick={() => { setDay(undefined); setPage(1) }}>Все даты ×</button></div>}
      <EventState loading={events.isLoading} error={events.isError} retry={events.refetch}>{events.data?.events.length ? <div className="events-agenda">{[...groups].map(([key, items]) => <section key={key}><h2>{formatMonth(key)}</h2><div className="events-rows">{items.map(event => <button className={`event-row${event.cancelledAt ? ' is-cancelled' : ''}`} key={event.id} onClick={() => openEvent(event.id)}><EventRowContent event={event} /></button>)}</div></section>)}</div> : <div className="events-empty"><EventIcon /><strong>{search || day || filter !== 'all' ? 'По выбранным условиям событий нет' : tab === 'past' ? 'История событий пока пуста' : 'Предстоящих событий пока нет'}</strong><p>{manager && tab === 'upcoming' ? 'Создайте планёрку, обучение или проверку для команды.' : 'Здесь появятся доступные вам события.'}</p>{manager && tab === 'upcoming' && !search && !day && <button className="app-secondary" onClick={() => setForm('new')}>Создать событие</button>}</div>}</EventState>
      {(events.data?.pagination.pages ?? 0) > 1 && <nav className="members-pagination" aria-label="Страницы событий"><button disabled={page <= 1 || events.isFetching} onClick={() => setPage(page - 1)}>Назад</button><span>{page} / {events.data?.pagination.pages}</span><button disabled={page >= (events.data?.pagination.pages ?? 1) || events.isFetching} onClick={() => setPage(page + 1)}>Далее</button></nav>}
    </div><aside className="events-calendar"><h2>Календарь</h2><div className="events-calendar__month"><button aria-label="Предыдущий месяц" onClick={() => setMonth(moveMonth(month, -1))}>‹</button><button aria-label="Следующий месяц" onClick={() => setMonth(moveMonth(month, 1))}>›</button><strong>{formatMonth(month)}</strong></div><div className="events-calendar__grid">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(label => <span key={label}>{label}</span>)}{range.days.map(value => <button className={value.slice(0, 7) !== month ? 'is-outside' : ''} aria-label={`${displayDate(value)}${marked.has(value) ? ', есть события' : ''}`} aria-current={value === today ? 'date' : undefined} aria-pressed={value === day} key={value} onClick={() => { setDay(value === day ? undefined : value); setPage(1); if (value.slice(0, 7) !== month) setMonth(value.slice(0, 7)) }}><span>{Number(value.slice(8))}</span><i data-marked={marked.has(value)} /></button>)}</div><p className="event-muted">Выберите день, чтобы посмотреть события.</p>{calendar.isError && <p className="form-inline-error">Не удалось загрузить отметки. <button onClick={() => void calendar.refetch()}>Повторить</button></p>}<button className="events-calendar__today" onClick={() => { setMonth(today.slice(0, 7)); setDay(undefined); setPage(1) }}>Сегодня</button></aside></div>
    {eventId && !form && <EventDetail organizationId={organization.id} eventId={eventId} onClose={() => openEvent(null)} onEdit={event => setForm(event)} />}
    {form && <EventForm key={form === 'new' ? 'new' : form.id} organization={organization} event={form === 'new' ? undefined : form} onClose={() => setForm(null)} onSaved={event => { setForm(null); openEvent(event.id) }} />}
  </section>
}
