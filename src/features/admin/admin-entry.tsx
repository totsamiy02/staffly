import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'

export default function AdminEntry() {
  const { user, apiRequest } = useAuth()
  const { data } = useQuery({ queryKey: ['admin-entry', user?.id], queryFn: () => apiRequest<{eligible:boolean}>('/admin/access'), enabled: Boolean(user), staleTime: 20000, retry: false, refetchOnWindowFocus: true })
  return data?.eligible ? <a className="app-topbar__admin-link" aria-label="Администрирование" title="Администрирование — открыть в новой вкладке" href="/admin" target="_blank" rel="noopener noreferrer"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></svg><span className="app-topbar__admin-label">Администрирование</span></a> : null
}
