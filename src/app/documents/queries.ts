import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import { liveQueryOptions } from '../live-query.ts'
import type { DocumentPage } from './types.ts'
import { documentPath } from './types.ts'
export function useDocuments(organizationId: string, options: Record<string, string | number | undefined> = {}) {
  const { apiRequest } = useAuth()
  const params = new URLSearchParams(); Object.entries(options).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)) })
  return useQuery({ ...liveQueryOptions, queryKey: ['documents', organizationId, options], queryFn: () => apiRequest<DocumentPage>(`${documentPath(organizationId)}?${params}`) })
}
export function useDocumentRefresh() {
  const client = useQueryClient()
  return () => Promise.all(['documents', 'document', 'document-progress', 'personal-documents', 'notifications', 'account-notifications'].map(key => client.invalidateQueries({ queryKey: [key] })))
}

export function useDocumentMembers(organizationId: string, enabled = true) {
  const { apiRequest } = useAuth()
  return useQuery({ enabled, queryKey: ['document-members', organizationId], queryFn: () => apiRequest<{ members: Array<{ id: string; name: string; email: string; avatarUrl: string | null; role: 'OWNER' | 'ADMIN' | 'MEMBER'; former: boolean }> }>(`/organizations/${organizationId}/documents-members`) })
}
