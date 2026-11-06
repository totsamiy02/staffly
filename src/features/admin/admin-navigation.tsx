import { useEffect, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import { useDialogFocus } from '../../component/ui/modal/dialog-focus.ts'
import { AdminIcon } from './admin-elements.tsx'

export const ADMIN_COMPACT_QUERY = '(max-width: 1050px), (max-height: 639px)'
const sections = [['', 'Обзор', 'home'], ['organizations', 'Организации', 'org'], ['users', 'Пользователи', 'users'], ['online', 'Онлайн', 'pulse'], ['analytics', 'Аналитика', 'chart'], ['events', 'События', 'clock']]
const future = [['Операции', [['Состояние сервиса', 'server'], ['Фоновые задачи', 'layers'], ['Поддержка', 'help']]], ['Управление', [['Безопасность', 'shield'], ['Резервные копии', 'database'], ['Администраторы', 'key'], ['Оповещения', 'bell']]]] as const

type Props = { compact: boolean; open: boolean; onClose: () => void; onLock: () => void; onLeave: () => void }
export default function AdminNavigation({ compact, open, onClose, onLock, onLeave }: Props) {
  const ref = useRef<HTMLElement>(null)
  const modal = compact && open
  useDialogFocus(ref, modal)
  useEffect(() => {
    if (!modal) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [modal, onClose])
  return <>
    {modal && <button type="button" className="admin-navigation-backdrop" aria-label="Закрыть меню" tabIndex={-1} onClick={onClose}/>}
    <aside id="admin-sidebar" ref={ref} tabIndex={-1} className={`admin-sidebar ${open ? 'is-open' : ''}`} role={modal ? 'dialog' : undefined} aria-modal={modal || undefined} aria-label={modal ? 'Навигация администратора' : undefined}>
      <button type="button" className="admin-sidebar-close" aria-label="Закрыть навигацию" onClick={onClose}><AdminIcon name="close"/></button>
      <div className="admin-workspace-label"><AdminIcon name="shield"/><div><strong>Панель Staffly</strong><small>Продукт и инфраструктура</small></div></div>
      <nav aria-label="Мониторинг"><p className="admin-nav-label">Мониторинг</p>{sections.map(([path, label, icon]) => <NavLink key={path} end={!path} to={'/admin' + (path ? '/' + path : '')} className={({ isActive }) => `admin-nav-item ${isActive ? 'active' : ''}`} onClick={onClose}><AdminIcon name={icon}/><span>{label}</span></NavLink>)}</nav>
      {future.map(([group, items]) => <div className="admin-future" key={group}><p className="admin-nav-label">{group}<small>Следующий этап</small></p>{items.map(([label, icon]) => <span className="admin-nav-item" aria-disabled="true" key={label}><AdminIcon name={icon}/><span>{label}</span></span>)}</div>)}
      <div className="admin-sidebar-bottom"><p><AdminIcon name="lock"/>Автоблокировка через 5 минут</p><button type="button" className="admin-text-button" onClick={onLock}>Заблокировать панель</button><button type="button" className="admin-text-button" onClick={onLeave}>Выйти из панели</button></div>
    </aside>
  </>
}
