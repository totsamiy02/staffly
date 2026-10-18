import MemberAvatar from '../../../component/ui/member-avatar.tsx'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useAccessRoles } from '../../../app/access/queries.ts'
import { useDocumentMembers } from '../../../app/documents/queries.ts'
import HelpTip from '../../../component/ui/help-tip/help-tip.tsx'
import MemberPicker from '../member-profile/profile-member-picker.tsx'
import './document-audience.scss'
export type Audience = { audienceRoleIds: string[]; audienceMemberIds: string[]; inheritAccess: boolean }
export default function DocumentAudience({ organizationId,value,onChange,pointId,folderId,visibility,targetMemberId,disabled=false }: { organizationId:string;value:Audience;onChange:(v:Audience)=>void;pointId:string;folderId?:string;visibility:string;targetMemberId?:string;disabled?:boolean }) {
  const roles=useAccessRoles(organizationId), members=useDocumentMembers(organizationId,visibility==='SELECTED',!pointId,pointId), {apiRequest}=useAuth()
  const signature=JSON.stringify({...value,pointId:pointId||null,folderId:folderId||null,visibility,targetMemberId:targetMemberId||null})
  const [settled,setSettled]=useState(signature)
  useEffect(()=>{const timer=window.setTimeout(()=>setSettled(signature),300);return()=>window.clearTimeout(timer)},[signature])
  const preview=useQuery({queryKey:['document-audience-preview',organizationId,settled],queryFn:()=>apiRequest<{members:Array<{id:string;name:string;avatarUrl:string|null;allowed:boolean}>}>(`/organizations/${organizationId}/documents/access-preview`,{method:'POST',body:JSON.parse(settled)}),enabled:!disabled && signature===settled})
  const toggle=(key:'audienceRoleIds'|'audienceMemberIds',id:string)=>onChange({...value,[key]:value[key].includes(id)?value[key].filter(v=>v!==id):[...value[key],id]})
  return <div className="document-audience">
    {folderId && visibility!=='PRIVATE_MEMBER' && <label className="document-checkbox"><input type="checkbox" disabled={disabled} checked={value.inheritAccess} onChange={e=>onChange({...value,inheritAccess:e.target.checked})}/><span>Наследовать доступ папки</span></label>}
    {visibility==='SELECTED'&&!value.inheritAccess&&<>
      <fieldset><legend>Роли</legend><div className="document-recipient-picker">{roles.isError ? <p role="alert">Не удалось загрузить роли.</p> : roles.data?.roles.filter(r=>r.systemCode!=='OWNER').map(r=><label className="document-checkbox" key={r.id}><input type="checkbox" disabled={disabled} checked={value.audienceRoleIds.includes(r.id)} onChange={()=>toggle('audienceRoleIds',r.id)}/><span>{r.name}</span></label>)}</div></fieldset>
      <MemberPicker label="Дополнительные сотрудники" members={(members.data?.members ?? []).filter(m=>!m.former).map(m=>({id:m.id,displayName:m.name,avatarUrl:m.avatarUrl,email:m.email}))} value={value.audienceMemberIds} onChange={ids=>onChange({...value,audienceMemberIds:ids})} disabled={disabled} loading={members.isLoading}/>
      {members.isError && <p className="form-inline-error" role="alert">Не удалось загрузить сотрудников.</p>}
    </>}
    {preview.data && <details className="document-audience-preview"><summary><span>Доступ к документу</span><span className="document-audience-preview__count">С доступом: {preview.data.members.filter(m=>m.allowed).length}</span><HelpTip label="Как определяется доступ к документу">Учитываются права на библиотеку, выбранная точка и доступ родительских папок. Владелец имеет полный доступ. При выборе роли учитываются её текущие участники.</HelpTip><span className="document-audience-preview__chevron" aria-hidden="true">⌄</span></summary><ul>{preview.data.members.map(m=><li key={m.id}><MemberAvatar memberId={m.id} locationId={pointId || undefined} url={m.avatarUrl} name={m.name} className="app-avatar"/><span className="document-audience-preview__name">{m.name}</span><span className={`document-audience-preview__status${m.allowed?' is-allowed':''}`}>{m.allowed?'Есть доступ':'Нет доступа'}</span></li>)}</ul></details>}
    {preview.isError&&<p className="form-inline-error">Не удалось проверить аудиторию. {preview.error.message}</p>}
  </div>
}
