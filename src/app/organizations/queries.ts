import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import type { AccountNotification, ActiveOrganizationInvitation, OrganizationMember, OrganizationSummary, PendingInvitation } from './types.ts'

export function useOrganizations() {
  const { apiRequest, user } = useAuth()
  return useQuery({ queryKey: ['organizations'], queryFn: () => apiRequest<{ organizations: OrganizationSummary[] }>('/organizations'), enabled: Boolean(user) })
}

export function usePendingInvitations() {
  const { apiRequest, user } = useAuth()
  return useQuery({
    queryKey: ['invitations'],
    queryFn: () => apiRequest<{ invitations: PendingInvitation[] }>('/invitations'),
    enabled: Boolean(user),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}

export function useAccountNotifications() {
  const { apiRequest, user } = useAuth()
  return useQuery({ queryKey: ['account-notifications'], queryFn: () => apiRequest<{ notifications: AccountNotification[] }>('/account-notifications'), enabled: Boolean(user), refetchInterval: 30_000, refetchOnWindowFocus: true })
}

export function useOrganization(organizationId: string | undefined) {
  const { apiRequest, user } = useAuth()
  return useQuery({ queryKey: ['organization', organizationId], queryFn: () => apiRequest<{ organization: OrganizationSummary }>(`/organizations/${organizationId}`), enabled: Boolean(user && organizationId) })
}

export function useOrganizationMembers(organizationId: string | undefined) {
  const { apiRequest, user } = useAuth()
  return useQuery({ queryKey: ['organization-members', organizationId], queryFn: () => apiRequest<{ members: OrganizationMember[] }>(`/organizations/${organizationId}/members`), enabled: Boolean(user && organizationId), refetchInterval: 60_000, refetchOnWindowFocus: true })
}

export function useActiveOrganizationInvitations(organizationId: string | undefined, enabled = true) {
  const { apiRequest, user } = useAuth()
  return useQuery({ queryKey: ['organization-invitations', organizationId], queryFn: () => apiRequest<{ invitations: ActiveOrganizationInvitation[] }>(`/organizations/${organizationId}/invitations`), enabled: Boolean(user && organizationId && enabled) })
}
