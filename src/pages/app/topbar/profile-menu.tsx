import { Link, useLocation } from 'react-router-dom'
import type { AuthUser } from '../../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'

function ChevronIcon() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
}

type ProfileMenuProps = {
  user: AuthUser
  organization?: OrganizationSummary
  open: boolean
  busy: boolean
  onToggle: () => void
  onClose: () => void
  onLogout: () => void
}

const roles = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Пользователь' } as const

export default function ProfileMenu({ user, organization, open, busy, onToggle, onClose, onLogout }: ProfileMenuProps) {
  const location = useLocation()
  const initial = user.displayName.slice(0, 1).toUpperCase()
  return <div className="topbar-popover-host">
    <button className={`topbar-profile-trigger${open ? ' topbar-profile-trigger--active' : ''}`} type="button" aria-label="Открыть профиль" aria-expanded={open} onClick={onToggle}>
      <Avatar url={user.avatarUrl} name={initial} className="app-avatar" eager />
      <span className="topbar-profile-trigger__text"><strong>{user.displayName}</strong><small>{organization ? `${roles[organization.role]} · ${organization.name}` : 'Профиль'}</small></span>
      <span className="topbar-profile-trigger__chevron"><ChevronIcon /></span>
    </button>
    {open && <section className="topbar-popover topbar-popover--profile" aria-label="Профиль пользователя">
      <div className="profile-preview"><Avatar url={user.avatarUrl} name={initial} className="profile-preview__avatar" eager /><div><strong>{user.displayName}</strong><span>{user.email}</span>{organization && <small>{roles[organization.role]} в «{organization.name}»</small>}</div></div>
      <nav><Link to="/app/settings" state={{ returnTo: location.pathname + location.search }} onClick={onClose}><span>Настройки профиля</span><small>Пароль и данные аккаунта</small></Link></nav>
      <button className="profile-preview__logout" type="button" disabled={busy} onClick={onLogout}>{busy ? 'Выходим…' : 'Выйти из аккаунта'}</button>
    </section>}
  </div>
}
