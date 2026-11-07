import { useRef,useState } from 'react'
import './copy-reference.scss'
export default function CopyReference({value,label,hideLabel=false}:{value:string;label:string;hideLabel?:boolean}){
 const code=useRef<HTMLElement>(null),[feedback,setFeedback]=useState('')
 async function copy(){try{await navigator.clipboard.writeText(value);setFeedback('Скопировано')}catch{if(code.current){code.current.focus({preventScroll:true});const range=document.createRange();range.selectNodeContents(code.current);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range)}setFeedback('Выделено для копирования')}}
 return <span className="copy-reference">{!hideLabel&&<span className="copy-reference__label">{label}</span>}<code ref={code} tabIndex={-1}>{value}</code><button type="button" aria-label={'Скопировать '+label.toLowerCase()} title={feedback||'Скопировать'} onClick={()=>void copy()}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="2"/><path d="M12 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg></button><span className="copy-reference__feedback" role="status">{feedback}</span></span>
}
