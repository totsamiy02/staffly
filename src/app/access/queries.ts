import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import type { AccessSnapshot } from './catalog.ts'
export type AccessRole = { id: string; name: string; description: string; systemCode: 'OWNER'|'ADMIN'|'MEMBER'|null; permissions: string[]; memberCount: number; revision: number }
export type MemberAccess = { organizationRoleId: string|null; assignments: Array<{ locationId: string; roleId: string }>; owner: boolean; member: { firstName: string|null; lastName: string|null; email: string }; roles: AccessRole[]; locations: Array<{ id: string; name: string }>; access: AccessSnapshot }
export function useAccessRoles(org: string) { const { apiRequest } = useAuth(); return useQuery({ queryKey: ['access-roles',org], queryFn: () => apiRequest<{ roles: AccessRole[]; canManage: boolean }>(`/organizations/${org}/access/roles`), staleTime: 15000 }) }
export function useMemberAccess(org: string, id: string) { const { apiRequest } = useAuth(); return useQuery({ queryKey: ['member-access',org,id], queryFn: () => apiRequest<MemberAccess>(`/organizations/${org}/members/${id}/access`), enabled: !!id }) }
