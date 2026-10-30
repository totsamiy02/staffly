import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading, startupError, retryStartup } = useAuth()
  const location = useLocation()
  if (loading) return <main className="app-loading" aria-label="Загрузка">{startupError ? <section className="connection-state" role="status"><h1>Восстанавливаем соединение</h1><p>{startupError}</p><button type="button" className="app-primary" onClick={retryStartup}>Попробовать сейчас</button></section> : <span />}</main>
  if (!user) return <Navigate to={`/auth?mode=login&returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return children
}
