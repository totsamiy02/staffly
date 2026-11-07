import { useNavigate } from 'react-router-dom'
import RequestErrorMessage from '../../component/ui/request-error-message.tsx'
import { AdminIcon } from './admin-elements.tsx'

export function Loading({error,retry}:{error:Error|null;retry:()=>void}){
  const navigate=useNavigate()
  return error?<div className="admin-load-error" role="alert"><AdminIcon name="help"/><h2>Не удалось загрузить страницу</h2><RequestErrorMessage error={error}/><div className="admin-actions"><button className="admin-btn" onClick={()=>{if((window.history.state?.idx??0)>0)void navigate(-1);else void navigate('/admin')}}>Вернуться назад</button><button className="admin-btn admin-btn--primary" onClick={retry}>Повторить загрузку</button></div></div>:<div className="admin-loading" role="status"><span/>Загружаем данные…</div>
}
export function ReadError({error,retry}:{error:Error|null;retry:()=>void}){return error?<div className="admin-notice" role="alert"><RequestErrorMessage error={error}/><button className="admin-text-button" onClick={retry}>Повторить</button></div>:null}
