import { useState } from 'react'
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

export function useAccountNotifications(organizationId?: string) {
  const { apiRequest, user, locationId } = useAuth()
  const params = new URLSearchParams({ unread: 'true', limit: '50' })
  if (organizationId) params.set('organizationId', organizationId)
  if (organizationId && locationId) params.set('locationId', locationId)
  return useQuery({ ...liveQueryOptions, queryKey: ['account-notifications', organizationId, locationId], queryFn: async () => {
    const page = await apiRequest<import('./types.ts').NotificationPage>(`/notifications?${params}`)
    return { notifications: page.notifications.filter(n => n.source === 'event').map(n => ({ ...n, id: n.id.replace('event:', ''), requestId: n.requestId ?? null, type: n.type as AccountNotification['type'] })) as AccountNotification[] }
  }, enabled: Boolean(user) })
}

export function useOrganization(organizationId: string | undefined) {
  const { locationId, apiRequest, user } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['organization', organizationId, locationId], queryFn: () => apiRequest<{ organization: OrganizationSummary }>(`/organizations/${organizationId}`), enabled: Boolean(user && organizationId) })
}

export function useOrganizationMembers(organizationId: string | undefined, options?: { page: number; pageSize: number; search?: string; role?: OrganizationRole; positionId?: string; directory?: boolean; pointId?: string }) {
  const { locationId, apiRequest, user } = useAuth()
  const query = new URLSearchParams()
  if (options) {
    query.set('page', String(options.page)); query.set('pageSize', String(options.pageSize))
    if (options.search) query.set('search', options.search)
    if (options.role) query.set('role', options.role)
    if (options.directory) query.set('directory', 'true')
    if (options.pointId) query.set('pointId', options.pointId)
    if (options.positionId) query.set('positionId', options.positionId)
  }
  const suffix = query.size ? `?${query}` : ''
  return useQuery({ ...liveQueryOptions, queryKey: ['organization-members', organizationId, options, locationId], queryFn: () => apiRequest<{ members: OrganizationMember[]; pagination?: MemberPagination }>(`/organizations/${organizationId}/members${suffix}`), enabled: Boolean(user && organizationId), placeholderData: (previous, previousQuery) => previousQuery?.queryKey.at(-1) === locationId ? previous : undefined })
}

export function useActiveOrganizationInvitations(organizationId: string | undefined, enabled = true) {
  const { locationId, apiRequest, user } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['organization-invitations', organizationId, locationId], queryFn: () => apiRequest<{ invitations: ActiveOrganizationInvitation[] }>(`/organizations/${organizationId}/invitations`), enabled: Boolean(user && organizationId && enabled) })
}

export function useNotificationHistory(options: { limit?: number; cursor?: string; unread?: boolean; organizationId?: string; category?: string } = {}) {
  const { apiRequest, user, locationId } = useAuth()
  const params = new URLSearchParams({ limit: String(options.limit ?? 20), unread: String(options.unread ?? false) })
  if (options.organizationId && locationId) params.set('locationId', locationId)
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.organizationId) params.set('organizationId', options.organizationId)
  if (options.category) params.set('category', options.category)
  return useQuery({ ...liveQueryOptions, queryKey: ['notifications', options, options.organizationId ? locationId : undefined], queryFn: () => apiRequest<import('./types.ts').NotificationPage>(`/notifications?${params}`), enabled: Boolean(user) })
}

export function useNotificationActions(organizationId?: string) {
  const [removingId, setRemovingId] = useState<string | null>(null)
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const refresh = () => Promise.all(['notifications', 'invitations', 'organizations', 'account-notifications', 'shift-notifications'].map(key => client.invalidateQueries({ queryKey: [key] })))
  const read = useMutation({ mutationFn: ({ id, unread = false }: { id: string; unread?: boolean }) => apiRequest(`/notifications/${id}/read`, { method: 'POST', body: { unread, organizationId } }), onSuccess: refresh })
  const invitation = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'accept' | 'reject' }) => apiRequest(`/invitations/${id.replace('invite:', '')}/${action}`, { method: 'POST', body: {} }), onSuccess: refresh })
  const readAll = useMutation({ mutationFn: () => apiRequest('/notifications/read-all', { method: 'POST', body: { organizationId } }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: async (id: string) => { await apiRequest(`/notifications/${id}${organizationId ? `?organizationId=${organizationId}` : ''}`, { method: 'DELETE' }); setRemovingId(id); await new Promise(resolve => window.setTimeout(resolve, 180)) }, onSuccess: refresh })
  return { read, invitation, readAll, remove, removingId, error: invitation.error || read.error || readAll.error || remove.error }
}

export function useLocations(organizationId: string | undefined) {
  const { apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['locations', organizationId], queryFn: () => apiRequest<{ locations: import('./types.ts').OrganizationLocation[] }>(`/organizations/${organizationId}/locations`), enabled: Boolean(organizationId) })
}
export function useLocationTeams(organizationId: string) {
  const { apiRequest, locationId } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['location-teams', organizationId, locationId], queryFn: () => apiRequest<{ teams: import('./types.ts').LocationTeam[] }>(`/organizations/${organizationId}/teams`) })
}

export function useOrganizationDirectory(organizationId: string, enabled = true) {
  const { apiRequest, locationId } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['location-directory', organizationId, locationId], queryFn: () => apiRequest<{ members: import('./types.ts').DirectoryMember[] }>(`/organizations/${organizationId}/all-members`), enabled })
}
