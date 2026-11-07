import { useLayoutEffect,useRef,useState,type FormEvent } from 'react'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { useDialogFocus } from '../../../component/ui/modal/dialog-focus.ts'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import { useAdmin } from '../admin-data.tsx'
import { AdminIcon } from '../admin-elements.tsx'
import { managementActions } from './catalog.ts'
import type { ActionSpec } from './contracts.ts'
type Challenge={challengeId:string;summary:string;expiresAt:string;attemptsRemaining:number}
export type ProtectedAction={spec:ActionSpec;description:string}
function ActionSurface({action,close,onDone,busy,setBusy,onIssued}:{action:ProtectedAction;close:()=>void;onDone:()=>void;busy:boolean;setBusy:(value:boolean)=>void;onIssued:(id:string)=>void}){
 const {request}=useAdmin(),ref=useRef<HTMLDivElement>(null),pending=useRef(false),[password,setPassword]=useState(''),[code,setCode]=useState(''),[challenge,setChallenge]=useState<Challenge|null>(null),[error,setError]=useState<Error|null>(null),[invalid,setInvalid]=useState(false),[expired,setExpired]=useState(false)
 useDialogFocus(ref)
 useLayoutEffect(()=>{ref.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true})},[challenge,invalid])
 const cancel=()=>close()
 async function submit(event:FormEvent){
  event.preventDefault();if(pending.current||expired)return
  pending.current=true;setBusy(true);setError(null);setInvalid(false)
  try{
   if(!challenge){const next=await request<Challenge>('/management/actions',{method:'POST',body:{spec:action.spec,password}});setPassword('');setChallenge(next);onIssued(next.challengeId)}
   else{await request('/management/actions/execute',{method:'POST',body:{challengeId:challenge.challengeId,code,confirm:true}});onDone()}
  }catch(e){
   const failure=e as Error&{code?:string;errors?:{attemptsRemaining?:number}}
   setError(failure);setInvalid(true);setCode('')
   if(failure.code==='ADMIN_ACTION_CODE'&&failure.errors?.attemptsRemaining===0||['ADMIN_ACTION_CHANGED','ADMIN_BACKUP_BUSY','ADMIN_MANAGEMENT_LIMIT'].includes(failure.code??''))setExpired(true)
  }finally{pending.current=false;setBusy(false)}
 }
 return <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="admin-action-title" className="admin-ops-dialog admin-management-dialog"><header><div className="admin-auth-symbol"><AdminIcon name="shield"/></div><button type="button" className="admin-icon-button" aria-label="Закрыть подтверждение" disabled={busy} onClick={cancel}><AdminIcon name="close"/></button></header><div className="admin-eyebrow">Защищённое действие · {challenge?'2':'1'} из 2</div><h2 id="admin-action-title">{managementActions[action.spec.action]}</h2><p>{challenge?.summary??action.description}</p><form onSubmit={event=>void submit(event)} className={invalid?'has-action-error':''}>
  {challenge?<label key="code" className="admin-management-field"><span>Код из письма</span><input autoFocus name="management-confirmation" type="text" aria-label="Код из письма" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" data-1p-ignore="true" data-lpignore="true" spellCheck={false} value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,''))} className="admin-action-otp" required/><small>Код действует 5 минут, не более 5 попыток. Действие выполнится после нажатия «Подтвердить действие».</small></label>:<label key="password" className="admin-management-field"><span>Пароль вашего аккаунта</span><input autoFocus type="password" aria-label="Пароль вашего аккаунта" autoComplete="current-password" name="current-password" value={password} onChange={event=>setPassword(event.target.value)} maxLength={1024} required/><small>После проверки отправим на вашу почту разовый код с описанием действия.</small></label>}
  {error&&<div role="alert"><RequestErrorMessage error={error}/></div>}<div className="admin-actions"><button type="button" className="admin-btn" disabled={busy} onClick={cancel}>Отмена</button><button className="admin-btn admin-btn--primary" disabled={busy||expired||(challenge?code.length!==6:!password)}>{busy?'Проверяем…':challenge?'Подтвердить действие':'Получить код'}</button></div>
 </form></section>
}
export function ManagementActionDialog({action,onClose,onDone}:{action:ProtectedAction;onClose:()=>void;onDone:()=>void}){
 const [busy,setBusy]=useState(false),issued=useRef<string|null>(null),{request}=useAdmin()
 const cancel=()=>{if(issued.current)void request('/management/actions/'+issued.current+'/cancel',{method:'POST',body:{}}).catch(()=>{});onClose()}
 return <AnimatedOverlay variant="modal" className="admin-root admin-ops-overlay" dismissible={!busy} onClose={cancel}>{close=><ActionSurface action={action} close={close} busy={busy} setBusy={setBusy} onIssued={id=>{issued.current=id}} onDone={()=>{issued.current=null;onDone();onClose()}}/>}</AnimatedOverlay>
}
