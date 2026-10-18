import MemberProfileLink from '../../../component/ui/member-profile-link.tsx'
import MemberAvatar from '../../../component/ui/member-avatar.tsx'
import ActionSurface from '../../../component/ui/action-surface.tsx'
import { useState } from 'react'
import type { WorkShift } from '../../../app/schedule/types.ts'
import type { DraftProposal } from '../../../app/schedule/team-planning-types.ts'
import { displayDate, shiftCoversDate, shiftTimeRange } from '../../../app/schedule/date-utils.ts'
import PlanningMonthCalendar from './planning-month-calendar.tsx'
const labels = { KEEP: 'Без изменений', CREATE: 'Новая смена', UPDATE: 'Изменена', CANCEL: 'Будет отменена' }
type Props = { from: string; to: string; timezone: string; date: string; onDate: (date: string) => void; shifts: WorkShift[]; proposals: DraftProposal[]; manager: boolean; canEdit: boolean; onShift: (shift: WorkShift, proposal?: DraftProposal) => void; onAdd: () => void }
export default function DraftCalendarView({from,to,timezone,date,onDate,shifts,proposals,manager,canEdit,onShift,onAdd}:Props) {
  const [month,setMonth] = useState(from.slice(0,7))
  const forDay = (day: string) => shifts.filter(shift => shiftCoversDate(shift,day,timezone))
  const proposalFor = (shift: WorkShift) => proposals.find(p => p.proposed.id===shift.id || p.sourceShiftId===shift.id || p.appliedShiftId===shift.id)
  const selected = forDay(date)
  return <div className="draft-month-workspace">
    <div className="planning-card draft-month-calendar">
      <PlanningMonthCalendar label={manager?'Предварительный график команды':'Мои смены на согласовании'} month={month} onMonth={setMonth} min={from} max={to} selected={[date]} onDay={onDate} content={day=>{
        const items=forDay(day)
        return <>{items.slice(0,2).map(shift=><span className={`draft-month-chip draft-shift--${(proposalFor(shift)?.kind??'KEEP').toLowerCase()}`} key={shift.id}><span>{manager?shift.memberName.split(' ')[0]:<span className="draft-chip-time">{shiftTimeRange(shift.scheduledStartAt,shift.scheduledEndAt,timezone,day).split('–').map((time,index)=><span key={index}>{index>0&&<i>–</i>}{time}</span>)}</span>}</span><small>{manager?shiftTimeRange(shift.scheduledStartAt,shift.scheduledEndAt,timezone,day):labels[proposalFor(shift)?.kind??'KEEP']}</small></span>)}{items.length>2&&<small className="planning-month__hint">Ещё {items.length-2}</small>}</>
      }}/>
      <div className="draft-calendar-key"><span>Новая смена</span><span>Изменение</span><span>Отмена</span><span>Без изменений</span></div>
      <p className="planning-footnote">Нажмите на день — в списке появятся {manager?'сотрудники и':'ваши'} смены с должностями и точным временем.</p>
    </div>
    <section className="planning-card draft-day-detail"><header><div><h3>{displayDate(date)}</h3><p>{manager?'Предварительные смены команды':'Мои предлагаемые смены'} · {selected.length}</p></div>{canEdit&&<button className="app-primary" onClick={onAdd}>＋ Добавить смену</button>}</header>
      <div className="draft-day-detail__list">{selected.length?selected.map(shift=>{
        const proposal=proposalFor(shift),kind=proposal?.kind??'KEEP'
        return <ActionSurface aria-label={`Открыть предварительную смену ${shift.memberName}`} className="draft-day-shift" key={shift.id} onClick={()=>onShift(shift,proposal)}>
          {manager&&<MemberAvatar memberId={shift.memberId} name={shift.memberName} url={shift.memberAvatarUrl} className="draft-person-avatar"/>}
          <span className="draft-day-shift__copy">{manager&&<MemberProfileLink memberId={shift.memberId}><strong>{shift.memberName}</strong></MemberProfileLink>}<b>{shiftTimeRange(shift.scheduledStartAt,shift.scheduledEndAt,timezone,date)}</b><small>{shift.positionName??'Без должности'}</small><span className={`draft-status draft-shift--${kind.toLowerCase()}`}>{labels[kind]}</span></span>
        </ActionSurface>
      }):<p className="planning-empty">{manager?'На эту дату смен пока нет.':'На этот день вам не назначены смены в предварительном графике.'}</p>}</div>
    </section>
  </div>
}
