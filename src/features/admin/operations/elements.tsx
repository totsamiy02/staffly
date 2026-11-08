import AdminPopover from '../admin-popover.tsx'
import AdminTable from '../admin-table.tsx'
import CopyReference from '../../../component/ui/copy-reference.tsx'
import { SupportReference } from '../../../component/ui/request-error-message.tsx'
import { useRef,useState,type ReactNode } from 'react'
import { AdminLink as Link } from '../admin-link.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { useDialogFocus } from '../../../component/ui/modal/dialog-focus.ts'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import { useAdmin } from '../admin-data.tsx'
import { AdminHelp,AdminBadge,AdminIcon,Empty,Pagination,Stat,count,date } from '../admin-elements.tsx'
import { jobLabels,jobProblem } from './presentation.ts'
import type { JobStatus,JobsState,OperationalJob } from './contracts.ts'

export function JobBadge({status}:{status:JobStatus}){return <AdminBadge tone={status==='DONE'?'green':status==='FAILED'||status==='RETRY'?'amber':status==='RUNNING'?'purple':'gray'}>{jobLabels[status]??'Неизвестно'}</AdminBadge>}
export function EntityLinks({organizationId,organizationName,userId,userName,organizationPublicId,userPublicId,compact=false}:{compact?:boolean;organizationPublicId?:number|null;userPublicId?:number|null;organizationId:string|null;organizationName:string|null;userId:string|null;userName:string|null}){
  return <div className="admin-ops-entities">{organizationId?<Link to={'/admin/organizations/'+organizationId}><AdminIcon name="org"/>{organizationName??'Организация'}</Link>:<span>Вне организации</span>}{userId&&<Link to={'/admin/users/'+userId}><AdminIcon name="users"/>{userName||'Пользователь'}</Link>}{!compact&&organizationId&&<CopyReference value={String(organizationPublicId??organizationId)} label="ID организации"/>}{!compact&&userId&&<CopyReference value={String(userPublicId??userId)} label="ID пользователя"/>}</div>
}
export { default as OperationsToolbar } from '../admin-filters.tsx'
export function JobSummary({summary}:{summary:JobsState['summary']}){
  const sum=(...statuses:JobStatus[])=>summary.filter(row=>statuses.includes(row.status)).reduce((n,row)=>n+row.count,0)
  return <div className="admin-stats"><Stat label="В очереди" value={count(sum('PENDING','SCHEDULED','RETRY'))} icon="layers"/><Stat label="Выполняются" value={count(sum('RUNNING'))} icon="pulse"/><Stat label="Завершены" value={count(sum('DONE','SKIPPED'))} note="включая неактуальные письма" icon="check"/><Stat label="С ошибкой" value={count(sum('FAILED'))} icon="help"/></div>
}
export function JobTable({data}:{data:JobsState}){
  return <><AdminTable primary={[0,2,4]} actions={[5]}><table><thead><tr><th>Задача</th><th>Организация / пользователь</th><th>Состояние</th><th>Попытки</th><th>Создана · МСК</th><th><span className="admin-sr-only">Действия</span></th></tr></thead><tbody>{data.items.map(job=><tr key={job.kind+job.id}><td><strong>{job.category}</strong><AdminPopover label="ID задачи"><SupportReference value={job.id} label="ID задачи"/></AdminPopover></td><td><EntityLinks {...job} compact/></td><td><div className="admin-field-heading"><JobBadge status={job.status}/>{jobProblem(job)&&<AdminHelp label="Причина состояния задачи">{jobProblem(job)}</AdminHelp>}</div></td><td>{job.attempts} / {job.maxAttempts}</td><td>{date(job.createdAt,true)}</td><td><Link className="admin-btn" to={`/admin/operations/jobs/${job.kind}/${job.id}`}>Диагностика</Link></td></tr>)}</tbody></table>{!data.items.length&&<Empty>По этим условиям задач нет. Письма появляются после уведомлений, выгрузки — после запуска отчёта. Попробуйте убрать фильтры или выбрать всю историю; действующие задачи показываются независимо от периода.</Empty>}</AdminTable><Pagination {...data}/></>
}
export function KeyValues({items}:{items:Array<[string,ReactNode]>}){return <dl className="admin-key-values admin-ops-values">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
export function CopyDiagnostics({text}:{text:string}){
  const ref=useRef<HTMLTextAreaElement>(null),[state,setState]=useState<'idle'|'copied'|'manual'>('idle')
  return <div className="admin-ops-copy"><textarea ref={ref} aria-label="Диагностика для копирования" value={text} readOnly spellCheck={false}/><div className="admin-actions"><button className="admin-btn" onClick={()=>void(async()=>{try{await navigator.clipboard.writeText(text);setState('copied')}catch{setState('manual');ref.current?.focus();ref.current?.select()}})()}><AdminIcon name="layers"/>{state==='copied'?'Скопировано':'Скопировать диагностику'}</button><span role="status">{state==='manual'?'Текст выделен — скопируйте его вручную.':state==='copied'?'Диагностика в буфере обмена.':''}</span></div></div>
}
function RetrySurface({job,close,onDone,busy,setBusy}:{job:OperationalJob;close:()=>void;onDone:()=>void;busy:boolean;setBusy:(value:boolean)=>void}){
  const {request}=useAdmin(),ref=useRef<HTMLDivElement>(null),pending=useRef(false),[error,setError]=useState<Error|null>(null)
  useDialogFocus(ref)
  return <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="admin-retry-heading" className="admin-ops-dialog"><header><div className="admin-auth-symbol"><AdminIcon name="layers"/></div><button type="button" className="admin-icon-button" aria-label="Закрыть подтверждение" disabled={busy} onClick={close}><AdminIcon name="close"/></button></header><h2 id="admin-retry-heading">Повторить подготовку отчёта?</h2><p>Задача вернётся в очередь. Обработчик проверит актуальные права создателя и подготовит отчёт по сохранённым параметрам.</p><KeyValues items={[["Организация",job.organizationName??'—'],['Задача',<code key="id">{job.id}</code>],['Использовано попыток',`${job.attempts} из ${job.maxAttempts}`],['Доступна до',date(job.expiresAt,true)]]}/>{error&&<div role="alert"><RequestErrorMessage error={error}/></div>}<div className="admin-actions"><button className="admin-btn" disabled={busy} onClick={close}>Отмена</button><button className="admin-btn admin-btn--primary" disabled={busy} onClick={()=>{if(pending.current)return;pending.current=true;setBusy(true);setError(null);void request('/operations/jobs/report/'+job.id+'/retry',{method:'POST',body:{confirm:true}}).then(onDone).catch(e=>setError(e)).finally(()=>{pending.current=false;setBusy(false)})}}>{busy?'Возвращаем в очередь…':'Повторить подготовку'}</button></div></section>
}
export function RetryReportDialog({job,onClose,onDone}:{job:OperationalJob;onClose:()=>void;onDone:()=>void}){
  const [busy,setBusy]=useState(false)
  return <AnimatedOverlay variant="modal" className="admin-root admin-ops-overlay" onClose={onClose} dismissible={!busy}>{close=><RetrySurface job={job} busy={busy} setBusy={setBusy} close={close} onDone={()=>{onClose();onDone()}}/>}</AnimatedOverlay>
}
