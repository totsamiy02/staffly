import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import type { AdminAccess } from './contracts.ts'
import logo from '../../assets/images/logo/staffly-logo.svg'
import Avatar from '../../component/ui/avatar/avatar.tsx'
import ThemeToggle from '../../component/ui/theme-toggle/theme-toggle.tsx'
import RequestErrorMessage from '../../component/ui/request-error-message.tsx'
import { AdminContext, type AdminContextValue } from './admin-data.tsx'
import { AdminAuthForm, AdminLock } from './admin-auth.tsx'
import { AdminBadge, AdminIcon } from './admin-elements.tsx'
import { OverviewPage, OrganizationsPage, OrganizationPage, UsersPage, UserPage, OnlinePage, AnalyticsPage, EventsPage } from './monitoring-pages.tsx'
import AdminNavigation, { ADMIN_COMPACT_QUERY } from './admin-navigation.tsx'
import './admin.scss'

export default function AdminPage(){
 const {pathname}=useLocation()
 const [compactNavigation,setCompactNavigation]=useState(()=>window.matchMedia(ADMIN_COMPACT_QUERY).matches)
 const {user,apiRequest}=useAuth(),[access,setAccess]=useState<AdminAccess|null>(null),[error,setError]=useState<Error|null>(null),[sidebar,setSidebar]=useState(false)
 const closeNavigation=useCallback(()=>setSidebar(false),[])
 useEffect(()=>{const media=window.matchMedia(ADMIN_COMPACT_QUERY);const change=()=>{setCompactNavigation(media.matches);setSidebar(false)};media.addEventListener('change',change);return()=>media.removeEventListener('change',change)},[])
 const blocked=useRef(false),generation=useRef(0),deadline=useRef(0),stateRef=useRef<AdminAccess|null>(null)
 const apply=useCallback((state:AdminAccess,explicit=false)=>{
  if(explicit)blocked.current=false
  if(blocked.current&&state.state==='active')return
  stateRef.current=state;deadline.current=state.lockAt?Date.parse(state.lockAt):0;setAccess(state)
 },[])
 const lockLocally=useCallback(()=>{
  blocked.current=true;generation.current++;setSidebar(false)
  if(stateRef.current){const next={...stateRef.current,state:'locked' as const};stateRef.current=next;setAccess(next)}
 },[])
 const request=useCallback<AdminContextValue['request']>(async(path,options={})=>{
  try{return await apiRequest('/admin'+path,options)}catch(e){
   const code=(e as {code?:string}).code
   if(code==='ADMIN_LOCKED')lockLocally()
   else if(['ADMIN_AUTH_REQUIRED','ADMIN_FORBIDDEN','SESSION_EXPIRED'].includes(code??'')){blocked.current=false;generation.current++;apply({eligible:code!=='ADMIN_FORBIDDEN',state:'authenticate'})}
   throw e
  }
 },[apiRequest,lockLocally,apply])
 const reload=useCallback(async()=>{const version=generation.current;try{const result=await request<AdminAccess>('/access');if(generation.current===version){apply(result);setError(null)}}catch(e){setError(e instanceof Error?e:new Error('Не удалось проверить доступ.'))}},[request,apply])
 useEffect(()=>{void reload();const timer=setInterval(()=>{if(document.visibilityState==='visible')void reload()},15000);const visible=()=>{if(document.visibilityState==='visible')void reload()};document.addEventListener('visibilitychange',visible);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible)}},[reload])
 useEffect(()=>{
  if(access?.state!=='active')return
  let pending=false,lastSent=0
  const touch=(event:Event)=>{
   if(!event.isTrusted||document.visibilityState!=='visible'||blocked.current||pending||Date.now()-lastSent<20000)return
   if(deadline.current&&Date.now()>=deadline.current){lockLocally();return}
   pending=true;lastSent=Date.now();const version=generation.current
   void request<AdminAccess>('/activity',{method:'POST',body:{}}).then(result=>{if(generation.current===version)apply(result)}).catch(()=>{}).finally(()=>{pending=false})
  }
  const timer=setInterval(()=>{if(deadline.current&&Date.now()>=deadline.current){lockLocally();void request('/lock',{method:'POST',body:{}}).catch(()=>{})}},1000)
  for(const name of ['pointerdown','keydown','wheel'])document.addEventListener(name,touch,{passive:true})
  return()=>{clearInterval(timer);for(const name of ['pointerdown','keydown','wheel'])document.removeEventListener(name,touch)}
 },[access?.state,apply,lockLocally,request])
 const leave=useCallback(async()=>{await request('/logout',{method:'POST',body:{}});setSidebar(false);generation.current++;apply({eligible:true,state:'authenticate'},true);window.close();window.setTimeout(()=>window.location.replace('/app'),120)},[request,apply])
 const accept=useCallback((state:AdminAccess)=>{generation.current++;apply(state,true)},[apply])
 const value=useMemo<AdminContextValue>(()=>({access:access??{eligible:false,state:'authenticate'},request,accept,leave}),[access,request,accept,leave])
 const active=access?.eligible&&(access.state==='active'||access.state==='locked'||access.state==='setup-pin')
 if(!access)return <div className="admin-root admin-denied"><main className="admin-auth-card"><h1>Проверяем доступ</h1>{error?<><RequestErrorMessage error={error}/><button className="admin-btn" onClick={()=>void reload()}>Повторить</button></>:<p role="status">Подключаемся…</p>}</main></div>
 if(!access.eligible)return <div className="admin-root admin-denied"><main className="admin-auth-card"><div className="admin-auth-symbol"><AdminIcon name="shield"/></div><h1>Доступ не предоставлен</h1><p>У этого аккаунта нет прав администратора Staffly.</p><a href="/app" className="admin-btn admin-btn--primary admin-full">К выбору организации</a></main></div>
 return <AdminContext.Provider value={value}><div className={`admin-root ${compactNavigation?'has-compact-navigation':''} ${access.state==='locked'||access.state==='setup-pin'?'is-secured':''}`}>
  <header className="admin-topbar" inert={compactNavigation&&sidebar||undefined}><div className="admin-brand"><Link to="/" aria-label="Staffly — главная"><img src={logo} alt="Staffly"/></Link><i/><span>Управление сервисом</span></div><div className="admin-top-controls"><ThemeToggle/>{active&&<AdminBadge tone={access.state==='active'?'green':'gray'}><AdminIcon name="lock"/>{access.state==='active'?'Вход подтверждён':'Заблокировано'}</AdminBadge>}<div className="admin-profile"><Avatar url={user?.avatarUrl} name={user?.displayName??''} className="admin-avatar" eager/><div><strong>{user?.displayName}</strong><small>{access?.eligible?'Администратор сервиса':'Аккаунт Staffly'}</small></div></div>{active&&<button type="button" className="admin-btn admin-menu-toggle" aria-label="Открыть навигацию" aria-expanded={sidebar} aria-controls="admin-sidebar" onClick={()=>setSidebar(v=>!v)}><AdminIcon name="menu"/></button>}</div></header>
  {!active?<main className="admin-entry"><section className="admin-entry-copy"><div className="admin-auth-symbol"><AdminIcon name="shield"/></div><div className="admin-eyebrow">Staffly / Управление сервисом</div><h2>Всё важное.<br/>Под контролем.</h2><p>Организации, активность и состояние Staffly в одном защищённом пространстве.</p><div><p><AdminIcon name="key"/>Пароль и подтверждение почтой</p><p><AdminIcon name="lock"/>PIN-код для разблокировки</p><p><AdminIcon name="shield"/>Административные действия фиксируются</p></div></section><AdminAuthForm/></main>:<div className="admin-workspace"><AdminNavigation compact={compactNavigation} open={sidebar} onClose={closeNavigation} onLock={()=>{lockLocally();void request('/lock',{method:'POST',body:{}}).catch(()=>{})}} onLeave={()=>void leave().catch(e=>setError(e))}/><main className="admin-main" id="main-content" inert={compactNavigation&&sidebar||undefined}>{access.state!=='active'?<div className="admin-neutral-shell" aria-hidden="true"><div/><div className="admin-neutral-stats">{[1,2,3,4].map(i=><i key={i}/>)}</div><section/><section/></div>:<>{error&&<div className="admin-notice"><RequestErrorMessage error={error}/></div>}<div key={pathname} className="admin-route-reveal"><Routes><Route index element={<OverviewPage/>}/><Route path="organizations" element={<OrganizationsPage/>}/><Route path="organizations/:id" element={<OrganizationPage/>}/><Route path="users" element={<UsersPage/>}/><Route path="users/:id" element={<UserPage/>}/><Route path="online" element={<OnlinePage/>}/><Route path="analytics" element={<AnalyticsPage/>}/><Route path="events" element={<EventsPage/>}/><Route path="*" element={<Navigate to="/admin" replace/>}/></Routes></div></>}</main></div>}
  {(access?.state==='locked'||access?.state==='setup-pin')&&<AdminLock setup={access.state==='setup-pin'}/>}
 </div></AdminContext.Provider>
}
