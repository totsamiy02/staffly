import { useEffect,useId,useRef,useState } from 'react'
import AdminDisclosure from './admin-disclosure.tsx'
import { useLocation } from 'react-router-dom'
import AsyncPanel from '../../component/ui/async-panel.tsx'
import RequestErrorMessage from '../../component/ui/request-error-message.tsx'
import { useAdmin,useAdminData } from './admin-data.tsx'
import { AdminLink } from './admin-link.tsx'
import { AdminBadge,AdminIcon,date,Panel } from './admin-elements.tsx'
import { ReadError } from './admin-feedback.tsx'
import { incidentExplanation } from './operations/diagnostic-presentation.ts'
import { alertCatalog,type AlertKey } from './management/catalog.ts'
import type { globalSearch,attentionState } from '../../server/admin/workspace.ts'
type Search=Awaited<ReturnType<typeof globalSearch>>
type Attention=Awaited<ReturnType<typeof attentionState>>
export function WorkspaceControls(){
 const {request}=useAdmin(),location=useLocation(),id=useId(),host=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),results=useRef<HTMLDivElement>(null)
 const [term,setTerm]=useState(''),[open,setOpen]=useState(false),[result,setResult]=useState<Search|null>(null),[error,setError]=useState<Error|null>(null),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0)
 const shown=open&&Boolean(term.trim()),hasResults=result?.groups.some(group=>group.total>0)
 useEffect(()=>{setOpen(false)},[location.pathname,location.search])
 useEffect(()=>{const outside=(event:PointerEvent)=>{if(!host.current?.contains(event.target as Node))setOpen(false)},other=(event:Event)=>{if((event as CustomEvent<string>).detail!==id)setOpen(false)};document.addEventListener('pointerdown',outside,true);document.addEventListener('staffly:popover-open',other);return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('staffly:popover-open',other)}},[id])
 useEffect(()=>{const controller=new AbortController();if(!shown){setBusy(false);return}setError(null);setResult(previous=>previous?.search===term.trim()?previous:null);setBusy(true);const timer=setTimeout(()=>{void request<Search>('/search?search='+encodeURIComponent(term.trim()),{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setResult(value)}).catch(problem=>{if(!controller.signal.aborted)setError(problem)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})},300);return()=>{clearTimeout(timer);controller.abort()}},[term,shown,request,retry])
 const show=()=>{document.dispatchEvent(new CustomEvent('staffly:popover-open',{detail:id}));setOpen(true)}
 return <div ref={host} className="admin-header-search" onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))setOpen(false)}} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);input.current?.focus();return}
  if(!shown||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
  const links=[...results.current?.querySelectorAll<HTMLAnchorElement>('a[href]')??[]];if(!links.length)return
  if(['Home','End'].includes(event.key)&&document.activeElement===input.current)return
  event.preventDefault();const current=links.indexOf(document.activeElement as HTMLAnchorElement),next=event.key==='Home'?0:event.key==='End'?links.length-1:event.key==='ArrowDown'?(current+1)%links.length:(current-1+links.length)%links.length;links[next].focus()
 }}><label className="admin-search"><AdminIcon name="search"/><span className="admin-sr-only">Поиск по сервису</span><input ref={input} type="search" maxLength={120} value={term} placeholder="Найти пользователя, организацию, задачу…" aria-controls={id} onFocus={event=>{if(!event.relatedTarget||!host.current?.contains(event.relatedTarget))show()}} onClick={()=>{if(term.trim())show()}} onChange={event=>{setTerm(event.target.value);results.current?.scrollTo({top:0});if(!open)show()}}/></label>
  <div id={id} ref={results} role="region" aria-label="Результаты поиска" className={`admin-search-popover ${shown?'is-open':''}`} aria-hidden={!shown} inert={!shown}>
   <AsyncPanel pending={shown&&busy&&!result} identity={term.trim()} minHeight={56} label="Поиск по сервису" pendingContent={<p className="admin-search-state">Ищем…</p>}>{error&&<div className="admin-search-state" role="alert"><RequestErrorMessage error={error}/><button className="admin-btn" onClick={()=>setRetry(value=>value+1)}>Повторить</button></div>}
   {result&&<div key={result.search} className="admin-search-groups">{result.groups.filter(group=>group.total>0).map(group=><section key={group.key}><header><h3>{group.title}</h3><span>{group.total}</span></header>{group.items.map(item=><AdminLink key={item.id} to={item.href} onClick={()=>setOpen(false)}><strong>{item.title}</strong><small>{item.note}</small></AdminLink>)}{group.total>group.items.length&&<AdminLink className="admin-search-more" to={group.href} onClick={()=>setOpen(false)}>Все результаты ({group.total})</AdminLink>}</section>)}</div>}
   {result&&!hasResults&&<p className="admin-search-state" role="status">Ничего не найдено. Попробуйте имя, номер или код ошибки.</p>}
   </AsyncPanel>
  </div>
 </div>
}
export function AttentionPanel(){
 const {data,error,refresh,readState}=useAdminData<Attention>('/attention')
 const issues=data?Number(data.critical.total>0)+Number(data.jobs.total>0)+Number(data.backup.stale)+Number(data.unassigned.total>0):0
 const rows=data?[
  {key:'critical',title:'Критические сигналы',warning:data.critical.total>0,status:data.critical.total?`${data.critical.total} открыто`:'Нет сигналов',description:data.critical.total?'Открытые сигналы требуют разбора.':'Открытых критических сигналов нет.',href:'/admin/management/alerts?view=active&severity=critical',action:'Все критические',details:<>{data.critical.items.map(item=><AdminLink key={item.id} to={'/admin/management/alerts/'+item.id}>{alertCatalog[item.key as AlertKey]?.title??'Критическое оповещение'}</AdminLink>)}</>},
  {key:'jobs',title:'Ошибки и задержки задач',warning:data.jobs.total>0,status:data.jobs.total?`${data.jobs.total} за сутки`:'Без ошибок',description:data.jobs.total?'Есть задачи, требующие проверки.':'За сутки проблемных задач нет.',href:'/admin/operations/jobs?attention=yes&days=1',action:'Очередь за сутки',details:<>{data.jobs.items.map(item=><AdminLink key={item.kind+item.id} to={`/admin/operations/jobs/${item.kind}/${item.id}`}><span>{item.category}<small>{item.organizationName??item.userName} · {date(item.createdAt,true)}</small></span></AdminLink>)}</>},
  {key:'backup',title:'Пригодная резервная копия',warning:data.backup.stale,status:data.backup.createdAt?`${Math.floor(data.backup.ageHours??0)} ч`:'Нет копии',description:data.backup.stale?(data.backup.createdAt?'Требуется проверить резервирование.':'Доступная проверенная копия не найдена.'):'Возраст копии в пределах порога правила.',href:'/admin/management/backups'+(data.backup.id?'?search='+data.backup.id:''),action:'Проверить копию',details:<>{data.backup.createdAt&&<p>Создана {date(data.backup.createdAt,true)} · МСК</p>}</>},
  {key:'unassigned',title:'Разборы без ответственного',warning:data.unassigned.total>0,status:data.unassigned.total?`${data.unassigned.total} за сутки`:'Назначены',description:data.unassigned.total?'Сбоям за сутки нужен ответственный.':'За сутки неназначенных серверных и служебных сбоев нет.',href:'/admin/operations/support?days=1&assignment=unassigned&level=actionable',action:'Все неназначенные за сутки',details:<>{data.unassigned.items.map(item=><AdminLink key={item.id} to={'/admin/operations/support/'+item.id}><span>{incidentExplanation(item).title}<small>{date(item.createdAt,true)} · МСК</small></span></AdminLink>)}</>},
 ]:[]
 return <Panel title="Состояние системы" subtitle="Сигналы, задачи и резервирование" className="admin-overview-system" action={data&&<AdminBadge tone={issues?'amber':'green'}>{issues?`Проверить: ${issues} из 4`:'Всё в порядке'}</AdminBadge>}>
  <ReadError error={error} retry={refresh} state={readState}/>
  {!data?!error&&<p className="admin-overview-loading" role="status">Проверяем состояние…</p>:<div className="admin-overview-checks">{rows.map(row=><div key={row.key} className={`admin-overview-check ${row.warning?'is-warning':''} ${row.warning&&row.key==='critical'?'is-critical':''}`}>
   <AdminDisclosure label={<><span className="admin-overview-check-icon"><AdminIcon name={row.warning?'bell':'check'}/></span><span className="admin-overview-check-label"><strong>{row.title}</strong><small>{row.description}</small><AdminBadge tone={row.warning?'amber':'green'}>{row.status}</AdminBadge></span></>}>
    {row.details}<AdminLink className="admin-text-link" to={row.href}>{row.action} <span aria-hidden="true">→</span></AdminLink>
   </AdminDisclosure>
  </div>)}</div>}
  <div className="admin-panel-footer"><AdminLink to="/admin/management/alerts">Все оповещения</AdminLink><AdminLink to="/admin/operations/service">Все проверки <span aria-hidden="true">→</span></AdminLink></div>
 </Panel>
}
