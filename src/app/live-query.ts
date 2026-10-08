import type { QueryClient } from '@tanstack/react-query'

// Shared cross-user synchronization: visible pages poll; returning to a tab always fetches.
export const liveQueryOptions = {
  refetchInterval: 10_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: 'always',
  refetchOnReconnect: 'always',
} as const

export async function invalidateOrganizationWork(client: QueryClient, organizationId: string) {
  const prefixes = ['shift-offers', 'shift-offer', 'shift-offer-candidates', 'shift-offer-settings', 'locations-overview', 'locations', 'absences', 'schedule', 'my-upcoming-shifts', 'shift-details', 'requests', 'request', 'work-time-statistics', 'member-work-time', 'my-work-time']
  await Promise.all([
    ...prefixes.map(prefix => client.invalidateQueries({ queryKey: [prefix, organizationId] })),
    client.invalidateQueries({ queryKey: ['shift-notifications'] }),
    client.invalidateQueries({ queryKey: ['notifications'] }),
  ])
}
