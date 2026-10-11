import type { OfferShift } from '../../../app/schedule/offers.ts'
import { displayDate, formatDuration, shiftTimeRange, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import './shift-offers.scss'

export function OfferShiftCard({ shift, locationName, label, tone }: { shift: OfferShift; locationName: string; label?: string; tone?: string }) {
  const date = zonedDateAndTime(shift.startAt, shift.timezone).date
  // Staffly counts paid breaks in shift duration, as the calendar and statistics do.
  const minutes = Math.max(0, Math.floor((Date.parse(shift.endAt) - Date.parse(shift.startAt)) / 60000))
  return <section className={`offer-shift${tone ? ` offer-shift--${tone}` : ''}`}>
    {label && <div className="offer-shift__label">{label}</div>}
    <div className="offer-shift__body">
      <div className="offer-shift__date"><OfferIcon kind="calendar" /><strong>{displayDate(date)} <span>·</span> <time>{shiftTimeRange(shift.startAt, shift.endAt, shift.timezone)}</time></strong></div>
      <div className="offer-shift__location"><OfferIcon kind="location" /><span>{locationName}</span></div>
      <div className="offer-shift__meta"><OfferIcon kind="work" /><span>{shift.positionName ?? 'Без должности'} · {formatDuration(minutes)}{shift.breakMinutes > 0 && ` · перерыв ${shift.breakMinutes} мин`}<small>{shift.timezone}</small></span></div>
      {shift.description && <p className="offer-shift__description">{shift.description}</p>}
    </div>
  </section>
}
export function OfferIcon({ kind }: { kind: 'calendar' | 'location' | 'work' | 'send' | 'swap' | 'person' | 'people' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'calendar' ? <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v5m8-5v5M4 11h16" /></> : kind === 'location' ? <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10" r="2" /></> : kind === 'work' ? <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V4h8v3M3 12h18m-11 0v3h4v-3" /></> : kind === 'send' ? <><path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3" /></> : kind === 'swap' ? <><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" /></> : <><circle cx="9" cy="7" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2H3Z" />{kind === 'people' && <path d="M16 4a3 3 0 0 1 0 6m2 3a6 6 0 0 1 3 5v2h-3" />}</>}
  </svg>
}
