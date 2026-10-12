import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import HeaderFrame from '../../component/header/header-frame.tsx'
import { useAuth } from '../../app/auth/auth-context.tsx'
import InvitationCenter from './topbar/invitation-center.tsx'
import NotificationAlerts from './topbar/notification-alerts.tsx'
import ProfileMenu from './topbar/profile-menu.tsx'
import type { OrganizationSummary } from '../../app/organizations/types.ts'

export default function AppTopbar({ organization, notificationOrganizationId }: { organization?: OrganizationSummary; notificationOrganizationId?: string }) {
  const organizationId = organization?.id ?? notificationOrganizationId
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [openPanel, setOpenPanel] = useState<'notifications' | 'profile' | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const controlsRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setOpenPanel(null); setHistoryOpen(false) }, [organizationId])

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


  async function signOut() {
    setLogoutBusy(true)
    try { await logout(); navigate('/', { replace: true }) } finally { setLogoutBusy(false) }
  }

  return <HeaderFrame variant={organization ? 'workspace' : 'app'} afterContent={<NotificationAlerts key={organizationId ?? 'global'} organizationId={organizationId} suppressed={openPanel === 'notifications' || historyOpen} />}>
    {user && <div className="app-topbar__controls" ref={controlsRef}>
      <InvitationCenter key={organizationId ?? 'global'} organizationId={organizationId} onHistoryChange={setHistoryOpen} open={openPanel === 'notifications'} onToggle={() => setOpenPanel((current) => current === 'notifications' ? null : 'notifications')} onClose={() => setOpenPanel(null)} />
      <ProfileMenu user={user} organization={organization} open={openPanel === 'profile'} busy={logoutBusy} onToggle={() => setOpenPanel((current) => current === 'profile' ? null : 'profile')} onClose={() => setOpenPanel(null)} onLogout={() => void signOut()} />
    </div>}
  </HeaderFrame>
}
