import DatePicker from '../../../component/ui/date-picker/date-picker.tsx'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useLocations } from '../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { useMemberProfile } from '../../../app/member-profile/context.tsx'
import { canAccess } from '../../../app/access/catalog.ts'
import PageHeading from '../../../component/ui/page-heading/page-heading.tsx'
import Select from '../../../component/ui/select/select.tsx'
import MemberInvitations from './member-invitations.tsx'
import type { listFormerMembers } from '../../../server/organizations/member-archive.ts'
type Archive = Awaited<ReturnType<typeof listFormerMembers>>
const date = (value: Date|string|null) => value ? new Date(value).toLocaleDateString('ru-RU') : 'Неизвестно'
export default function MemberArchive({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest, locationId } = useAuth(), profile=useMemberProfile(), points=useLocations(organization.id)
  const [search,setSearch]=useState(''),[term,setTerm]=useState(''),[point,setPoint]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[page,setPage]=useState(1),[inviting,setInviting]=useState(false)
  useEffect(()=>{const timer=setTimeout(()=>setTerm(search.trim()),300);return()=>clearTimeout(timer)},[search])
  const query=new URLSearchParams({state:'former',page:String(page),pageSize:'20'})
  if(term)query.set('search',term);if(point)query.set('pointId',point)
  if(from)query.set('departedFrom',from)
  if(to)query.set('departedTo',to)
  const archive=useQuery({queryKey:['organization-members',organization.id,'archive',query.toString(),locationId],queryFn:()=>apiRequest<Archive>(`/organizations/${organization.id}/members?${query}`)})
  return <section className="members-page member-archive-page"><PageHeading title="Архив сотрудников" description="Бывшие сотрудники и сохранённая рабочая история." actions={canAccess(organization,'members.invite')&&<button className="app-primary" onClick={()=>setInviting(true)}>Повторно пригласить</button>}/>
    <p>Повторный приём выполняется обычным приглашением. Прежние полномочия не возвращаются автоматически.</p>
    <div className="members-toolbar"><label><span>Поиск бывшего сотрудника</span><input type="search" value={search} onChange={e=>{setSearch(e.target.value);setPage(1)}} placeholder="ФИО или доступная электронная почта"/></label><label><span>Последняя точка</span><Select value={point} onChange={e=>{setPoint(e.target.value);setPage(1)}}><option value="">Все доступные точки</option>{points.data?.locations.filter(p=>organization.owner||p.permissions?.includes('members.remove')).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label><label><span>Исключён с</span><DatePicker aria-label={from?'Исключён с':'Исключён с: выберите дату'} value={from} max={to||undefined} onChange={e=>{setFrom(e.target.value);setPage(1)}}/></label><label><span>Исключён по</span><DatePicker aria-label={to?'Исключён по':'Исключён по: выберите дату'} value={to} min={from||undefined} onChange={e=>{setTo(e.target.value);setPage(1)}}/></label></div>
    {archive.isPending?<div className="app-state" role="status">Загружаем архив…</div>:archive.isError?<div className="app-state" role="alert"><p>{archive.error.message}</p><button className="app-secondary" onClick={()=>void archive.refetch()}>Повторить</button></div>:<><p className="members-count">Найдено: {archive.data.pagination.total}</p>{!archive.data.members.length?<div className="app-state">Бывшие сотрудники по этим условиям не найдены.</div>:<div className="member-archive-list">{archive.data.members.map(member=><article className="member-archive-card" key={member.id}><div><strong>{member.displayName}</strong>{member.email&&<p>{member.email}</p>}<p>Первое вступление: {date(member.joinedAt)} · Исключён: {date(member.leftAt)}</p><p>{member.locations.map(p=>p.name).join(' · ')}</p></div><details><summary>Периоды работы</summary><ul>{member.periods.map(period=><li key={period.id}>{date(period.startedAt)} — {period.endedAt?date(period.endedAt):'Продолжается'}{period.incomplete&&<p>Неполная история: начало периода и прежние повторные приёмы не зафиксированы.</p>}</li>)}</ul></details><button className="app-secondary" onClick={()=>profile?.open(member.id,{locationId:point||member.locations[0]?.id||organization.locationId})}>Рабочая история</button></article>)}</div>}<nav className="members-pagination" aria-label="Страницы архива"><button className="app-secondary" disabled={page<=1||archive.isFetching} onClick={()=>setPage(p=>p-1)}>Назад</button><span>Страница {page} из {archive.data.pagination.pages}</span><button className="app-secondary" disabled={page>=archive.data.pagination.pages||archive.isFetching} onClick={()=>setPage(p=>p+1)}>Далее</button></nav></>}
    {inviting&&<MemberInvitations organization={organization} onClose={()=>setInviting(false)}/>}
  </section>
}
