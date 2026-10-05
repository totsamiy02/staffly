import { liveQueryOptions } from '../live-query.ts'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import type { EmployeeAbsence, MemberWorkTime, ShiftDetails, ShiftNotification, WorkShift, WorkTimeStatistics } from './types.ts'

export function useCancelledShifts(organizationId: string, params: { page: number; order: 'asc' | 'desc'; memberId: string }) {
  const { locationId, apiRequest } = useAuth()
  const query = new URLSearchParams({ page: String(params.page), limit: '20', order: params.order })
  if (params.memberId) query.set('memberId', params.memberId)
  return useQuery({ ...liveQueryOptions, queryKey: ['schedule', organizationId, 'cancelled-list', params, locationId], queryFn: () => apiRequest<{ timezone: string; shifts: WorkShift[]; pagination: { page: number; total: number; pages: number } }>(`/organizations/${organizationId}/schedule/history?${query}`) })
}

export function useSchedule(organizationId: string, from: string, to: string, mode: 'current' | 'history' = 'current') {
  const { locationId, apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['schedule', organizationId, from, to, mode, locationId], queryFn: () => apiRequest<{ timezone: string; shifts: WorkShift[]; absences: EmployeeAbsence[] }>(`/organizations/${organizationId}/schedule?from=${from}&to=${to}&mode=${mode}`), placeholderData: (previous, previousQuery) => previousQuery?.queryKey.at(-1) === locationId ? previous : undefined })
}

export function useMyUpcomingShifts(organizationId: string, enabled = true) {
  const { locationId, apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['my-upcoming-shifts', organizationId, locationId], queryFn: () => apiRequest<{ timezone: string; shifts: WorkShift[] }>(`/organizations/${organizationId}/schedule/mine/upcoming`), enabled })
}

export function useShiftNotifications() {
  const { apiRequest, user } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['shift-notifications'], queryFn: () => apiRequest<{ notifications: ShiftNotification[] }>('/shift-notifications'), enabled: Boolean(user) })
}

type StatisticsParams = { from?: string; to?: string; memberState?: 'active' | 'all' | 'former'; sort?: string; direction?: 'asc' | 'desc'; page?: number; limit?: number; historyOrder?: 'asc' | 'desc' }
function queryString(params: StatisticsParams) {
  const query = new URLSearchParams()
  if (params.from) query.set('from', params.from)
  if (params.to) query.set('to', params.to)
  query.set('memberState', params.memberState ?? 'active')
  query.set('sort', params.sort ?? 'name')
  query.set('direction', params.direction ?? 'asc')
  query.set('page', String(params.page ?? 1))
  query.set('limit', String(params.limit ?? 50))
  if (params.historyOrder) query.set('historyOrder', params.historyOrder)
  return query.toString()
}

export function useWorkTimeStatistics(organizationId: string, params: StatisticsParams, enabled = true) {
  const { locationId, apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['work-time-statistics', organizationId, params, locationId], queryFn: () => apiRequest<WorkTimeStatistics>(`/organizations/${organizationId}/statistics/work-time?${queryString(params)}`), enabled })
}

export function useMemberWorkTime(organizationId: string, memberId: string | null, params: StatisticsParams) {
  const { locationId, apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['member-work-time', organizationId, memberId, params, locationId], queryFn: () => apiRequest<MemberWorkTime>(`/organizations/${organizationId}/members/${memberId}/work-time?${queryString({ ...params, memberState: 'all' })}`), enabled: Boolean(memberId) })
}

export function useMyWorkTime(organizationId: string, params: StatisticsParams, enabled = true) {
  const { locationId, apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['my-work-time', organizationId, params, locationId], queryFn: () => apiRequest<MemberWorkTime>(`/organizations/${organizationId}/me/work-time?${queryString({ ...params, memberState: 'all' })}`), enabled })
}

export function useShiftDetails(organizationId: string, shiftId: string | null, page = 1) {
  const { locationId, apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['shift-details', organizationId, shiftId, page, locationId], queryFn: () => apiRequest<{ shift: ShiftDetails }>(`/organizations/${organizationId}/shifts/${shiftId}?page=${page}&limit=20`), enabled: Boolean(shiftId) })
}
