import type { QueryClient } from '@tanstack/react-query'

let connected = false
export function isLiveConnected() { return connected }
export function setLiveConnected(value: boolean) { const changed = connected !== value; connected = value; return changed }
// SSE invalidates active queries. Polling is a fallback for a disconnected stream;
// presence-only UI still refreshes once a minute, since heartbeats are not broadcasts.
export const liveQueryOptions = {
  refetchInterval: (query: { queryKey: readonly unknown[] }) => connected
    ? ['self-exit-work', 'self-exit-candidates', 'attention', 'vacation-balance', 'vacation-balances', 'vacation-balance-history', 'organization-members', 'member-profile', 'member-personnel', 'auth-sessions'].includes(String(query.queryKey[0])) ? 60000 : false
    : 30000 + Math.floor(Math.random() * 10000),
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: 'always',
  refetchOnReconnect: 'always',
} as const

const hintKeys: Record<string, string[]> = {
  schedule: ['self-exit-work', 'self-exit-candidates', 'attention', 'timesheet', 'schedule', 'schedule-planning', 'absences', 'my-upcoming-shifts', 'shift-details', 'shift-offers', 'shift-offer', 'shift-offer-candidates', 'work-time-statistics', 'member-work-time', 'my-work-time', 'locations-overview', 'demand', 'coverage', 'schedule-discussions', 'schedule-drafts', 'schedule-draft', 'draft-validation', 'report-preview', 'report-members', 'vacation-balances', 'vacation-balance', 'vacation-balance-history', 'vacation-warnings'],
  requests: ['self-exit-work', 'self-exit-candidates', 'attention', 'timesheet', 'organization-resources', 'document-request-files', 'requests', 'request', 'request-reviewers', 'request-types', 'vacations', 'vacation-balances', 'vacation-balance', 'vacation-balance-history', 'member-profile'],
  'requests-mine': ['self-exit-work', 'self-exit-candidates', 'attention', 'organization-resources', 'document-request-files', 'requests', 'request', 'request-reviewers', 'vacations', 'vacation-balances', 'vacation-balance', 'vacation-balance-history', 'member-profile'],
  'requests-review': ['self-exit-work', 'self-exit-candidates', 'attention', 'organization-resources', 'document-request-files', 'requests', 'request', 'request-reviewers', 'vacations', 'vacation-balances', 'vacation-balance', 'vacation-balance-history', 'member-profile'],
  documents: ['self-exit-work', 'self-exit-candidates', 'attention', 'organization-resources', 'documents', 'document', 'document-progress', 'personal-documents', 'document-folders', 'document-members', 'member-profile'],
  events: ['events', 'event', 'event-members'],
  organization: ['self-exit-work', 'self-exit-candidates', 'attention', 'timesheet', 'member-profile','member-personnel','document-request-files', 'subscription', 'organization-resources', 'organizations', 'organization', 'locations', 'location-directory', 'location-teams', 'organization-members', 'organization-invitations', 'invitations', 'team-planning-settings', 'schedule-planning', 'shift-offer-settings', 'report-options', 'coverage', 'demand', 'schedule-discussions', 'schedule-drafts', 'schedule-draft', 'draft-validation', 'document-members', 'event-members', 'vacations', 'vacation-settings', 'vacation-balance', 'vacation-balances', 'vacation-balance-history'],
  profile: ['self-exit-work', 'self-exit-candidates', 'attention', 'document-request-files', 'organization-members', 'member-profile', 'member-personnel', 'location-directory', 'auth-login-methods', 'email-preferences', 'schedule', 'my-upcoming-shifts', 'shift-details', 'requests', 'request', 'request-reviewers', 'documents', 'document', 'personal-documents', 'events', 'event', 'event-members', 'document-members', 'report-preview', 'report-members', 'work-time-statistics', 'member-work-time', 'my-work-time'],
  notifications: ['notifications', 'account-notifications', 'shift-notifications', 'invitations'],
}
export function liveHintMatches(hint: { topic: string; organizationId?: string }, queryKey: readonly unknown[]) {
    const key = String(queryKey[0])
    if (key === 'private-media') return ['organization', 'profile'].includes(hint.topic)
    if (key === 'requests' && (hint.topic === 'requests-mine' && queryKey[2] !== 'mine' || hint.topic === 'requests-review' && queryKey[2] === 'mine')) return false
    const matches = hintKeys[hint.topic]?.includes(key)
    return Boolean(matches && (!hint.organizationId || ['organizations', 'notifications', 'account-notifications', 'shift-notifications', 'invitations'].includes(key) || queryKey[1] === hint.organizationId || key === 'personal-documents' && !queryKey[1]))
}
export async function applyLiveHints(client: QueryClient, hints: Array<{ topic: string; organizationId?: string }>) {
  await client.invalidateQueries({ predicate: query => hints.some(hint => liveHintMatches(hint, query.queryKey)), refetchType: 'active' })
}

export async function invalidateOrganizationWork(client: QueryClient, organizationId: string) {
  const prefixes = ['self-exit-work', 'self-exit-candidates', 'attention', 'timesheet', 'document-request-files', 'organization-resources', 'member-profile', 'member-personnel', 'vacations', 'vacation-balances', 'vacation-balance', 'vacation-balance-history', 'team-planning-settings', 'demand', 'coverage', 'schedule-discussions', 'schedule-drafts', 'schedule-draft', 'draft-validation', 'shift-offers', 'shift-offer', 'shift-offer-candidates', 'shift-offer-settings', 'locations-overview', 'locations', 'absences', 'schedule', 'my-upcoming-shifts', 'shift-details', 'requests', 'request', 'request-reviewers', 'work-time-statistics', 'member-work-time', 'my-work-time', 'report-preview', 'report-members']
  await Promise.all([
    ...prefixes.map(prefix => client.invalidateQueries({ queryKey: [prefix, organizationId] })),
    client.invalidateQueries({ queryKey: ['shift-notifications'] }),
    client.invalidateQueries({ queryKey: ['notifications'] }),
  ])
}
