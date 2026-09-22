import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <main className="app-loading" aria-label="Загрузка"><span /></main>
  if (!user) return <Navigate to={`/auth?mode=login&returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return children
}
