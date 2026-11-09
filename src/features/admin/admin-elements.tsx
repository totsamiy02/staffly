import { AdminLink as Link } from './admin-link.tsx'
import AdminTable from './admin-table.tsx'
import Avatar from '../../component/ui/avatar/avatar.tsx'
/* oxlint-disable react/only-export-components -- Pure display formatting is shared with the monitoring pages. */
import HelpTip from '../../component/ui/help-tip/help-tip.tsx'
import type { ReactNode } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { OrganizationMonitor } from './contracts.ts'
export { default as LineChart } from './admin-chart.tsx'
import { plans } from '../../app/subscriptions/plans.ts'

const paths:Record<string,ReactNode>={
 home:<><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></>,
 org:<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 15h1m4 0h1M10 21v-3h4v3"/></>,
 users:<><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/></>,
 pulse:<path d="M2 12h5l3-8 4 16 3-8h5"/>,
 chart:<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>,
 server:<><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.1m0 11h.1M12 6.5h5m-5 11h5"/></>,
 layers:<><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h.1M11 8h5M8 12h.1M11 12h5M8 16h.1M11 16h5"/></>,
 shield:<><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
 help:<><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3v2m-1 3h.1"/></>,
 database:<><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>,
 key:<><circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/></>,
 bell:<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4"/>,
 lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/></>,
 search:<><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,refresh:<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>,calendar:<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18M7 15h2m6 0h2"/></>,clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,mail:<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></>,disk:<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 14h18M7 17h.1m4 0h.1"/></>,menu:<path d="M4 6h16M4 12h16M4 18h16"/>,logout:<path d="M10 4H4v16h6m4-13 5 5-5 5M9 12h10"/>,chevron:<path d="m6 9 6 6 6-6"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,check:<path d="m5 12 4 4L19 6"/>,
}
export function AdminIcon({name}:{name:string}){return <svg className="admin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.shield}</svg>}
export function AdminBadge({children,tone='gray'}:{children:ReactNode;tone?:'green'|'amber'|'gray'|'purple'}){return <span className={`admin-badge admin-badge--${tone}`}>{children}</span>}
export function AdminHelp({children,label,className=''}:{children:ReactNode;label:string;className?:string}){return <HelpTip label={label} className={'admin-help '+className}>{children}</HelpTip>}
export function Stat({label,value,note,help,suffix}:{label:string;value:ReactNode;note?:ReactNode;help?:ReactNode;icon:string;suffix?:string}){return <article className="admin-stat"><div><span>{label}</span>{help&&<AdminHelp label={'Как считается «'+label+'»'}>{help}</AdminHelp>}</div><strong>{value}{suffix&&<small>{suffix}</small>}</strong>{note&&<p>{note}</p>}</article>}
export function Panel({title,subtitle,action,children,className=''}:{title:string;subtitle?:string;action?:ReactNode;children:ReactNode;className?:string}){return <section className={`admin-panel ${className}`}><header><div><div className="admin-panel-heading"><h2>{title}</h2></div>{subtitle&&<p>{subtitle}</p>}</div>{action}</header>{children}</section>}
const parentModules:Array<[RegExp,string,string]>=[[/^\/admin\/organizations\/[^/]+$/,'/admin/organizations','К организациям'],[/^\/admin\/users\/[^/]+$/,'/admin/users','К пользователям'],[/^\/admin\/operations\/jobs\/[^/]+\/[^/]+$/,'/admin/operations/jobs','К фоновым задачам'],[/^\/admin\/operations\/support\/[^/]+$/,'/admin/operations/support','К диагностике'],[/^\/admin\/management\/alerts\/[^/]+$/,'/admin/management/alerts','К оповещениям']]
export const adminParent=(pathname:string):[RegExp,string,string]|undefined=>{
 const detail=pathname.match(/^\/admin\/(users|organizations)\/([^/]+)\/service\/?$/)
 if(detail)return[/service$/,'/admin/'+detail[1]+'/'+detail[2],detail[1]==='users'?'К профилю пользователя':'К карточке организации']
 if(pathname==='/admin/operations/maintenance')return[/maintenance$/,'/admin/operations/service','К состоянию сервиса']
 if(pathname==='/admin/operations/access')return[/access$/,'/admin/operations/support','К поддержке']
 return parentModules.find(([pattern])=>pattern.test(pathname.replace(/\/$/,'')))
}
export function PageHead({title,subtitle,actions,backTo,image}:{title:string;subtitle?:string;actions?:ReactNode;backTo?:string;image?:ReactNode}){
 const navigate=useNavigate(),route=useLocation(),parent=adminParent(route.pathname),source=route.state?.adminReturn
 const sameList=parent&&typeof source?.url==='string'&&source.url.split('?')[0]===parent[1],target=sameList?source.url:parent?.[1]??backTo
 return <>{parent&&<div className="admin-breadcrumb"><button type="button" className="admin-back" onClick={()=>void navigate(target!,{replace:true,state:sameList?{adminRestoreKey:source.key,adminReturn:source.previous}:null})}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true"><path d="m11 5-5 5 5 5M6 10h10"/></svg>{parent[2]}</button></div>}<header className="admin-page-head"><div className="admin-title-group"><div className="admin-heading-with-image">{image}<h1>{title}</h1></div>{subtitle&&<p>{subtitle}</p>}</div>{actions&&<div className="admin-actions">{actions}</div>}</header></>
}
export function initials(name:string){return name.trim().split(/\s+/).slice(0,2).map(n=>n[0]).join('').toUpperCase()||'О'}
export const count=(value:number)=>new Intl.NumberFormat('ru-RU').format(value)
export function bytes(value:number){return value>=1024**3?`${(value/1024**3).toLocaleString('ru-RU',{maximumFractionDigits:1})} ГБ`:value>=1024**2?`${Math.round(value/1024**2)} МБ`:`${Math.round(value/1024)} КБ`}
export function date(value:string|null,withTime=false){return value?new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',year:'numeric',...(withTime?{hour:'2-digit',minute:'2-digit'}:{})}):'Пока нет данных'}
export function OrganizationName({organization}:{organization:OrganizationMonitor}){return <Link className="admin-org-name" to={`/admin/organizations/${organization.id}`}><Avatar url={organization.logoUrl} name={organization.name} className="admin-mark"/><span><strong>{organization.name}</strong>{organization.serviceState==='SUSPENDED'&&<AdminBadge tone="amber">Приостановлена</AdminBadge>}<small>Создана {date(organization.createdAt)}</small></span></Link>}
export function Meter({label,used,limit,format=count}:{label:string;used:number;limit:number;format?:(value:number)=>string}){return <div className="admin-meter-block"><div><span>{label}</span><small>{format(used)} из {format(limit)}</small></div><div className={`admin-meter ${used>=limit?'is-full':''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used,limit)}><i style={{width:`${Math.min(100,used/limit*100)}%`}}/></div>{used>=limit&&<p>Лимит достигнут</p>}</div>}
export function Pagination({total,page,pageSize,pageKey='page'}:{total:number;page:number;pageSize:number;pageKey?:string}){const [params,setParams]=useSearchParams();const pending=Number(params.get(pageKey)??1)!==page;const go=(n:number)=>{const next=new URLSearchParams(params);next.set(pageKey,String(n));setParams(next)};return <footer className="admin-pagination"><span>{total?`${(page-1)*pageSize+1}–${Math.min(page*pageSize,total)} из ${count(total)}`:'Нет записей'}</span><div><button className="admin-btn" disabled={pending||page<=1} onClick={()=>go(page-1)}>Назад</button><span>{page} / {Math.max(1,Math.ceil(total/pageSize))}</span><button className="admin-btn" disabled={pending||page*pageSize>=total} onClick={()=>go(page+1)}>Далее</button></div></footer>}
export function Range({days,onChange}:{days:number;onChange:(days:number)=>void}){return <div className="admin-range">{[[1,'24 часа'],[7,'7 дней'],[30,'30 дней'],[90,'90 дней'],[365,'Год'],[0,'Всё время']].map(([value,label])=><button key={value} type="button" aria-pressed={days===value} onClick={()=>onChange(Number(value))}>{label}</button>)}</div>}
export function Empty({children}:{children:ReactNode}){return <div className="admin-empty"><p>{children}</p></div>}
export function OrganizationTable({items,onlineOnly=false}:{items:OrganizationMonitor[];onlineOnly?:boolean}){return <AdminTable primary={onlineOnly?[0,1,3]:[0,1,5]} actions={[onlineOnly?4:6]}><table><thead><tr><th>Организация</th>{onlineOnly?<><th>Пользователей онлайн</th><th>Активных сеансов</th><th>Активность</th></>:<><th>Тариф</th><th>Участники</th><th>Точки</th><th>Хранилище</th><th>Активность</th></>}<th><span className="admin-sr-only">Действия</span></th></tr></thead><tbody>{items.map(o=><tr key={o.id}><td><OrganizationName organization={o}/></td>{onlineOnly?<><td>{o.online}</td><td>{o.onlineSessions}</td><td><AdminBadge tone="green">Сейчас</AdminBadge></td></>:<><td><AdminBadge tone={o.subscription.effectivePlan==='BUSINESS'?'purple':'gray'}>{plans[o.subscription.effectivePlan].name}</AdminBadge></td><td>{o.members} / {o.subscription.limits.members}</td><td>{o.locations} / {o.subscription.limits.locations}</td><td>{bytes(o.storageBytes)} / {bytes(o.subscription.limits.storageBytes)}</td><td>{o.online?<AdminBadge tone="green">{o.online} онлайн</AdminBadge>:<small>{date(o.lastActiveAt,true)}</small>}</td></>}<td><Link className="admin-btn" to={`/admin/organizations/${o.id}`}>Подробнее</Link></td></tr>)}</tbody></table>{!items.length&&<Empty>Организации по выбранным условиям не найдены.</Empty>}</AdminTable>}
