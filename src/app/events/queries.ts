import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import { liveQueryOptions } from '../live-query.ts'
import { eventPath, type EventFormInput, type EventMember, type EventPage, type StaffEvent } from './types.ts'
export function useEvents(organizationId: string, options: Record<string, string | number | undefined> = {}) {
  const { apiRequest, locationId } = useAuth()
  const params = new URLSearchParams()
  Object.entries(options).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)) })
  return useQuery({ ...liveQueryOptions, queryKey: ['events', organizationId, options, locationId], queryFn: () => apiRequest<EventPage>(`${eventPath(organizationId)}?${params}`) })
}
export function useEvent(organizationId: string, eventId: string | null) {
  const { apiRequest, locationId } = useAuth()
  return useQuery({ ...liveQueryOptions, enabled: Boolean(eventId), queryKey: ['event', organizationId, eventId, locationId], queryFn: () => apiRequest<{ event: StaffEvent }>(`${eventPath(organizationId)}/${eventId}`) })
}
export function useEventMembers(organizationId: string, shared: boolean, locationIds: string[]) {
  const { apiRequest, locationId } = useAuth()
  return useQuery({ enabled: shared || locationIds.length > 0, queryKey: ['event-members', organizationId, locationId, shared, [...locationIds].sort()], queryFn: () => apiRequest<{ members: EventMember[]; timezone: string }>(`${eventPath(organizationId)}/members?${new URLSearchParams({ shared: String(shared), locationIds: locationIds.join(',') })}`) })
}
export function useEventActions(organizationId: string) {
  const { apiRequest } = useAuth(), client = useQueryClient()
  const refresh = () => Promise.all(['events', 'event', 'event-members', 'notifications', 'account-notifications'].map(key => client.invalidateQueries({ queryKey: [key] })))
  const save = useMutation({ mutationFn: ({ eventId, input }: { eventId?: string; input: EventFormInput }) => apiRequest<{ event: StaffEvent }>(`${eventPath(organizationId)}${eventId ? `/${eventId}` : ''}`, { method: eventId ? 'PATCH' : 'POST', body: input }), onSuccess: refresh })
  const cancel = useMutation({ mutationFn: ({ id, revision }: { id: string; revision: number }) => apiRequest<{ event: StaffEvent }>(`${eventPath(organizationId)}/${id}/cancel`, { method: 'POST', body: { revision } }), onSuccess: refresh })
  return { save, cancel }
}
