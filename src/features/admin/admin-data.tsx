/* oxlint-disable react/only-export-components -- Context and hooks form a single feature API. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { AdminAccess } from './contracts.ts'
type Options={method?:'GET'|'POST';body?:unknown;signal?:AbortSignal}
export type AdminContextValue={access:AdminAccess;request:<T>(path:string,options?:Options)=>Promise<T>;accept:(state:AdminAccess)=>void;leave:()=>Promise<void>}
export const AdminContext=createContext<AdminContextValue|null>(null)
export function useAdmin(){const value=useContext(AdminContext);if(!value)throw new Error('Admin provider is missing');return value}
export type AdminReadState={applying:boolean;updatedAt:Date|null;error:Error|null;refresh:()=>void}
export function useAdminData<T>(path:string){
 const {request}=useAdmin(),[result,setResult]=useState<{path:string;value:T;updatedAt:Date}|null>(null),[failure,setFailure]=useState<{path:string;error:Error}|null>(null),[busy,setBusy]=useState(true),[revision,setRevision]=useState(0)
 const current=useRef(0),refresh=useCallback(()=>setRevision(v=>v+1),[])
 useEffect(()=>{
  const version=++current.current,controller=new AbortController();let running=false
  setFailure(null)
  const load=async()=>{if(running)return;running=true;setBusy(true);try{const value=await request<T>(path,{signal:controller.signal});if(current.current===version&&!controller.signal.aborted){setResult({path,value,updatedAt:new Date()});setFailure(null)}}catch(e){if(!controller.signal.aborted&&current.current===version)setFailure({path,error:e instanceof Error?e:new Error('Не удалось загрузить данные.')})}finally{running=false;if(current.current===version&&!controller.signal.aborted)setBusy(false)}}
  void load()
  const visible=()=>{if(document.visibilityState==='visible')void load()}
  const timer=setInterval(visible,20000);document.addEventListener('visibilitychange',visible)
  return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible)}
 },[path,request,revision])
 // A changed entity must never render a previous entity, even before effects run.
 const compatible=result?.path.split('?')[0]===path.split('?')[0],data=compatible?result!.value:null,updatedAt=compatible?result!.updatedAt:null
 const error=failure?.path===path?failure.error:null,applying=data!==null&&result?.path!==path
 const readState:AdminReadState={applying,updatedAt,error,refresh}
 return {data,error,busy,updatedAt,applying,readState,refresh}
}
