import { Link } from 'react-router-dom'
import { useDraftInbox, draftStatusLabels } from '../../../app/schedule/team-planning.ts'
import { displayDate, formatTime, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import PlanningIcon from './planning-icon.tsx'
import './team-planning.scss'
export default function DraftInbox({organization}:{organization:OrganizationSummary}) {
  const query=useDraftInbox(organization.id)
  if(query.isLoading)return <section className="planning-card draft-inbox"><p className="planning-footnote">Загружаем согласования графика…</p></section>
  if(query.isError)return <section className="planning-card draft-inbox"><p>Не удалось загрузить согласования. <button className="planning-text-button" onClick={()=>void query.refetch()}>Повторить</button></p></section>
  if(!query.data?.drafts.length)return null
  return <section className="draft-inbox"><header><span><PlanningIcon name="people"/></span><div><h2>Согласование графика</h2><p>Предварительные смены и ответы команды</p></div><Link className="app-secondary" to={`/app/organizations/${organization.id}/schedule/drafts?location=${organization.locationId}`}>Все графики →</Link></header>
    <div className="draft-inbox__cards">{query.data.drafts.slice(0,6).map(d=><Link className="planning-card" key={d.id} to={`/app/organizations/${organization.id}/schedule/drafts/${d.id}?location=${d.locationId}`}>
      <span className={`draft-status draft-status--${d.status.toLowerCase()}`}>{draftStatusLabels[d.status]}</span><strong>{d.title}</strong><p>{d.locationName} · {displayDate(d.fromDate)} — {displayDate(d.toDate)}</p>
      {d.deadline&&d.status==='OPEN'&&<small>Ответить до {displayDate(zonedDateAndTime(d.deadline,d.timezone).date)}, {formatTime(d.deadline,d.timezone)}</small>}
      <b>{d.canManage?(d.status==='CLOSED'?'Проверить и внести в расписание →':d.status==='PREPARING'?'Продолжить подготовку →':'Посмотреть ответы команды →'):d.needsResponse?'Посмотреть свои смены и ответить →':d.ownResponse==='NO_OBJECTIONS'?'Вы ознакомились, замечаний нет':d.ownResponse==='OBJECTIONS'?'Ваше замечание отправлено':'Посмотреть свои смены →'}</b>
    </Link>)}</div>
  </section>
}
