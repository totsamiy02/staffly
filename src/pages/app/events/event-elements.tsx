import type { ReactNode } from 'react'
import { locationTone, participantLabel } from '../../../app/organizations/format.ts'
import { eventDate, eventTime, eventTimezoneLabel } from '../../../app/events/format.ts'
import type { StaffEvent } from '../../../app/events/types.ts'
import './events.scss'
export function EventIcon({ kind = 'calendar' }: { kind?: 'calendar' | 'clock' | 'place' | 'people' | 'arrow' | 'link' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'clock' ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></> : kind === 'place' ? <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></> : kind === 'people' ? <><circle cx="9" cy="7" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5" /></> : kind === 'arrow' ? <path d="m9 6 6 6-6 6" /> : kind === 'link' ? <><path d="M14 3h7v7m-11 4L21 3M9 5H4v16h16v-5" /></> : <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4m8-4v4M4 11h16" /></>}</svg>
}
export function EventDateTile({ event }: { event: StaffEvent }) {
  const date = new Date(`${eventDate(event)}T12:00:00Z`)
  return <span className="event-date-tile"><strong>{date.getUTCDate()}</strong><small>{date.toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' }).replace('.', '')}</small></span>
}
export function EventScope({ event }: { event: StaffEvent }) {
  return <span className="event-scope">{event.shared ? <span className="event-point">Вся организация</span> : event.locations.map(point => <span className="event-point" data-tone={locationTone(point.id)} key={point.id}><EventIcon kind="place" />{point.name}{point.archivedAt ? ' · закрыта' : ''}</span>)}</span>
}
export function EventRowContent({ event, compact = false }: { event: StaffEvent; compact?: boolean }) {
  return <><EventDateTile event={event} /><span className="event-row__body"><strong>{event.title}</strong><span>{eventTime(event)}{event.place ? ` · ${event.place}` : event.meetingUrl ? ' · Онлайн' : ''}{compact ? ` · ${eventTimezoneLabel(event.timezone)}` : ''}</span>{!compact && <small>{event.recipientCount} {participantLabel(event.recipientCount)} · {eventTimezoneLabel(event.timezone)}</small>}</span><span className="event-row__meta"><EventScope event={event} />{event.cancelledAt ? <span className="event-status event-status--cancelled">Отменено</span> : event.status === 'ONGOING' ? <span className="event-status">Идёт сейчас</span> : event.typeLabel && !compact ? <small>{event.typeLabel}</small> : null}</span><EventIcon kind="arrow" /></>
}
export function EventState({ loading, error, retry, children }: { loading: boolean; error: boolean; retry: () => unknown; children: ReactNode }) {
  return loading ? <div className="events-empty" role="status"><span className="app-spinner" />Загружаем события…</div> : error ? <div className="events-empty" role="alert">Не удалось загрузить события.<button className="app-secondary" onClick={() => void retry()}>Повторить</button></div> : children
}
