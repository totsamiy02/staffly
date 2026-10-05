import { useQueries, useQuery } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { liveQueryOptions } from '../../app/live-query.ts'
import type { OrganizationLocation } from '../../app/organizations/types.ts'
import type { WorkShift } from '../../app/schedule/types.ts'
import type { RequestList } from '../../app/requests/types.ts'
import type { DocumentPage } from '../../app/documents/types.ts'

export type DashboardShift = WorkShift & { locationId: string; locationName: string; timezone: string }

export function useDashboardSchedule(organizationId: string, points: OrganizationLocation[], from: string, to: string, ready: boolean) {
  const { apiRequest } = useAuth()
  const queries = useQueries({ queries: points.map(point => ({
    ...liveQueryOptions,
    queryKey: ['schedule', organizationId, from, to, 'current', point.id],
    queryFn: () => apiRequest<{ shifts: WorkShift[] }>(`/organizations/${organizationId}/schedule?${new URLSearchParams({ from, to, locationId: point.id })}`),
  })) })
  return {
    data: { shifts: queries.flatMap((query, index) => (query.data?.shifts ?? []).map(shift => ({ ...shift, locationId: points[index].id, locationName: points[index].name, timezone: points[index].timezone }))) as DashboardShift[] },
    isLoading: !ready || queries.some(query => query.isLoading),
    isError: queries.some(query => query.isError),
    isPlaceholderData: false,
    refetch: () => Promise.all(queries.map(query => query.refetch())),
  }
}

export function useDashboardRecords(organizationId: string, locationId: string | undefined, pointId: string, manager: boolean) {
  const { apiRequest } = useAuth()
  const scope = manager ? 'incoming' : 'mine'
  const params = new URLSearchParams({ locationId: locationId ?? '', pointId })
  const enabled = Boolean(locationId)
  const requests = useQuery({ ...liveQueryOptions, queryKey: ['requests', organizationId, 'dashboard', scope, pointId], enabled,
    queryFn: () => apiRequest<RequestList>(`/organizations/${organizationId}/requests/${scope}?${params}&page=1&pageSize=4`) })
  const pending = useQuery({ ...liveQueryOptions, queryKey: ['requests', organizationId, 'dashboard-pending', scope, pointId], enabled,
    queryFn: () => apiRequest<RequestList>(`/organizations/${organizationId}/requests/${scope}?${params}&status=PENDING&page=1&pageSize=1`) })
  const documents = useQuery({ ...liveQueryOptions, queryKey: ['documents', organizationId, 'dashboard', pointId], enabled,
    queryFn: () => apiRequest<DocumentPage>(`/organizations/${organizationId}/documents?${params}&scope=required&pageSize=4`) })
  // The directory count is distinct members, not the sum of point memberships.
  const members = useQuery({ ...liveQueryOptions, queryKey: ['organization-members', organizationId, 'dashboard-count', pointId], enabled,
    queryFn: () => apiRequest<{ pagination: { total: number } }>(`/organizations/${organizationId}/members?locationId=${locationId}&directory=true&page=1&pageSize=1${pointId === 'all' ? '' : `&pointId=${pointId}`}`) })
  return { requests, pending, documents, members }
}
