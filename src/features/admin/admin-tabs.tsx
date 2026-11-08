import { useId,useRef } from 'react'
export default function AdminTabs({value,items,onChange,label}:{value:string;items:Array<[string,string]>;onChange:(value:string)=>void;label:string}){
 const id=useId(),ref=useRef<HTMLDivElement>(null)
 return <div className="admin-tabs" role="tablist" aria-label={label} ref={ref}>{items.map(([key,title],index)=><button type="button" role="tab" id={id+'-'+key} aria-selected={value===key} tabIndex={value===key?0:-1} key={key} onClick={()=>onChange(key)} onKeyDown={event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
  event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length
  onChange(items[next][0]);ref.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
 }}>{title}</button>)}</div>
}
