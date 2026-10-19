import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { displayDate, formatDuration, shiftState, shiftTimeRange } from '../../../../app/schedule/date-utils.ts'
import { accountedTimeLabel } from '../../../../app/schedule/time/time-correction.ts'
import { absenceNames } from '../../../../app/schedule/absence-format.ts'
import type { EmployeeAbsence, WorkShift } from '../../../../app/schedule/types.ts'
import MemberAvatar from '../../../../component/ui/member-avatar.tsx'
import MemberProfileLink from '../../../../component/ui/member-profile-link.tsx'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import './day-schedule-panel.scss'

type Props = {
  date: string
  timezone: string
  locationName?: string
  locationId?: string
  shifts: WorkShift[]
  absences: EmployeeAbsence[]
  ownMemberId?: string
  focusedShiftId: string | null
  historical?: boolean
  coverage?: ReactNode
  actions?: ReactNode
  renderShiftActions: (shift: WorkShift) => ReactNode
  onAbsence: (absence: EmployeeAbsence) => void
  canOpenAbsence: (absence: EmployeeAbsence) => boolean
  onClose: () => void
}

export default function DaySchedulePanel({ date, timezone, locationName, locationId, shifts, absences, ownMemberId, focusedShiftId, historical, coverage, actions, renderShiftActions, onAbsence, canOpenAbsence, onClose }: Props) {
  const [tab, setTab] = useState<'shifts' | 'coverage'>('shifts')
  const [search, setSearch] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const query = search.trim().toLocaleLowerCase('ru')
  const matches = (name: string, position = '') => `${name} ${position}`.toLocaleLowerCase('ru').includes(query)
  const visibleShifts = shifts.filter(shift => matches(shift.memberName, shift.positionName ?? '')).sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt) || a.memberName.localeCompare(b.memberName, 'ru'))
  const visibleAbsences = absences.filter(absence => matches(absence.memberName))
  const showSearch = shifts.length + absences.length > 7 || !!search
  const activeTab = coverage ? tab : 'shifts'
  const weekday = new Intl.DateTimeFormat('ru', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))

  // Scroll only the list, keeping the header and day actions in place.
  useLayoutEffect(() => {
    const container = body.current
    const card = focusedShiftId ? container?.querySelector<HTMLElement>(`[id="day-shift-${CSS.escape(focusedShiftId)}"]`) : null
    if (container && card && activeTab === 'shifts') container.scrollTop += card.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
  }, [focusedShiftId, activeTab])

  return <DocumentDialog title={`${historical ? 'История смены' : 'Расписание на день'}: ${displayDate(date)}`} onClose={onClose} className="day-schedule-panel" headerContent={<>
    <header className="day-schedule-panel__header">
      <div><p className="app-eyebrow">{historical ? 'История смены' : 'Расписание на день'}</p><h2>{displayDate(date).replace(/\s*г\.$/, '')}</h2><p className="day-schedule-panel__subtitle"><span>{weekday}</span>{locationName && <> · {locationName}</>}</p></div>
      <button type="button" aria-label="Закрыть расписание дня" onClick={onClose}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button>
    </header>
    <div className="day-schedule-panel__tools">
      {coverage ? <SegmentedNav label="Содержимое дня" className="day-schedule-panel__tabs"><button type="button" aria-pressed={activeTab === 'shifts'} onClick={() => setTab('shifts')}>Смены · {shifts.length}</button><button type="button" aria-pressed={activeTab === 'coverage'} onClick={() => setTab('coverage')}>Потребность</button></SegmentedNav> : <p className="day-schedule-panel__count">Смены · {shifts.length}{absences.length > 0 && ` · Отсутствия · ${absences.length}`}</p>}
      {showSearch && activeTab === 'shifts' && <div className="day-schedule-panel__search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label="Найти сотрудника или должность" placeholder="Сотрудник или должность" value={search} onChange={event => { setSearch(event.target.value); if (body.current) body.current.scrollTop = 0 }} /></div>}
    </div>
  </>}>
    <div ref={body} className="day-schedule-panel__body" tabIndex={0} aria-label={activeTab === 'shifts' ? 'Список смен и отсутствий' : 'Потребность дня'}>
      {activeTab === 'coverage' ? coverage : <>
        {query && <p className="day-schedule-panel__results" role="status">Найдено: {visibleShifts.length + visibleAbsences.length} из {shifts.length + absences.length}</p>}
        {!visibleShifts.length && !visibleAbsences.length && <div className="day-schedule-panel__empty"><strong>{query ? 'Никого не нашли' : 'Свободный день'}</strong><p>{query ? 'Попробуйте другое имя или должность.' : 'На эту дату смен и отсутствий нет.'}</p>{query && <button type="button" className="app-secondary" onClick={() => setSearch('')}>Сбросить поиск</button>}</div>}
        {visibleShifts.map(shift => {
          const state = shiftState(shift)
          const corrected = !!shift.actualStartAt || !!shift.actualEndAt || shift.actualBreakMinutes !== null || shift.attendance === 'NO_SHOW'
          const status = shift.attendance === 'NO_SHOW' ? 'Неявка' : shift.attendance === 'PARTIAL' ? 'Частично отработана' : state.label
          return <article id={`day-shift-${shift.id}`} className={`day-schedule-card${shift.id === focusedShiftId ? ' day-schedule-card--focused' : ''}`} key={shift.id}>
            <div className="day-schedule-card__person"><MemberAvatar memberId={shift.memberId} locationId={locationId} name={shift.memberName} url={shift.memberAvatarUrl} className="app-avatar day-schedule-card__avatar" /><div><MemberProfileLink memberId={shift.memberId} locationId={locationId}><strong>{shift.memberName}</strong></MemberProfileLink><div className="day-schedule-card__badges">{shift.memberId === ownMemberId && <span className="day-schedule-card__mine">Ваша смена</span>}<span className={`day-schedule-card__status day-schedule-card__status--${state.key}`}>{status}</span>{shift.adjusted && <span>Есть изменения</span>}</div></div></div>
            {shift.positionName && <p className="day-schedule-card__position"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V4h8v3M3 12l9 3 9-3M12 13v4" /></svg>{shift.positionName}</p>}
            <dl className="day-schedule-card__time"><div><dt>По плану</dt><dd>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, timezone)}</dd></div><div><dt>{shift.status === 'CANCELLED' ? 'Отменена' : 'К учёту'}</dt><dd>{shift.status === 'CANCELLED' ? '—' : formatDuration(shift.effectiveMinutes)}</dd></div></dl>
            {shift.status !== 'CANCELLED' && <p className="day-schedule-card__accounting">{corrected ? `Учтено: ${accountedTimeLabel(shift, timezone)}` : 'По расписанию, без корректировок'}</p>}
            {shift.description && <p className="day-schedule-card__note">{shift.description}</p>}
            {shift.cancellationReason && <p className="day-schedule-card__note">Причина отмены: {shift.cancellationReason}</p>}
            <div className="day-schedule-card__actions">{renderShiftActions(shift)}</div>
          </article>
        })}
        {visibleAbsences.length > 0 && <section className="day-schedule-panel__absences" aria-label="Отсутствия"><h3>Отсутствия · {visibleAbsences.length}</h3>{visibleAbsences.map(absence => <article className="day-schedule-absence" key={absence.id}><div className="day-schedule-card__person"><MemberAvatar memberId={absence.memberId} locationId={locationId} name={absence.memberName} url={absence.memberAvatarUrl} className="app-avatar day-schedule-card__avatar" /><div><MemberProfileLink memberId={absence.memberId} locationId={locationId}><strong>{absence.memberName}</strong></MemberProfileLink><p>{absenceNames[absence.type]}</p></div></div><small>{displayDate(absence.startDate)} — {displayDate(absence.endDate)}</small>{canOpenAbsence(absence) && <button type="button" className="app-secondary" onClick={() => onAbsence(absence)}>Открыть отсутствие</button>}</article>)}</section>}
      </>}
    </div>
    {actions && <footer className="day-schedule-panel__footer">{actions}</footer>}
  </DocumentDialog>
}
