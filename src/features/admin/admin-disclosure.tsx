import { useEffect,useId,useRef,useState,type ReactNode } from 'react'

export default function AdminDisclosure({label,children,className='',closeOutside=false}:{label:ReactNode;children:ReactNode;className?:string;closeOutside?:boolean}){
 const [open,setOpen]=useState(false),id=useId(),host=useRef<HTMLDivElement>(null)
 useEffect(()=>{if(!open||!closeOutside)return;const outside=(event:PointerEvent)=>{if(!host.current?.contains(event.target as Node))setOpen(false)};document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true)},[open,closeOutside])
 return <div ref={host} className={`admin-disclosure ${className} ${open?'is-open':''}`}>
  <button type="button" className="admin-disclosure-trigger" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}><span className="admin-disclosure-label">{label}</span><svg className="admin-disclosure-toggle" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 8h10"/><path className="admin-disclosure-plus" d="M8 3v10"/></svg></button>
  <div className="admin-disclosure-grid" id={id} inert={!open} aria-hidden={!open}><div><div className="admin-disclosure-body">{children}</div></div></div>
 </div>
}
