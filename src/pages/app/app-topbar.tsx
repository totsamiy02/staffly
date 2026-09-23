import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import logo from '../../assets/images/logo/staffly-logo.svg'
import { useAuth } from '../../app/auth/auth-context.tsx'
import InvitationCenter from './topbar/invitation-center.tsx'
import ProfileMenu from './topbar/profile-menu.tsx'
import type { OrganizationSummary } from '../../app/organizations/types.ts'

export default function AppTopbar({ organization }: { organization?: OrganizationSummary }) {
  const { user, logout, apiRequest } = useAuth()
  const navigate = useNavigate()
  const [openPanel, setOpenPanel] = useState<'notifications' | 'profile' | null>(null)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const controlsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      if (!controlsRef.current?.contains(event.target as Node)) setOpenPanel(null)
    }
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpenPanel(null)
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeWithEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeWithEscape) }
  }, [])

  useEffect(() => {
    const heartbeat = () => { if (document.visibilityState === 'visible') void apiRequest('/profile/presence', { method: 'POST', body: {} }).catch(() => undefined) }
    heartbeat()
    const timer = window.setInterval(heartbeat, 60_000)
    document.addEventListener('visibilitychange', heartbeat)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', heartbeat) }
  }, [apiRequest])

  async function signOut() {
    setLogoutBusy(true)
    try { await logout(); navigate('/', { replace: true }) } finally { setLogoutBusy(false) }
  }

  return <header className={`app-topbar${organization ? ' app-topbar--workspace' : ''}`}><div className="app-topbar__inner">
    <Link to="/app" className="app-topbar__logo"><img src={logo} alt="Staffly" /></Link>
    {user && <div className="app-topbar__controls" ref={controlsRef}>
      <InvitationCenter open={openPanel === 'notifications'} onToggle={() => setOpenPanel((current) => current === 'notifications' ? null : 'notifications')} onClose={() => setOpenPanel(null)} />
      <ProfileMenu user={user} organization={organization} open={openPanel === 'profile'} busy={logoutBusy} onToggle={() => setOpenPanel((current) => current === 'profile' ? null : 'profile')} onClose={() => setOpenPanel(null)} onLogout={() => void signOut()} />
    </div>}
  </div></header>
}
