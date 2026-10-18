import { lazy, Suspense, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { canAccess } from '../../../app/access/catalog.ts'
import { MemberProfileContext } from '../../../app/member-profile/context.tsx'
import type { ProfileSection } from '../../../app/member-profile/types.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
const MemberProfileDialog = lazy(() => import('./member-profile-dialog.tsx'))
export default function MemberProfileProvider({ organization, children }: { organization: OrganizationSummary; children: ReactNode }) {
  const [selected, setSelected] = useState<{ memberId: string; locationId: string; section: ProfileSection } | null>(null)
  return <MemberProfileContext.Provider value={{ canOpen: id => id === organization.viewerMemberId || canAccess(organization, 'members.view') || !!organization.permissionLocations?.['members.view']?.length, open: (memberId, options) => setSelected({ memberId, locationId: options?.locationId ?? organization.locationId!, section: options?.section ?? 'overview' }) }}>{children}{selected && createPortal(<Suspense fallback={<div className="schedule-modal" role="status">Загружаем профиль…</div>}><MemberProfileDialog key={`${organization.id}:${selected.memberId}:${selected.locationId}`} organization={organization} memberId={selected.memberId} initialLocationId={selected.locationId} initialSection={selected.section} onClose={() => setSelected(null)} /></Suspense>, document.body)}</MemberProfileContext.Provider>
}
