import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import type { RequestDetail, RequestList, RequestStatus, RequestType } from './types.ts'
import type { OrganizationRole } from '../organizations/types.ts'

export function useRequestTypes(organizationId: string, includeInactive = false) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['request-types', organizationId, includeInactive], queryFn: () => apiRequest<{ types: RequestType[] }>(`/organizations/${organizationId}/request-types${includeInactive ? '?includeInactive=true' : ''}`) })
}

export function useRequests(organizationId: string, scope: 'mine' | 'incoming' | 'history', filters: { page: number; status?: RequestStatus; typeId?: string; memberId?: string; role?: OrganizationRole; from?: string; to?: string; search?: string }) {
  const { apiRequest } = useAuth()
  const query = new URLSearchParams({ page: String(filters.page), pageSize: '20' })
  if (filters.status) query.set('status', filters.status)
  if (filters.typeId) query.set('typeId', filters.typeId)
  if (filters.memberId) query.set('memberId', filters.memberId)
  if (filters.role) query.set('role', filters.role)
  if (filters.from) query.set('from', filters.from)
  if (filters.to) query.set('to', filters.to)
  if (filters.search) query.set('search', filters.search)
  return useQuery({ queryKey: ['requests', organizationId, scope, filters], queryFn: () => apiRequest<RequestList>(`/organizations/${organizationId}/requests/${scope}?${query}`), placeholderData: (previous) => previous })
}

export function useRequestDetail(organizationId: string, requestId: string | null) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['request', organizationId, requestId], queryFn: () => apiRequest<RequestDetail>(`/organizations/${organizationId}/requests/${requestId}`), enabled: Boolean(requestId) })
}
