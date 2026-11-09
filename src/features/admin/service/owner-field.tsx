import { useEffect,useState } from 'react'
import Select from '../../../component/ui/select/select.tsx'
import { useAdminData } from '../admin-data.tsx'
import type { AdministratorsState } from '../management/contracts.ts'
export default function OwnerField({value,onChange}:{value:string;onChange:(id:string)=>void}){
 const [term,setTerm]=useState(''),[query,setQuery]=useState('');useEffect(()=>{const timer=setTimeout(()=>setQuery(term.trim()),300);return()=>clearTimeout(timer)},[term])
 const {data,error}=useAdminData<AdministratorsState>('/management/administrators?status=active&search='+encodeURIComponent(query))
 return <div className="admin-service-owner"><label className="admin-management-field"><span>Найти ответственного</span><input type="search" value={term} onChange={event=>setTerm(event.target.value)} placeholder="Имя или номер администратора"/></label><label className="admin-management-field"><span>Ответственный</span><Select aria-label="Ответственный за обслуживание" value={value} onChange={event=>onChange(event.target.value)}>{!data?.items.some(p=>p.id===value)&&value&&<option value={value}>Выбранный администратор</option>}{data?.items.filter(p=>p.ready).map(p=><option value={p.id} key={p.id}>{p.name} · №{p.publicId}</option>)}</Select></label>{error&&<small role="alert">Не удалось обновить список администраторов.</small>}</div>
}
