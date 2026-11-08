import { useLocation,useNavigate } from 'react-router-dom'
import RequestErrorMessage from '../../component/ui/request-error-message.tsx'
import type { AdminReadState } from './admin-data.tsx'
import { AdminIcon,adminParent } from './admin-elements.tsx'

export function Loading({error,retry}:{error:Error|null;retry:()=>void}){
  const navigate=useNavigate(),route=useLocation(),parent=adminParent(route.pathname),source=route.state?.adminReturn,matching=parent&&typeof source?.url==='string'&&source.url.split('?')[0]===parent[1],target=matching?source.url:parent?.[1]??'/admin'
  return error?<div className="admin-load-error" role="alert"><AdminIcon name="help"/><h2>Не удалось загрузить страницу</h2><RequestErrorMessage error={error}/><div className="admin-actions"><button className="admin-btn" aria-label={parent?'Вернуться назад':undefined} onClick={()=>void navigate(target,{replace:true,state:matching?{adminRestoreKey:source.key}:null})}>{parent?parent[2]:'К обзору сервиса'}</button><button className="admin-btn admin-btn--primary" onClick={retry}>Повторить загрузку</button></div></div>:<div className="admin-loading" role="status"><span/>Загружаем данные…</div>
}
export function ReadError({error,retry,state}:{error?:Error|null;retry?:()=>void;state?:AdminReadState}){
 const failure=state?.error??error,repeat=state?.refresh??retry
 const at=state?.updatedAt?.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})
 if(failure)return <div className="admin-notice" role="alert">{at&&<span>Не удалось обновить результат. Показаны данные на {at} · МСК.</span>}<RequestErrorMessage error={failure}/><button className="admin-text-button" onClick={repeat}>Повторить</button></div>
 return state?.applying?<p className="admin-read-pending" role="status" aria-live="polite">Применяем фильтры…{at&&<span> Пока показаны данные на {at} · МСК.</span>}</p>:null
}
