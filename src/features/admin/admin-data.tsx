/* oxlint-disable react/only-export-components -- Context and hooks form a single feature API. */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { AdminAccess } from './contracts.ts'
type Options={method?:'GET'|'POST';body?:unknown;signal?:AbortSignal}
export type AdminContextValue={access:AdminAccess;request:<T>(path:string,options?:Options)=>Promise<T>;accept:(state:AdminAccess)=>void;leave:()=>Promise<void>}
export const AdminContext=createContext<AdminContextValue|null>(null)
export function useAdmin(){const value=useContext(AdminContext);if(!value)throw new Error('Admin provider is missing');return value}
export function useAdminData<T>(path:string){
 const {request}=useAdmin(),[data,setData]=useState<T|null>(null),[error,setError]=useState<Error|null>(null),[busy,setBusy]=useState(true),[updatedAt,setUpdatedAt]=useState<Date|null>(null),[revision,setRevision]=useState(0)
 const current=useRef(0),identity=useRef('')
 useEffect(()=>{
  const version=++current.current,controller=new AbortController();let running=false
  const nextIdentity=path.split('?')[0]
  if(identity.current!==nextIdentity){setData(null);setUpdatedAt(null);identity.current=nextIdentity}
  setError(null)
  const load=async()=>{if(running)return;running=true;setBusy(true);try{const value=await request<T>(path,{signal:controller.signal});if(current.current===version&&!controller.signal.aborted){setData(value);setUpdatedAt(new Date());setError(null)}}catch(e){if(!controller.signal.aborted&&current.current===version)setError(e instanceof Error?e:new Error('Не удалось загрузить данные.'))}finally{running=false;if(current.current===version&&!controller.signal.aborted)setBusy(false)}}
  void load()
  const visible=()=>{if(document.visibilityState==='visible')void load()}
  const timer=setInterval(visible,20000);document.addEventListener('visibilitychange',visible)
  return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible)}
 },[path,request,revision])
 return {data,error,busy,updatedAt,refresh:()=>setRevision(v=>v+1)}
}
