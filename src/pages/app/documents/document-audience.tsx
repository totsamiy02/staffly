import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useAccessRoles } from '../../../app/access/queries.ts'
import { useDocumentMembers } from '../../../app/documents/queries.ts'
export type Audience = { audienceRoleIds: string[]; audienceMemberIds: string[]; inheritAccess: boolean }
export default function DocumentAudience({ organizationId,value,onChange,pointId,folderId,visibility,targetMemberId,disabled=false }: { organizationId:string;value:Audience;onChange:(v:Audience)=>void;pointId:string;folderId?:string;visibility:string;targetMemberId?:string;disabled?:boolean }) {
  const roles=useAccessRoles(organizationId), members=useDocumentMembers(organizationId,visibility==='SELECTED',!pointId,pointId), [search,setSearch]=useState(''), {apiRequest}=useAuth()
  const signature=JSON.stringify({...value,pointId:pointId||null,folderId:folderId||null,visibility,targetMemberId:targetMemberId||null})
  const [settled,setSettled]=useState(signature)
  useEffect(()=>{const timer=window.setTimeout(()=>setSettled(signature),300);return()=>window.clearTimeout(timer)},[signature])
  const preview=useQuery({queryKey:['document-audience-preview',organizationId,settled],queryFn:()=>apiRequest<{members:Array<{id:string;name:string;allowed:boolean}>}>(`/organizations/${organizationId}/documents/access-preview`,{method:'POST',body:JSON.parse(settled)}),enabled:!disabled && signature===settled})
  const toggle=(key:'audienceRoleIds'|'audienceMemberIds',id:string)=>onChange({...value,[key]:value[key].includes(id)?value[key].filter(v=>v!==id):[...value[key],id]})
  return <div className="document-audience">
    {folderId && visibility!=='PRIVATE_MEMBER' && <label className="document-checkbox"><input type="checkbox" disabled={disabled} checked={value.inheritAccess} onChange={e=>onChange({...value,inheritAccess:e.target.checked})}/><span>Наследовать доступ папки</span></label>}
    {visibility==='SELECTED'&&!value.inheritAccess&&<>
      <fieldset><legend>Роли</legend><div className="document-recipient-picker">{roles.isError ? <p role="alert">Не удалось загрузить роли.</p> : roles.data?.roles.filter(r=>r.systemCode!=='OWNER').map(r=><label className="document-checkbox" key={r.id}><input type="checkbox" disabled={disabled} checked={value.audienceRoleIds.includes(r.id)} onChange={()=>toggle('audienceRoleIds',r.id)}/><span>{r.name}</span></label>)}</div></fieldset>
      <fieldset><legend>Дополнительные сотрудники</legend><input type="search" placeholder="Поиск сотрудника" aria-label="Поиск сотрудника для доступа" value={search} onChange={e=>setSearch(e.target.value)}/><div className="document-recipient-picker">{members.isError ? <p role="alert">Не удалось загрузить сотрудников.</p> : members.data?.members.filter(m=>!m.former&&m.name.toLowerCase().includes(search.toLowerCase())).map(m=><label className="document-checkbox" key={m.id}><input type="checkbox" disabled={disabled} checked={value.audienceMemberIds.includes(m.id)} onChange={()=>toggle('audienceMemberIds',m.id)}/><span>{m.name}</span></label>)}</div></fieldset>
    </>}
    {preview.data && <details className="document-audience-preview"><summary>Кто увидит документ: {preview.data.members.filter(m=>m.allowed).length}</summary><div className="document-recipient-picker">{preview.data.members.map(m=><p key={m.id}>{m.allowed?'✓':'—'} {m.name} · {m.allowed?'доступен':'нет доступа'}</p>)}</div></details>}
    {preview.isError&&<p className="form-inline-error">Не удалось проверить аудиторию. {preview.error.message}</p>}
    <p className="access-note">Владелец имеет полный доступ. Учитываются права на библиотеку, область и все родительские папки. Выбор роли отслеживает её текущие назначения.</p>
  </div>
}
