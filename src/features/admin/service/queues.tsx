import { jobLabels } from '../operations/presentation.ts'
import { AdminLink } from '../admin-link.tsx'
import { useEffect,useState } from 'react'
import { useAdmin,useAdminData } from '../admin-data.tsx'
import { AdminBadge,Panel,Empty,date } from '../admin-elements.tsx'
import AdminTable from '../admin-table.tsx'
import AdminDisclosure from '../admin-disclosure.tsx'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import { ServiceDialog } from './elements.tsx'
import type { previewQueue } from '../../../server/admin/service/actions.ts'
import type { queueState,queueDetails } from '../../../server/admin/service/read-model.ts'
type Ref={kind:'email'|'report';id:string}
type Preview=Awaited<ReturnType<typeof previewQueue>>
export function QueueActions({jobs,refresh,hideRetry=false}:{jobs:Ref[];refresh:()=>void;hideRetry?:boolean}){
 const {request}=useAdmin(),[command,setCommand]=useState<'retry'|'cancel'|null>(null),[prepared,setPrepared]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<Error|null>(null),[batch,setBatch]=useState<string|null>(null)
 async function begin(value:'retry'|'cancel'){setBusy(true);setError(null);try{const preview=await request<Preview>('/service/queues/preview',{method:'POST',body:{jobs,command:value}});setPrepared(preview);setCommand(value)}catch(e){setError(e as Error)}finally{setBusy(false)}}
 return <><div className="admin-actions">{!hideRetry&&<button className="admin-btn" disabled={busy||!jobs.length||jobs.length>20} onClick={()=>void begin('retry')}>Повторить {jobs.length===1?'задачу':'выбранные'}</button>}<button className="admin-btn" disabled={busy||!jobs.length||jobs.length>20} onClick={()=>void begin('cancel')}>Отменить {jobs.length===1?'задачу':'выбранные'}</button>{jobs.length>1&&<small>Выбрано {jobs.length} из 20 допустимых</small>}</div>{error&&<p role="alert"><RequestErrorMessage error={error}/></p>}{batch&&<BatchResult id={batch}/>}
 {command&&prepared&&<ServiceDialog title={command==='retry'?'Повтор задач':'Отмена задач'} build={reason=>({action:'QUEUE_ACTION',payload:{reason,command,jobs:prepared.map(j=>({kind:j.kind,id:j.id,expectedStatus:j.expectedStatus||'UNKNOWN',expectedAttempts:j.expectedAttempts}))}})} onClose={()=>{setCommand(null);setPrepared(null)}} onDone={result=>{setCommand(null);setPrepared(null);setBatch(result.resourceId);refresh()}}/>}
 </>
}
function BatchResult({id}:{id:string}){
 const {data,error,refresh}=useAdminData<{results:Array<Ref&{reason:string;result:string;currentStatus:string|null;attempts:number|null}>}>('/service/batches/'+id)
 return <div className="admin-service-preview" role="status"><h3>Результат обработки группы</h3>{error&&<p role="alert"><RequestErrorMessage error={error}/><button className="admin-btn" onClick={refresh}>Обновить</button></p>}{data?<ul>{data.results.map((row,index)=><li key={row.id+index}><AdminBadge tone={row.result==='OK'?'green':'amber'}>{row.result==='OK'?'Запрос применён':'Пропущено'}</AdminBadge> <AdminLink to={'/admin/operations/jobs/'+row.kind+'/'+row.id}>{row.kind==='email'?'Письмо':'Выгрузка'} · {row.id}</AdminLink><span>{row.reason}</span>{row.currentStatus&&<small>Сейчас: {row.currentStatus==='SENT'?'Доставлено':row.currentStatus==='READY'?'Готово':jobLabels[row.currentStatus as keyof typeof jobLabels]??row.currentStatus} · попыток: {row.attempts}</small>}</li>)}</ul>:!error&&<p>Получаем результат…</p>}</div>
}
export function QueueAge(){const {data}=useAdminData<Awaited<ReturnType<typeof queueState>>>('/service/queues');return data?<div className="admin-queue-age" aria-label="Задержка очередей">{data.queues.map(q=><div key={q.kind}><strong>{q.kind==='email'?'Письма':'Выгрузки'}</strong><span>{q.pending} ожидают · {q.delayed} задержаны</span><small>Возраст старейшей: {q.oldest_seconds===null?'нет задач':Math.max(0,Math.round(q.oldest_seconds/60))+' мин.'}</small></div>)}</div>:null}
export function QueueHistory({kind,id,refresh,hideRetry=false}:{kind:'email'|'report';id:string;refresh:()=>void;hideRetry?:boolean}){
 const {request}=useAdmin(),{data,error,readState,refresh:refreshHistory}=useAdminData<Awaited<ReturnType<typeof queueDetails>>>('/service/queues/'+kind+'/'+id),[eligibility,setEligibility]=useState<Preview|null>(null)
 useEffect(()=>{const controller=new AbortController();void request<Preview>('/service/queues/preview',{method:'POST',body:{jobs:[{kind,id}],command:'retry'},signal:controller.signal}).then(setEligibility).catch(()=>{});return()=>controller.abort()},[kind,id,request,data?.history.length])
 return <Panel title="Управление и история задачи">{eligibility?.[0]&&eligibility[0].code!=='OK'&&<p className="admin-note">Повтор недоступен: {eligibility[0].reason}.</p>}<QueueActions jobs={[{kind,id}]} hideRetry={hideRetry} refresh={()=>{refresh();refreshHistory()}}/>{error&&<p role="alert"><RequestErrorMessage error={error}/></p>}<AdminDisclosure label="История попыток">{data&&<><AdminTable primary={[0,1,2,3]}><table><thead><tr><th>Попытка</th><th>Состояние</th><th>Причина</th><th>Время · МСК</th></tr></thead><tbody>{data.history.map((row,index)=><tr key={index}><td>{row.attempt}</td><td>{row.status==='SENT'?'Доставлено':row.status==='READY'?'Готово':jobLabels[row.status as keyof typeof jobLabels]??row.status}</td><td>{row.error_code??'—'}</td><td>{date(row.occurred_at,true)}</td></tr>)}</tbody></table>{!data.history.length&&<Empty>Для этой задачи пока нет сохранённых переходов.</Empty>}</AdminTable><small>{data.historyNote}</small></>}{readState.applying&&<p role="status">Обновляем историю…</p>}</AdminDisclosure></Panel>
}
