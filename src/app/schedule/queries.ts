import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import type { MemberWorkTime, ShiftDetails, ShiftNotification, WorkShift, WorkTimeStatistics } from './types.ts'

export function useSchedule(organizationId: string, from: string, to: string) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['schedule', organizationId, from, to], queryFn: () => apiRequest<{ timezone: string; shifts: WorkShift[] }>(`/organizations/${organizationId}/schedule?from=${from}&to=${to}`), placeholderData: (previous) => previous })
}

export function useMyUpcomingShifts(organizationId: string, enabled = true) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['my-upcoming-shifts', organizationId], queryFn: () => apiRequest<{ timezone: string; shifts: WorkShift[] }>(`/organizations/${organizationId}/schedule/mine/upcoming`), enabled })
}

export function useShiftNotifications() {
  const { apiRequest, user } = useAuth()
  return useQuery({ queryKey: ['shift-notifications'], queryFn: () => apiRequest<{ notifications: ShiftNotification[] }>('/shift-notifications'), enabled: Boolean(user), refetchInterval: 30_000, refetchOnWindowFocus: true })
}

type StatisticsParams = { from?: string; to?: string; memberState?: 'active' | 'all' | 'former'; sort?: string; direction?: 'asc' | 'desc'; page?: number }
function queryString(params: StatisticsParams) {
  const query = new URLSearchParams()
  if (params.from) query.set('from', params.from)
  if (params.to) query.set('to', params.to)
  query.set('memberState', params.memberState ?? 'active')
  query.set('sort', params.sort ?? 'name')
  query.set('direction', params.direction ?? 'asc')
  query.set('page', String(params.page ?? 1))
  query.set('limit', '50')
  return query.toString()
}

export function useWorkTimeStatistics(organizationId: string, params: StatisticsParams, enabled = true) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['work-time-statistics', organizationId, params], queryFn: () => apiRequest<WorkTimeStatistics>(`/organizations/${organizationId}/statistics/work-time?${queryString(params)}`), enabled })
}

export function useMemberWorkTime(organizationId: string, memberId: string | null, params: StatisticsParams) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['member-work-time', organizationId, memberId, params], queryFn: () => apiRequest<MemberWorkTime>(`/organizations/${organizationId}/members/${memberId}/work-time?${queryString({ ...params, memberState: 'all' })}`), enabled: Boolean(memberId) })
}

export function useMyWorkTime(organizationId: string, params: StatisticsParams, enabled = true) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['my-work-time', organizationId, params], queryFn: () => apiRequest<MemberWorkTime>(`/organizations/${organizationId}/me/work-time?${queryString({ ...params, memberState: 'all' })}`), enabled })
}

export function useShiftDetails(organizationId: string, shiftId: string | null, page = 1) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['shift-details', organizationId, shiftId, page], queryFn: () => apiRequest<{ shift: ShiftDetails }>(`/organizations/${organizationId}/shifts/${shiftId}?page=${page}&limit=20`), enabled: Boolean(shiftId) })
}
