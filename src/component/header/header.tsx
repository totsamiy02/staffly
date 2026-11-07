import './header.scss'
import HeaderFrame from './header-frame.tsx'
import { Link } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../app/auth/auth-context.tsx'
import ThemeToggle from '../ui/theme-toggle/theme-toggle.tsx'
import ProfileMenu from './profile-menu.tsx'

function Header() {
  const { user, loading, logout } = useAuth()
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)
  async function signOut() {
    setLogoutBusy(true)
    setLogoutError('')
    try { await logout(); setProfileOpen(false) }
    catch (error) { setLogoutError(error instanceof Error ? error.message : 'Не удалось выйти из аккаунта. Повторите попытку.') }
    finally { setLogoutBusy(false) }
  }

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
    <HeaderFrame variant="public" id="top">

      <div className="site-header__actions"><ThemeToggle />
        {loading ? null : user ? (
          <div ref={profileRef}>
            <ProfileMenu user={user} open={profileOpen} busy={logoutBusy} error={logoutError} onToggle={() => setProfileOpen(value => !value)} onClose={() => setProfileOpen(false)} onLogout={() => void signOut()} />
          </div>
        ) : (
          <div className="header__buttons">
            <Link className="button button--white" to="/auth?mode=login">Вход</Link>
            <Link className="button button--black" to="/auth?mode=register">Регистрация</Link>
          </div>
        )}</div>
    </HeaderFrame>
  )
}

export default Header
