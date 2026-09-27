import { liveQueryOptions } from '../live-query.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import type { AccountNotification, ActiveOrganizationInvitation, MemberPagination, OrganizationMember, OrganizationRole, OrganizationSummary, PendingInvitation } from './types.ts'

export function useOrganizations() {
  const { apiRequest, user } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['organizations'], queryFn: () => apiRequest<{ organizations: OrganizationSummary[] }>('/organizations'), enabled: Boolean(user) })
}

export function usePendingInvitations() {
  const { apiRequest, user } = useAuth()
  return useQuery({ ...liveQueryOptions,
    queryKey: ['invitations'],
    queryFn: () => apiRequest<{ invitations: PendingInvitation[] }>('/invitations'),
    enabled: Boolean(user),
  })
}

export function useAccountNotifications() {
  const { apiRequest, user } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['account-notifications'], queryFn: () => apiRequest<{ notifications: AccountNotification[] }>('/account-notifications'), enabled: Boolean(user) })
}

export function useOrganization(organizationId: string | undefined) {
  const { apiRequest, user } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['organization', organizationId], queryFn: () => apiRequest<{ organization: OrganizationSummary }>(`/organizations/${organizationId}`), enabled: Boolean(user && organizationId) })
}

export function useOrganizationMembers(organizationId: string | undefined, options?: { page: number; pageSize: number; search?: string; role?: OrganizationRole; positionId?: string }) {
  const { apiRequest, user } = useAuth()
  const query = new URLSearchParams()
  if (options) {
    query.set('page', String(options.page)); query.set('pageSize', String(options.pageSize))
    if (options.search) query.set('search', options.search)
    if (options.role) query.set('role', options.role)
    if (options.positionId) query.set('positionId', options.positionId)
  }
  const suffix = query.size ? `?${query}` : ''
  return useQuery({ ...liveQueryOptions, queryKey: ['organization-members', organizationId, options], queryFn: () => apiRequest<{ members: OrganizationMember[]; pagination?: MemberPagination }>(`/organizations/${organizationId}/members${suffix}`), enabled: Boolean(user && organizationId), placeholderData: (previous) => previous })
}

export function useActiveOrganizationInvitations(organizationId: string | undefined, enabled = true) {
  const { apiRequest, user } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['organization-invitations', organizationId], queryFn: () => apiRequest<{ invitations: ActiveOrganizationInvitation[] }>(`/organizations/${organizationId}/invitations`), enabled: Boolean(user && organizationId && enabled) })
}

export function useNotificationHistory(options: { limit?: number; cursor?: string; unread?: boolean } = {}) {
  const { apiRequest, user } = useAuth()
  const params = new URLSearchParams({ limit: String(options.limit ?? 20), unread: String(options.unread ?? false) })
  if (options.cursor) params.set('cursor', options.cursor)
  return useQuery({ ...liveQueryOptions, queryKey: ['notifications', options], queryFn: () => apiRequest<import('./types.ts').NotificationPage>(`/notifications?${params}`), enabled: Boolean(user) })
}

export function useNotificationActions() {
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const refresh = () => Promise.all(['notifications', 'invitations', 'organizations', 'account-notifications', 'shift-notifications'].map(key => client.invalidateQueries({ queryKey: [key] })))
  const read = useMutation({ mutationFn: ({ id, unread = false }: { id: string; unread?: boolean }) => apiRequest(`/notifications/${id}/read`, { method: 'POST', body: { unread } }), onSuccess: refresh })
  const invitation = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'accept' | 'reject' }) => apiRequest(`/invitations/${id.replace('invite:', '')}/${action}`, { method: 'POST', body: {} }), onSuccess: refresh })
  return { read, invitation, error: invitation.error || read.error }
}
