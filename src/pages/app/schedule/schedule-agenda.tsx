import { useEffect, useRef, type CSSProperties } from 'react'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import { displayDate, shiftCoversDate, shiftState, shiftTimeRange, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'

type Props = { days: string[]; shifts: WorkShift[]; timezone: string; timeline?: boolean; order?: 'asc' | 'desc'; onShift: (day: string, shift: WorkShift) => void }

export default function ScheduleAgenda({ days, shifts, timezone, timeline = false, order = 'asc', onShift }: Props) {
  const groups = days.map(day => ({ day, shifts: shifts.filter(shift => shiftCoversDate(shift, day, timezone)).sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt)) }))
  const scroll = useRef<HTMLDivElement>(null)
  const firstStart = groups[0]?.shifts[0]?.scheduledStartAt
  const day = days[0]
  useEffect(() => {
    if (!timeline || !scroll.current) return
    const start = firstStart ? zonedDateAndTime(firstStart, timezone) : null
    const hour = start && start.date === day ? Number(start.time.slice(0, 2)) : start ? 0 : 8
    scroll.current.scrollTop = Math.max(0, hour - 1) * 48
  }, [timeline, day, firstStart, timezone])
  if (timeline) {
    const rows = groups[0]?.shifts ?? []
    return <div ref={scroll} className="schedule-timeline-scroll" role="region" aria-label={`Смены по часам: ${displayDate(day)}`} tabIndex={0}><div className="schedule-timeline" style={{ '--timeline-columns': Math.max(1, rows.length) } as CSSProperties}><div className="schedule-timeline-hours">{Array.from({ length: 24 }, (_, hour) => <span key={hour}>{String(hour).padStart(2, '0')}:00</span>)}</div><div className="schedule-timeline-lanes">{rows.map(shift => {
      const start = zonedDateAndTime(shift.scheduledStartAt, timezone), end = zonedDateAndTime(shift.scheduledEndAt, timezone)
      const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
      const from = start.date < day ? 0 : minutes(start.time), to = end.date > day ? 1440 : minutes(end.time)
      return <div className="schedule-timeline-lane" key={shift.id}><button className={`schedule-timeline-shift schedule-preview-shift--${shiftState(shift).key}`} style={{ top: `${from / 1440 * 100}%`, height: `${Math.max(20, to - from) / 1440 * 100}%` }} onClick={() => onShift(day, shift)} title={`${shift.memberName} · ${shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, timezone, day)}`}><strong>{shift.memberName}</strong>{shift.activeOffer && <small>Предложена {shift.activeOffer.kind === 'SWAP' ? 'на обмен' : 'передача'}</small>}<span>{shift.positionName ?? 'Без должности'}</span><small>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, timezone, day)}</small></button></div>
    })}{!rows.length && <p className="schedule-timeline-empty">На этот день смен нет</p>}</div></div></div>
  }
  const populated = groups.filter(group => group.shifts.length).sort((a, b) => order === 'asc' ? a.day.localeCompare(b.day) : b.day.localeCompare(a.day))
  return <div className="schedule-agenda">{populated.length ? populated.map(group => <section key={group.day}><header><h3>{displayDate(group.day)}</h3><small>Смен: {group.shifts.length}</small></header>{group.shifts.map(shift => <button key={shift.id} onClick={() => onShift(group.day, shift)}><Avatar url={shift.memberAvatarUrl} name={shift.memberName} className="app-avatar" /><span><strong>{shift.memberName}</strong><small>{shift.positionName ?? 'Без должности'}</small></span><span>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, timezone, group.day)}</span><small className={`schedule-agenda-status schedule-preview-shift--${shiftState(shift).key}`}>{shiftState(shift).label}{shift.activeOffer ? ' · предложена' : ''}</small><span aria-hidden="true">›</span></button>)}</section>) : <p className="schedule-preview-empty">По выбранным условиям смен нет. Попробуйте другой период или сбросьте фильтры.</p>}</div>
}
