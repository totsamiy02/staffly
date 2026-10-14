import type { ReactNode } from 'react'
import { calendarRange, displayDate, formatMonth, moveMonth } from '../../../app/schedule/date-utils.ts'
import './planning-month-calendar.scss'
type Props = { month: string; onMonth: (month: string) => void; selected?: string[]; min?: string; max?: string; onDay: (date: string) => void; content?: (date: string) => ReactNode; label?: string }
export default function PlanningMonthCalendar({ month, onMonth, selected = [], min, max, onDay, content, label = 'Календарь' }: Props) {
  return <section className="planning-month" aria-label={label}>
    <header><button type="button" aria-label="Предыдущий месяц" disabled={!!min && moveMonth(month,-1) < min.slice(0,7)} onClick={() => onMonth(moveMonth(month,-1))}>‹</button><strong>{formatMonth(month)}</strong><button type="button" aria-label="Следующий месяц" disabled={!!max && moveMonth(month,1) > max.slice(0,7)} onClick={() => onMonth(moveMonth(month,1))}>›</button></header>
    <div className="planning-month__grid" role="group" aria-label={formatMonth(month)}>
      {['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day => <span className="planning-month__weekday" key={day}>{day}</span>)}
      {calendarRange(month).days.map(date => <button type="button" key={date} className={`${!date.startsWith(month)?'is-outside':''}${selected.includes(date)?' is-selected':''}`} disabled={!!min && date < min || !!max && date > max} aria-pressed={selected.includes(date)} aria-label={displayDate(date)} onClick={() => onDay(date)}><span className="planning-month__number">{Number(date.slice(-2))}</span>{content?.(date)}</button>)}
    </div>
  </section>
}
