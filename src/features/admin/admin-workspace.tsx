import { useEffect,useId,useRef,useState } from 'react'
import { useLocation } from 'react-router-dom'
import AsyncPanel from '../../component/ui/async-panel.tsx'
import RequestErrorMessage from '../../component/ui/request-error-message.tsx'
import { useAdmin,useAdminData } from './admin-data.tsx'
import { AdminLink } from './admin-link.tsx'
import { AdminBadge,AdminIcon,date,Panel } from './admin-elements.tsx'
import { Loading,ReadError } from './admin-feedback.tsx'
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
 return <Panel title="Требует внимания"><ReadError error={error} retry={refresh} state={readState}/>{!data?<Loading error={error} retry={refresh}/>:<div className="admin-attention-grid"><section><header><h3>Критические сигналы</h3><AdminBadge tone={data.critical.total?'amber':'gray'}>{data.critical.total}</AdminBadge></header>{data.critical.items.map(item=><AdminLink key={item.id} to={'/admin/management/alerts/'+item.id}>{alertCatalog[item.key as AlertKey]?.title??'Критическое оповещение'}</AdminLink>)}{!data.critical.total&&<p>Открытых критических сигналов нет</p>}<AdminLink className="admin-text-link" to="/admin/management/alerts?view=active&severity=critical">Все критические</AdminLink></section><section><header><h3>Ошибки и задержки задач</h3><AdminBadge tone={data.jobs.total?'amber':'gray'}>{data.jobs.total}</AdminBadge></header>{data.jobs.items.map(item=><AdminLink key={item.kind+item.id} to={`/admin/operations/jobs/${item.kind}/${item.id}`}><span>{item.category}<small>{item.organizationName??item.userName} · {date(item.createdAt,true)}</small></span></AdminLink>)}{!data.jobs.total&&<p>За сутки проблемных задач нет</p>}<AdminLink className="admin-text-link" to="/admin/operations/jobs?attention=yes&days=1">Очередь за сутки</AdminLink></section><section><header><h3>Пригодная резервная копия</h3><AdminBadge tone={data.backup.stale?'amber':'gray'}>{data.backup.createdAt?`${Math.floor(data.backup.ageHours??0)} ч`:'Нет копии'}</AdminBadge></header><p>{data.backup.createdAt?'Создана '+date(data.backup.createdAt,true)+' · МСК':'Доступная проверенная копия не найдена.'}</p><p>{data.backup.stale?'Требуется проверить резервирование.':'Возраст копии в пределах порога правила.'}</p><AdminLink className="admin-text-link" to={'/admin/management/backups'+(data.backup.id?'?search='+data.backup.id:'')}>Проверить копию</AdminLink></section><section><header><h3>Разборы без ответственного</h3><AdminBadge tone={data.unassigned.total?'amber':'gray'}>{data.unassigned.total}</AdminBadge></header>{data.unassigned.items.map(item=><AdminLink key={item.id} to={'/admin/operations/support/'+item.id}><span>{incidentExplanation(item).title}<small>{date(item.createdAt,true)} · МСК</small></span></AdminLink>)}{!data.unassigned.total&&<p>За сутки неназначенных серверных и служебных сбоев нет</p>}<AdminLink className="admin-text-link" to="/admin/operations/support?days=1&assignment=unassigned&level=actionable">Все неназначенные за сутки</AdminLink></section></div>}</Panel>
}
