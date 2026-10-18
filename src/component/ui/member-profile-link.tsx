import type { ReactNode } from 'react'
import { useMemberProfile } from '../../app/member-profile/context.tsx'
import './member-profile-link.scss'
/** Use as a sibling of selection controls. Never nest it inside another button or label. */
export default function MemberProfileLink({ memberId, locationId, children, className = '', label }: { memberId: string; locationId?: string; children: ReactNode; className?: string; label?: string }) {
  const profile = useMemberProfile()
  return profile?.canOpen(memberId) ? <button type="button" className={`member-profile-link ${className}`} aria-label={label} onClick={event => { event.stopPropagation(); profile.open(memberId, { locationId }) }}>{children}</button> : <span className={className}>{children}</span>
}
