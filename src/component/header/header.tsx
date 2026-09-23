import './header.scss'
import logo from '../../assets/images/logo/staffly-logo.svg'
import { Link } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../app/auth/auth-context.tsx'
import Avatar from '../ui/avatar/avatar.tsx'

function Header() {
  const { user, loading, logout } = useAuth()
  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function close(event: MouseEvent) {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false)
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') setProfileOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [])

  return (
    <header className="header" id="top">
      <div className="container header__container">
        <a className="header__logo" href="/" aria-label="Staffly — главная">
          <img src={logo} alt="Staffly" />
        </a>

        {loading ? null : user ? (
          <div className="header__profile" ref={profileRef}>
            <button className="header__profile-trigger" type="button" aria-expanded={profileOpen} aria-label="Открыть меню профиля" onClick={() => setProfileOpen((value) => !value)}>
              <Avatar url={user.avatarUrl} name={user.displayName} className="header__avatar" eager />
              <span>{user.displayName}</span>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
            </button>
            {profileOpen && <div className="header__profile-menu">
              <div><Avatar url={user.avatarUrl} name={user.displayName} className="header__profile-menu-avatar" eager /><p><strong>{user.displayName}</strong><small>{user.email}</small></p></div>
              <nav><Link to="/app" onClick={() => setProfileOpen(false)}>Мои организации</Link><Link to="/app/settings" onClick={() => setProfileOpen(false)}>Настройки профиля</Link></nav>
              <button type="button" onClick={() => { setProfileOpen(false); void logout() }}>Выйти из аккаунта</button>
            </div>}
          </div>
        ) : (
          <div className="header__buttons">
            <Link className="button button--white" to="/auth?mode=login">Вход</Link>
            <Link className="button button--black" to="/auth?mode=register">Регистрация</Link>
          </div>
        )}
      </div>
    </header>
  )
}

export default Header
