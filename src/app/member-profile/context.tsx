import { createContext, useContext } from 'react'
import type { ProfileSection } from './types.ts'
export type OpenMemberProfile = (memberId: string, options?: { locationId?: string; section?: ProfileSection }) => void
export const MemberProfileContext = createContext<{ open: OpenMemberProfile; canOpen: (memberId: string) => boolean } | null>(null)
/** Optional outside an organization: generic lists can render plain names there. */
export function useMemberProfile() { return useContext(MemberProfileContext) }
