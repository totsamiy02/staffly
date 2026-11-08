import { useState,useEffect,useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { useDialogFocus } from '../../../component/ui/modal/dialog-focus.ts'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import CopyReference from '../../../component/ui/copy-reference.tsx'
import { useAdmin,useAdminData } from '../admin-data.tsx'
import { AdminLink as Link } from '../admin-link.tsx'
import { AdminHelp,AdminBadge,Empty,Pagination,Panel,date } from '../admin-elements.tsx'
import { Loading,ReadError } from '../admin-feedback.tsx'
import AdminTable from '../admin-table.tsx'
import type { AdministratorsState } from './contracts.ts'
import type { workState } from '../../../server/admin/management/work.ts'
type WorkState=Awaited<ReturnType<typeof workState>>
function Picker({close,pick,busy}:{close:()=>void;pick:(id:string)=>Promise<void>;busy:boolean}){
 const [term,setTerm]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1),[error,setError]=useState<Error|null>(null),ref=useRef<HTMLDivElement>(null)
 useDialogFocus(ref)
 useEffect(()=>{const timer=setTimeout(()=>{setSearch(term.trim());setPage(1)},350);return()=>clearTimeout(timer)},[term])
 const {data,readState}=useAdminData<AdministratorsState>('/management/administrators?status=active&search='+encodeURIComponent(search)+'&page='+page)
 return <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="assignee-title" className="admin-ops-dialog"><h2 id="assignee-title">Передать разбор</h2><p>Выберите администратора с действующим доступом. Изменение сохранится в истории.</p><label className="admin-management-field">Поиск ответственного<input autoFocus type="search" value={term} onChange={event=>setTerm(event.target.value)} placeholder="Имя или номер пользователя"/></label><ReadError state={readState}/>{error&&<p role="alert"><RequestErrorMessage error={error}/></p>}
  <div className="admin-assignee-options">{data?.items.map(person=><button type="button" className="admin-btn" key={person.id} disabled={busy||!person.ready} onClick={()=>{setError(null);void pick(person.id).catch(setError)}}><strong>{person.name}</strong><span>Пользователь №{person.publicId}</span></button>)}</div>
  {data&&!data.items.length&&<Empty>Действующие администраторы не найдены.</Empty>}{data&&<div className="admin-pagination"><span>{data.total} администраторов</span><div><button type="button" className="admin-btn" disabled={busy||page<=1} onClick={()=>setPage(page-1)}>Назад</button><span>{page} / {Math.max(1,Math.ceil(data.total/data.pageSize))}</span><button type="button" className="admin-btn" disabled={busy||page*data.pageSize>=data.total} onClick={()=>setPage(page+1)}>Далее</button></div></div>}
  <button type="button" className="admin-btn" disabled={busy} onClick={close}>Отмена</button>
 </section>
}
export default function WorkPanel({kind,id}:{kind:'alert'|'diagnostic';id:string}){
 const {user}=useAuth(),{request}=useAdmin(),[params]=useSearchParams(),[picker,setPicker]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<Error|null>(null)
 const {data,error:readError,refresh,readState}=useAdminData<WorkState>(`/management/work/${kind}/${id}?page=${params.get('workPage')??1}`),pending=useRef(false)
 async function assign(assigneeId:string|null){
  if(!data||pending.current)return
  pending.current=true;setBusy(true);setError(null)
  try{await request(`/management/work/${kind}/${id}/assign`,{method:'POST',body:{assigneeId,version:data.version,confirm:true}});setPicker(false);refresh()}
  catch(failure){refresh();const problem=failure instanceof Error?failure:new Error('Не удалось назначить ответственного.');setError(problem);throw problem}
  finally{pending.current=false;setBusy(false)}
 }
 return <Panel title="Ответственный за разбор" action={<AdminHelp label="Принятие и ответственность">Принятие оповещения означает просмотр. Ответственный назначается отдельно и продолжает разбор.</AdminHelp>}>
  <ReadError state={readState}/>{!data?<Loading error={readError} retry={refresh}/>:<><div className="admin-work-owner"><div>{data.assigneeId?<><Link to={'/admin/users/'+data.assigneeId}><strong>{data.assigneeName}</strong></Link><CopyReference value={String(data.assigneePublicId??data.assigneeId)} label="ID ответственного"/>{!data.assigneeAvailable&&<AdminBadge tone="amber">Доступ отозван — назначьте другого</AdminBadge>}</>:<strong>Ответственный не назначен</strong>}</div>{data.canAssign&&<div className="admin-actions">{data.assigneeId!==user?.id&&<button type="button" className="admin-btn admin-btn--primary" disabled={busy} onClick={()=>void assign(user!.id).catch(()=>{})}>Взять в работу</button>}<button type="button" className="admin-btn" disabled={busy} onClick={()=>setPicker(true)}>Передать разбор</button>{data.assigneeId&&<button type="button" className="admin-btn" disabled={busy} onClick={()=>void assign(null).catch(()=>{})}>Снять ответственного</button>}</div>}</div>
  {error&&<p role="alert"><RequestErrorMessage error={error}/></p>}<h3>История назначений</h3><AdminTable primary={[0,1,2]}><table><thead><tr><th>Кто изменил</th><th>Передача</th><th>Время · МСК</th></tr></thead><tbody>{data.history.items.map(item=><tr key={item.id}><td><Link to={'/admin/users/'+item.actorId}>{item.actor}</Link></td><td><span>Было: {item.from}</span><small>Стало: {item.to}</small></td><td>{date(item.at,true)}</td></tr>)}</tbody></table>{!data.history.items.length&&<Empty>Назначений пока не было.</Empty>}</AdminTable><Pagination {...data.history} pageKey="workPage"/>
  {picker&&<AnimatedOverlay variant="modal" className="admin-root admin-ops-overlay" dismissible={!busy} onClose={()=>setPicker(false)}>{close=><Picker close={close} busy={busy} pick={assign}/>}</AnimatedOverlay>}</>}
 </Panel>
}
