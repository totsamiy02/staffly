import type { ComponentProps } from 'react'
import Avatar from './avatar/avatar.tsx'
import MemberProfileLink from './member-profile-link.tsx'

/** Employee avatar only. Organization logos and account-menu controls use Avatar. */
export default function MemberAvatar({ memberId, locationId, className, ...avatar }: ComponentProps<typeof Avatar> & { memberId: string; locationId?: string }) {
  return <MemberProfileLink memberId={memberId} locationId={locationId} className={`${className} media-avatar member-profile-avatar`} label={`Профиль: ${avatar.name}`}>
    <Avatar {...avatar} className="member-profile-avatar__image" />
  </MemberProfileLink>
}
