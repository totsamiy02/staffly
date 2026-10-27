import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import { liveQueryOptions } from '../live-query.ts'
import type { MemberProfileData, ProfileOptions } from './types.ts'
export function useMemberProfileData(organizationId: string, memberId: string, options: ProfileOptions) {
  const { apiRequest, user } = useAuth()
  const params: ProfileOptions = { ...options, page: options.section === 'overview' ? 1 : options.page, kind: options.section === 'documents' ? options.kind : 'personal', requestState: options.section === 'requests' ? options.requestState : 'all' }
  return useQuery({ ...liveQueryOptions, queryKey: ['member-profile', organizationId, user?.id, memberId, params], placeholderData: (previous, previousQuery) => {
    const key = previousQuery?.queryKey, previousOptions = key?.[4] as ProfileOptions | undefined
    // Keep the identity and period controls mounted while a different month loads.
    // AsyncPanel hides stale section rows; a change of person, account or point still clears everything.
    return key?.[1] === organizationId && key?.[2] === user?.id && key?.[3] === memberId && previousOptions?.locationId === options.locationId ? previous : undefined
  }, queryFn: () => apiRequest<MemberProfileData>(`/organizations/${organizationId}/members/${memberId}/profile?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`) })
}
