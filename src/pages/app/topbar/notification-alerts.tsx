import Avatar from '../../../component/ui/avatar/avatar.tsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useAccountNotifications } from '../../../app/organizations/queries.ts'
import type { AccountNotification } from '../../../app/organizations/types.ts'
import { takeFreshNotifications } from '../../../app/organizations/floating-notifications.ts'

const seenByUser = new Map<string, Set<string>>()
function seenNotices(userId: string) {
  const cached = seenByUser.get(userId)
  if (cached) return cached
  let ids: string[] = []
  try { const saved: unknown = JSON.parse(sessionStorage.getItem(`staffly:floating-notices:${userId}`) ?? '[]'); if (Array.isArray(saved)) ids = saved.filter((id): id is string => typeof id === 'string') } catch { /* Storage may be unavailable. */ }
  const seen = new Set(ids)
  seenByUser.set(userId, seen)
  return seen
}

export default function NotificationAlerts({ organizationId, suppressed }: { organizationId?: string; suppressed?: boolean }) {
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const notifications = useAccountNotifications(organizationId, null)
  const [visible, setVisible] = useState<Array<{ item: AccountNotification; seconds: number }>>([])
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible')

  useEffect(() => { setVisible([]) }, [user?.id])

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    if (!user?.id) return
    const seen = seenNotices(user.id)
    const fresh = takeFreshNotifications(notifications.data?.notifications ?? [], seen)
    try { sessionStorage.setItem(`staffly:floating-notices:${user.id}`, JSON.stringify([...seen].slice(-200))) } catch { /* Keep in-memory deduplication. */ }
    if (suppressed) { setVisible([]); return }
    if (fresh.length) setVisible(current => [...current, ...fresh.map(item => ({ item, seconds: 15 }))].slice(-4))
  }, [notifications.data, user?.id, suppressed])

  useEffect(() => {
    if (!pageVisible) return
    const timer = window.setInterval(() => setVisible((current) => current.map((entry) => ({ ...entry, seconds: entry.seconds - 1 })).filter((entry) => entry.seconds >= 0)), 1_000)
    return () => window.clearInterval(timer)
  }, [pageVisible])

  function close(id: string) { setVisible(current => current.map(entry => entry.item.id === id ? { ...entry, seconds: 0 } : entry)) }
  function open(item: AccountNotification) {
    close(item.id)
    void apiRequest(`/account-notifications/${item.id}/read`, { method: 'POST', body: {} })
      .then(() => Promise.all([queryClient.invalidateQueries({ queryKey: ['account-notifications'] }), queryClient.invalidateQueries({ queryKey: ['notifications'] })]))
      .catch(() => undefined)
  }

  if (suppressed || !visible.length) return null
  return createPortal(<aside className="notification-alerts" aria-label="Новые уведомления">{visible.filter(({ item }) => !organizationId || item.organization.id === organizationId).map(({ item, seconds }) => <div className={`notification-alert${seconds === 0 ? ' is-closing' : ''}`} role="status" key={item.id}>
    <div>{!organizationId && <div className="notification-alert__organization"><Avatar url={item.organization.logoUrl} name={item.organization.name} className="notification-organization-avatar" /><small>{item.organization.name}</small></div>}<strong>{item.title}</strong><p>{item.message}</p></div>
    <div className="notification-alert__actions"><button type="button" aria-label="Закрыть уведомление" onClick={() => close(item.id)}>×</button><Link to={item.href ?? `/app/organizations/${item.organization.id}/requests?tab=incoming&request=${item.requestId}`} onClick={() => open(item)}>{item.eventId ? 'К событию' : 'К заявке'}</Link></div>
  </div>)}</aside>, document.body)
}
