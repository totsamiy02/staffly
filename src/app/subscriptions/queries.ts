import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import { liveQueryOptions } from '../live-query.ts'
import type { SubscriptionSnapshot } from './plans.ts'
export type SubscriptionDetails = { subscription: SubscriptionSnapshot; usage: { members: number; locations: number; storageBytes: number }; canManage: boolean; mode: 'test'; organization: { id: string; name: string }; purchases: Array<{ id: string; plan: 'TEAM' | 'BUSINESS'; amountMinor: number; activatedAt: string; periodStart: string; periodEnd: string; kind: string }> }
export function useSubscriptionDetails(organizationId: string) {
  const { apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, refetchInterval: 30000, queryKey: ['subscription', organizationId], queryFn: () => apiRequest<SubscriptionDetails>(`/organizations/${organizationId}/subscription`) })
}
export function useSubscriptionRefresh() {
  const client = useQueryClient()
  return () => Promise.all(['notifications', 'account-notifications', 'subscription', 'organization', 'organizations', 'organization-resources', 'team-planning-settings', 'schedule-drafts', 'schedule-draft', 'draft-validation', 'schedule-discussions', 'coverage', 'demand', 'report-options', 'access-roles'].map(key => client.invalidateQueries({ queryKey: [key] })))
}
