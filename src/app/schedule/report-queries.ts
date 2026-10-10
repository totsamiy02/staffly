import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import type { ReportInput, ReportPreview, ReportTemplate } from './reporting.ts'

export type ReportOptions = { locations: Array<{ id: string; name: string; timezone: string; archivedAt: string | null }>; templates: ReportTemplate[] }
export function useReportOptions(organizationId: string) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['report-options', organizationId], queryFn: () => apiRequest<ReportOptions>(`/organizations/${organizationId}/statistics/reports/options`), staleTime: 0 })
}
export function useReportPreview(organizationId: string, input: ReportInput, enabled: boolean) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['report-preview', organizationId, input], queryFn: () => apiRequest<ReportPreview>(`/organizations/${organizationId}/statistics/reports/preview`, { method: 'POST', body: input }), enabled, retry: false, staleTime: 0 })
}
export function useReportMembers(organizationId: string, input: ReportInput, enabled: boolean) {
  const { apiRequest } = useAuth()
  return useQuery({ queryKey: ['report-members', organizationId, input.from, input.to, input.locationIds, input.includeFormer], queryFn: () => apiRequest<{ members: Array<{ id: string; displayName: string; email: string; avatarUrl: string | null; former: boolean }> }>(`/organizations/${organizationId}/statistics/reports/members`, { method: 'POST', body: { ...input, memberIds: [] } }), enabled, retry: false })
}
export function useReportTemplateMutation(organizationId: string) {
  const { apiRequest } = useAuth(), client = useQueryClient()
  return useMutation({ mutationFn: ({ action, id, name, config }: { action: 'save' | 'delete'; id?: string; name?: string; config?: ReportInput['config'] }) => apiRequest<{ id: string }>(`/organizations/${organizationId}/statistics/reports/templates${id ? '/' + id : ''}`, { method: action === 'delete' ? 'DELETE' : id ? 'PUT' : 'POST', ...(action === 'save' ? { body: { name, config } } : {}) }), onSuccess: () => client.invalidateQueries({ queryKey: ['report-options', organizationId] }) })
}
