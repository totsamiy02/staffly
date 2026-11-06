import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import type { AdminAccess } from './contracts.ts'
import RequestErrorMessage from '../../component/ui/request-error-message.tsx'
import Avatar from '../../component/ui/avatar/avatar.tsx'
import { useDialogFocus } from '../../component/ui/modal/dialog-focus.ts'
import { useAdmin } from './admin-data.tsx'
import { AdminIcon } from './admin-elements.tsx'
import PinField from './pin-field.tsx'

export function AdminAuthForm({reset=false,onCancel}:{reset?:boolean;onCancel?:()=>void}){
 const {user}=useAuth(),{access,request,accept}=useAdmin()
 const [challenge,setChallenge]=useState<string|null>(null),[password,setPassword]=useState(''),[code,setCode]=useState(''),[newPin,setNewPin]=useState(''),[pin,setPin]=useState(''),[stage,setStage]=useState<'code'|'pin'|'confirm'>('code'),[busy,setBusy]=useState(false),[error,setError]=useState<Error|null>(null),[notice,setNotice]=useState(access.reset?'PIN-код изменён. Подтвердите административный вход заново.':'')
 async function submit(event:FormEvent){
  event.preventDefault();setError(null);setBusy(true)
  try{
   if(!challenge){const data=await request<{challengeId:string}>('/challenge',{method:'POST',body:{password,purpose:reset?'RESET_PIN':'LOGIN'}});setPassword('');setChallenge(data.challengeId)}
   else if(reset&&stage==='code'){setStage('pin')}
   else if(reset&&stage==='pin'){setNewPin(pin);setPin('');setStage('confirm')}
   else{if(reset&&newPin!==pin)throw new Error('PIN-коды не совпадают. Повторите новый код.');const result=await request<AdminAccess>('/verify',{method:'POST',body:{challengeId:challenge,code,...(reset?{newPin,confirmPin:pin}:{})}});setCode('');setPin('');setNewPin('');setChallenge(null);setStage('code');accept(result);if(result.reset)setNotice('PIN-код изменён. Все административные сеансы завершены. Подтвердите вход заново.')}
  }catch(e){setError(e instanceof Error?e:new Error('Не удалось подтвердить вход.'))}finally{setBusy(false)}
 }
 const pinStep=reset&&challenge&&stage!=='code'
 return <form className="admin-auth-card" onSubmit={event=>void submit(event)} autoComplete={pinStep?'off':undefined}>
  <div className="admin-auth-symbol"><AdminIcon name={reset?'key':'shield'}/></div>
  <div className="admin-eyebrow">Доступ администратора</div><h1 id="admin-auth-heading">{pinStep?stage==='confirm'?'Повторите новый PIN':'Новый PIN-код':reset?'Сброс PIN-кода':challenge?'Проверьте почту':'Подтвердите вход'}</h1>
  <p>{pinStep?'Код нужен для быстрой разблокировки панели. Не используйте дату рождения или простые последовательности.':reset?'Подтвердите пароль и почту. После смены PIN все административные сеансы завершатся.':challenge?'Введите 6 цифр из письма. Код действует 5 минут.':'Введите пароль аккаунта, затем подтвердите вход кодом из письма.'}</p>
  {!pinStep&&<div className="admin-auth-account"><Avatar url={user?.avatarUrl} name={user?.displayName??''} className="admin-avatar" eager/><div><strong>{user?.displayName}</strong><small>{user?.email}</small></div></div>}
  {notice&&<p className="admin-notice" role="status">{notice}</p>}
  {!challenge&&<label>Пароль аккаунта<input name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
  {challenge&&!pinStep&&<PinField label="Код из письма" value={code} onChange={setCode} masked={false} autoFocus/>}
  {pinStep&&<PinField key={stage} label={stage==='confirm'?'Повторите PIN-код':'Новый PIN-код'} value={pin} onChange={setPin} invalid={Boolean(error)} autoFocus/>}
  {error&&<div role="alert"><RequestErrorMessage error={error}/></div>}
  <button type="submit" className="admin-btn admin-btn--primary admin-full" disabled={busy}>{busy?'Проверяем…':pinStep?stage==='confirm'?'Изменить PIN-код':'Продолжить':challenge?reset?'Продолжить':'Подтвердить код':'Получить код на почту'}</button>
  {challenge&&!pinStep&&<button className="admin-text-button" type="button" disabled={busy} onClick={()=>{setChallenge(null);setCode('');setError(null)}}>Запросить новый код</button>}
  {pinStep&&stage==='confirm'&&<button className="admin-text-button" type="button" onClick={()=>{setStage('pin');setPin('');setError(null)}}>Изменить новый PIN</button>}
  {onCancel?<button className="admin-text-button" type="button" onClick={onCancel}>Вернуться к разблокировке</button>:<a className="admin-text-link" href="/app">К выбору организации</a>}
 </form>
}
export function AdminLock({setup=false}:{setup?:boolean}){
 const {access,request,accept,leave}=useAdmin(),[pin,setPin]=useState(''),[firstPin,setFirstPin]=useState(''),[confirm,setConfirm]=useState(false),[error,setError]=useState<Error|null>(null),[busy,setBusy]=useState(false),[reset,setReset]=useState(false)
 const ref=useRef<HTMLDivElement>(null),pending=useRef(false);useDialogFocus(ref)
 // The dialog focus trap runs first; keep the PIN ready for typing afterwards.
 useLayoutEffect(()=>{if(!reset&&!busy)ref.current?.querySelector<HTMLInputElement>('input[name="staffly-unlock-code"]')?.focus({preventScroll:true})},[reset,busy,confirm])
 useEffect(()=>{const overflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=overflow}},[])
 async function submit(value:string){
  if(pending.current||!/^\d{6}$/.test(value))return
  pending.current=true;setBusy(true);setError(null)
  try{
   if(setup&&!confirm){setFirstPin(value);setPin('');setConfirm(true);return}
   if(setup&&value!==firstPin)throw new Error('Коды не совпадают. Повторите выбранные 6 цифр.')
   accept(await request<AdminAccess>(setup?'/pin':'/unlock',{method:'POST',body:setup?{pin:firstPin,confirmPin:value}:{pin:value}}));setPin('');setFirstPin('')
  }catch(e){setPin('');setError(e instanceof Error?e:new Error('Не удалось подтвердить PIN.'));if(!setup)try{accept(await request<AdminAccess>('/access'))}catch{/* The main request handles authorization failures. */}}
  finally{pending.current=false;setBusy(false)}
 }
 function changePin(value:string){if(pending.current)return;setPin(value);setError(null);if(!setup&&value.length===6)void submit(value)}
 const heading=setup?confirm?'Повторите PIN-код':'Создайте PIN-код':'Панель заблокирована',remaining=access.attemptsRemaining??5
 return createPortal(<div className="admin-lock-backdrop"><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={reset?'admin-auth-heading':'admin-lock-heading'} className="admin-lock-dialog">{reset?<AdminAuthForm reset onCancel={()=>setReset(false)}/>:<form onSubmit={e=>{e.preventDefault();void submit(pin)}} autoComplete="off" aria-busy={busy}>
  <div className="admin-lock-orbit"><div className="admin-auth-symbol"><AdminIcon name={setup?'shield':'lock'}/></div><span/><span/></div>
  <div className="admin-eyebrow">{setup?'Личное пространство администратора':'Безопасность Staffly'}</div><h2 id="admin-lock-heading">{heading}</h2>
  <p>{setup?confirm?'Повторите код, чтобы сохранить его.':'Вы уже в панели. Осталось создать 6-значный код для разблокировки после 5 минут бездействия.':'Введите 6 цифр личного PIN — панель откроется автоматически.'}</p>
  {setup&&<div className="admin-pin-progress" aria-label={`Шаг ${confirm?2:1} из 2`}><i className="is-complete"/><i className={confirm?'is-complete':''}/></div>}
  <div className={error?'admin-shake':''}><PinField label={setup?confirm?'Повторите PIN-код':'PIN-код из 6 цифр':'PIN-код'} value={pin} onChange={changePin} invalid={Boolean(error)} readOnly={busy} autoFocus/></div>
  {error&&<div role="alert"><RequestErrorMessage error={error}/></div>}
  {!setup&&<p className={`admin-attempts ${remaining<3?'is-warning':''}`} role="status">Осталось попыток: <strong>{remaining} из 5</strong>. После пяти ошибок потребуется пароль и письмо.</p>}
  {setup?<button className="admin-btn admin-btn--primary admin-full" disabled={busy}>{busy?'Проверяем…':confirm?'Создать PIN и открыть панель':'Продолжить'}</button>:<p className="admin-pin-checking" role="status">{busy?'Проверяем PIN…':''}</p>}
  {setup&&confirm?<button type="button" className="admin-text-button" disabled={busy} onClick={()=>{setConfirm(false);setPin('');setError(null)}}>Выбрать другой PIN</button>:!setup&&<button type="button" className="admin-text-button" disabled={busy} onClick={()=>{setPin('');setError(null);setReset(true)}}>Забыли PIN-код?</button>}
  <button type="button" className="admin-text-button admin-exit" disabled={busy} onClick={()=>void leave().catch(e=>setError(e))}>Выйти из панели</button>
 </form>}</div></div>,document.body)
}
