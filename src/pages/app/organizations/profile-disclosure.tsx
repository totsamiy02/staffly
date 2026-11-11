import { useId, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import './organization-profile.scss'
export default function ProfileDisclosure({title,children,initiallyOpen=false}:{title:string;children:ReactNode;initiallyOpen?:boolean}){
 const [open,setOpen]=useState(initiallyOpen),id=useId()
 return <section className="profile-disclosure" onInvalidCapture={()=>flushSync(()=>setOpen(true))}><button className="profile-disclosure__toggle" type="button" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(!open)}><span>{title}</span><span aria-hidden="true">{open?'−':'+'}</span></button><div className="profile-disclosure__body" data-open={open} id={id} inert={!open}><div>{children}</div></div></section>
}
