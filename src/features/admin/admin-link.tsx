/* oxlint-disable react/only-export-components -- Shared feature hooks and components. */
import { useLayoutEffect,useRef } from 'react'
import { Link,useLocation,type LinkProps } from 'react-router-dom'
const positions=new Map<string,number>()
export function AdminLink({state,onClick,...props}:LinkProps){
 const location=useLocation()
 return <Link {...props} onClick={event=>{positions.set(location.key,window.scrollY);onClick?.(event)}} state={{...state,adminReturn:{url:location.pathname+location.search,key:location.key,scroll:window.scrollY}}}/>
}
export function useAdminScroll(active:boolean){
 const location=useLocation(),current=useRef(location.key),previousPath=useRef(location.pathname)
 useLayoutEffect(()=>{
  if(!active){positions.clear();return}
  positions.set(current.current,positions.get(current.current)??window.scrollY)
  current.current=location.key
  const target=positions.get(location.key)??positions.get(location.state?.adminRestoreKey)??(previousPath.current===location.pathname?window.scrollY:0)
  previousPath.current=location.pathname
  let done=false
  const restore=()=>{if(done)return;window.scrollTo(0,target);if(Math.abs(window.scrollY-target)<2)done=true}
  const observer=new ResizeObserver(restore);observer.observe(document.body);restore()
  const stop=()=>{done=true},save=()=>{if(done)positions.set(current.current,window.scrollY)}
  for(const event of ['pointerdown','wheel','keydown'])window.addEventListener(event,stop,{passive:true})
  window.addEventListener('scroll',save,{passive:true})
  const timer=setTimeout(stop,10000)
  return()=>{observer.disconnect();clearTimeout(timer);window.removeEventListener('scroll',save);for(const event of ['pointerdown','wheel','keydown'])window.removeEventListener(event,stop)}
 },[location.key,location.pathname,location.state?.adminRestoreKey,active])
}
