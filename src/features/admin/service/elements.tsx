/* oxlint-disable react/only-export-components -- Shared service forms and formatting. */
import { useRef,useState,type ReactNode } from 'react'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { useDialogFocus } from '../../../component/ui/modal/dialog-focus.ts'
import DatePicker,{TimeInput} from '../../../component/ui/date-picker/date-picker.tsx'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import { useAdmin } from '../admin-data.tsx'
import { AdminIcon } from '../admin-elements.tsx'
import { ManagementActionDialog } from '../management/action-dialog.tsx'
import type { ActionSpec,ManagementResult } from '../management/contracts.ts'
import type { previewServiceAction } from '../../../server/admin/service/actions.ts'
export type Preview=Awaited<ReturnType<typeof previewServiceAction>>
export const localDateTime=(value:string|Date|null|undefined)=>value?new Date(Date.parse(String(value))+10800000).toISOString().slice(0,16):''
export const isoDateTime=(value:string)=>value?new Date(value+':00+03:00').toISOString():null
export const defaultStart=()=>localDateTime(new Date())
export const defaultEnd=()=>localDateTime(new Date(Date.now()+7*86400000))
export function DateTimeField({label,value,onChange,required=false}:{label:string;value:string;onChange:(value:string)=>void;required?:boolean}){return <fieldset className="admin-service-date"><legend>{label} · МСК</legend><DatePicker aria-label={label+' дата'} value={value.slice(0,10)} required={required} onChange={event=>onChange(event.target.value?event.target.value+'T'+(value.slice(11)||'00:00'):'')}/><TimeInput aria-label={label+' время'} value={value.slice(11)} disabled={!value} onChange={event=>onChange(value.slice(0,10)+'T'+event.target.value)}/></fieldset>}
function ServiceForm({title,children,build,close,prepare}:{title:string;children:ReactNode;build:(reason:string)=>ActionSpec;close:()=>void;prepare:(spec:ActionSpec,preview:Preview)=>void}){
 const {request}=useAdmin(),ref=useRef<HTMLElement>(null),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<Error|null>(null),[result,setResult]=useState<{spec:ActionSpec;preview:Preview}|null>(null)
 useDialogFocus(ref)
 let spec:ActionSpec|null=null;try{spec=build(reason)}catch{/* Incomplete custom date fields are validated at submit. */}
 const current=result&&JSON.stringify(result.spec)===JSON.stringify(spec)?result:null
 return <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="service-action-title" tabIndex={-1} className="admin-ops-dialog admin-service-dialog"><header><h2 id="service-action-title">{title}</h2><button type="button" className="admin-icon-button" aria-label="Закрыть действие" disabled={busy} onClick={close}><AdminIcon name="close"/></button></header><form onSubmit={async event=>{event.preventDefault();if(busy)return;setError(null);try{const spec=build(reason);if(current?.preview.allowed){prepare(spec,current.preview);return}setBusy(true);const preview=await request<Preview>('/service/preview',{method:'POST',body:spec});setResult({spec,preview})}catch(e){setError(e instanceof Error?e:new Error('Проверьте параметры.'))}finally{setBusy(false)}}}>
  <fieldset disabled={busy} className="admin-service-fields">{children}<label className="admin-management-field"><span>Причина</span><textarea value={reason} onChange={event=>setReason(event.target.value)} minLength={5} maxLength={1000} rows={3} required/></label></fieldset>
  {current&&<section className="admin-service-preview" aria-label="Предпросмотр последствий"><h3>{current.preview.title}</h3><ul>{current.preview.consequences.map((line,index)=><li key={index}>{line}</li>)}</ul>{Array.isArray(current.preview.details)&&<ul>{current.preview.details.map((item:{id:string;reason:string},index)=><li key={index}>{item.id}: {item.reason}</li>)}</ul>}{!current.preview.allowed&&<p role="alert">Действие недоступно. Обновите сведения и проверьте параметры.</p>}</section>}
  {error&&<div role="alert"><RequestErrorMessage error={error}/></div>}<footer><button className="admin-btn" type="button" disabled={busy} onClick={close}>Отмена</button><button className="admin-btn admin-btn--primary" disabled={busy||!!current&&!current.preview.allowed}>{busy?'Проверяем…':current?'Перейти к подтверждению':'Предпросмотр'}</button></footer>
 </form></section>
}
export function ServiceDialog({title,children,build,onClose,onDone}:{title:string;children?:ReactNode;build:(reason:string)=>ActionSpec;onClose:()=>void;onDone:(result:ManagementResult)=>void}){
 const [prepared,setPrepared]=useState<{spec:ActionSpec;preview:Preview}|null>(null)
 if(prepared)return <ManagementActionDialog action={{spec:prepared.spec,description:prepared.preview.title+' · '+prepared.preview.consequences.join(' ')}} onClose={onClose} onDone={onDone}/>
 return <AnimatedOverlay variant="modal" className="admin-root admin-ops-overlay" onClose={onClose}>{close=><ServiceForm title={title} build={build} close={close} prepare={(spec,preview)=>setPrepared({spec,preview})}>{children}</ServiceForm>}</AnimatedOverlay>
}
export const serviceStates:Record<string,string>={active:'Действующий',unverified:'Почта не подтверждена',provider:'Вход через внешний сервис',deleting:'Удаляется',PENDING:'В очереди',RUNNING:'Выполняется',SUCCEEDED:'Выполнено',FAILED:'Ошибка',ACTIVE:'Действует',SUSPENDED:'Приостановлена',PLANNED:'Запланировано',IN_PROGRESS:'В работе',VERIFYING:'Проверка после работ',COMPLETED:'Завершено',CANCELLED:'Отменено',ACCEPTED:'Принято провайдером',CONFIRMED:'Получение подтверждено',VERIFIED:'Проверено'}
