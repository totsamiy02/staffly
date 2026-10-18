import type { ComponentProps } from 'react'
import MemberPicker from '../../../component/ui/member-picker/member-picker.tsx'
import { useMemberProfile } from '../../../app/member-profile/context.tsx'
/** Domain adapter keeps the generic picker independent of organization and profile transport. */
export default function ProfileMemberPicker(props: ComponentProps<typeof MemberPicker>) {
  const profile = useMemberProfile()
  return <MemberPicker {...props} onOpenProfile={profile ? id => profile.open(id) : undefined} canOpenProfile={profile?.canOpen} />
}
