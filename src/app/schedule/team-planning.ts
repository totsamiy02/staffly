import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import { liveQueryOptions } from '../live-query.ts'
import type { TeamPlanningSettings, DemandData, CoverageDay, DraftSummary, DraftDetail, DraftValidation } from './team-planning-types.ts'
export function useTeamSettings(organizationId:string) {
  const {locationId,apiRequest}=useAuth()
  return useQuery({...liveQueryOptions,queryKey:['team-planning-settings',organizationId,locationId],queryFn:()=>apiRequest<TeamPlanningSettings>(`/organizations/${organizationId}/schedule/team-settings`)})
}
export function useDemand(organizationId:string,enabled=true) {
  const {locationId,apiRequest}=useAuth()
  return useQuery({...liveQueryOptions,enabled,queryKey:['demand',organizationId,locationId],queryFn:()=>apiRequest<DemandData>(`/organizations/${organizationId}/schedule/demand`)})
}
export function useCoverage(organizationId:string,from:string,to:string,enabled=true) {
  const {locationId,apiRequest}=useAuth()
  return useQuery({...liveQueryOptions,enabled,queryKey:['coverage',organizationId,locationId,from,to],queryFn:()=>apiRequest<{days:CoverageDay[]}>(`/organizations/${organizationId}/schedule/coverage?from=${from}&to=${to}`)})
}
export function useDrafts(organizationId:string) {
  const {locationId,apiRequest}=useAuth()
  return useQuery({...liveQueryOptions,queryKey:['schedule-drafts',organizationId,locationId],queryFn:()=>apiRequest<{drafts:DraftSummary[]}>(`/organizations/${organizationId}/schedule/drafts`)})
}
export function useDraft(organizationId:string,id:string|undefined) {
  const {locationId,apiRequest}=useAuth()
  return useQuery({...liveQueryOptions,enabled:!!id,queryKey:['schedule-draft',organizationId,locationId,id],queryFn:()=>apiRequest<DraftDetail>(`/organizations/${organizationId}/schedule/drafts/${id}`)})
}
export function useDraftInbox(organizationId:string) {
  const {apiRequest}=useAuth()
  return useQuery({...liveQueryOptions,queryKey:['schedule-discussions',organizationId],queryFn:()=>apiRequest<{drafts:Array<DraftSummary & {locationId:string;locationName:string;canManage:boolean;ownResponse:string|null;needsResponse:boolean}>}>(`/organizations/${organizationId}/schedule/discussions`)})
}
export function useDraftValidation(organizationId:string,id:string,enabled:boolean) {
  const {locationId,apiRequest}=useAuth()
  return useQuery({...liveQueryOptions,enabled,queryKey:['draft-validation',organizationId,locationId,id],queryFn:()=>apiRequest<DraftValidation>(`/organizations/${organizationId}/schedule/drafts/${id}/validation`)})
}
export const draftStatusLabels = { PREPARING:'Подготовка', OPEN:'Обсуждение открыто', CLOSED:'Ожидает решения', APPLIED:'Применён', CANCELLED:'Отменён' }
