import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import { liveQueryOptions } from '../live-query.ts'
export type Position = { id: string; name: string; isActive: boolean }
export type ShiftTemplate = { id: string; name: string; positionId: string | null; startTime: string; endTime: string; endDayOffset: number; isActive: boolean }
export type PlanningData = { positions: Position[]; templates: ShiftTemplate[]; assignments: Array<{ memberId: string; positionId: string }>; monthlyWorkMinutes: number | null }
export function useSchedulePlanning(organizationId: string) {
  const { locationId, apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['schedule-planning', organizationId, locationId], queryFn: () => apiRequest<PlanningData>('/organizations/' + organizationId + '/schedule/planning') })
}
