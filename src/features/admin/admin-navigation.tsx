import { useEffect,useRef,useState } from 'react'
import { NavLink,useLocation } from 'react-router-dom'
import { useDialogFocus } from '../../component/ui/modal/dialog-focus.ts'
import AdminTabs from './admin-tabs.tsx'
import { AdminIcon } from './admin-elements.tsx'

export const ADMIN_COMPACT_QUERY = '(max-width: 1050px), (max-height: 699px)'
const groups = [['Мониторинг',[['', 'Обзор', 'home'], ['organizations', 'Организации', 'org'], ['users', 'Пользователи', 'users'], ['online', 'Онлайн', 'pulse'], ['analytics', 'Аналитика', 'chart'], ['events', 'События', 'clock']]],['Операции',[['operations/service','Состояние сервиса','server'],['operations/jobs','Фоновые задачи','layers'],['operations/support','Поддержка','help']]],['Управление',[['management/security','Безопасность','shield'],['management/backups','Резервные копии','database'],['management/administrators','Администраторы','key'],['management/alerts','Оповещения','bell']]]] as const

type Props = { compact: boolean; open: boolean; onClose: () => void; onLock: () => void; onLeave: () => void }
export default function AdminNavigation({ compact, open, onClose, onLock, onLeave }: Props) {
  const ref=useRef<HTMLElement>(null),{pathname}=useLocation(),currentGroup=groups.find(([,items])=>items.some(([path])=>path&&pathname.startsWith('/admin/'+path)))?.[0]??'Мониторинг'
  const [selected,setSelected]=useState<string>(currentGroup),[present,setPresent]=useState(false)
  const modal=compact&&open,shown=compact&&(open||present)
  useEffect(()=>{setSelected(currentGroup)},[currentGroup])
  useEffect(()=>{if(modal){setPresent(true);return}const timer=setTimeout(()=>setPresent(false),200);return()=>clearTimeout(timer)},[modal])
  useDialogFocus(ref, shown)
  useEffect(() => {
    if (!modal) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [modal, onClose])
  return <>
    {shown && <button type="button" className={`admin-navigation-backdrop ${open?'':'is-closing'}`} aria-label="Закрыть меню" tabIndex={-1} onClick={onClose}/>}
    <aside id="admin-sidebar" ref={ref} tabIndex={-1} className={`admin-sidebar ${shown?'is-open':''} ${shown&&!open?'is-closing':''}`} role={shown ? 'dialog' : undefined} aria-modal={shown || undefined} aria-label={shown ? 'Навигация администратора' : undefined}>
      <button type="button" className="admin-sidebar-close" aria-label="Закрыть навигацию" onClick={onClose}><AdminIcon name="close"/></button>
      <div className="admin-workspace-label"><strong>Администрирование</strong></div>
      {compact&&<AdminTabs label="Группы навигации" value={selected} items={groups.map(([group])=>[group,group])} onChange={setSelected}/>}
      {groups.map(([group,items])=><nav key={group} aria-label={group} hidden={compact&&selected!==group}><p className="admin-nav-label">{group}</p>{items.map(([path,label,icon])=><NavLink key={path} end={!path} to={'/admin'+(path?'/'+path:'')} className={({isActive})=>`admin-nav-item ${isActive?'active':''}`} onClick={onClose}><AdminIcon name={icon}/><span>{label}</span></NavLink>)}</nav>)}
      <div className="admin-sidebar-bottom"><button type="button" className="admin-text-button" onClick={onLock}>Заблокировать панель</button><button type="button" className="admin-text-button" onClick={onLeave}>Выйти из панели</button></div>
    </aside>
  </>
}
