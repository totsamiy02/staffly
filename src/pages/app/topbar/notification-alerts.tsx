import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useNotificationHistory, useNotificationActions } from '../../../app/organizations/queries.ts'
import type { HistoryNotification } from '../../../app/organizations/types.ts'
import { takeFreshNotifications } from '../../../app/organizations/floating-notifications.ts'
import NotificationItem from './notification-item.tsx'

const seenByUser = new Map<string, Set<string>>()
function seenNotices(userId: string) {
  const cached = seenByUser.get(userId)
  if (cached) return cached
  let ids: string[] = []
  try { const saved: unknown = JSON.parse(sessionStorage.getItem(`staffly:floating-notices:${userId}`) ?? '[]'); if (Array.isArray(saved)) ids = saved.filter((id): id is string => typeof id === 'string') } catch { /* Storage may be unavailable. */ }
  const seen = new Set(ids.map(id => /^[0-9a-f-]{36}$/i.test(id) ? `event:${id}` : id))
  seenByUser.set(userId, seen)
  return seen
}

export default function NotificationAlerts({ organizationId, suppressed }: { organizationId?: string; suppressed?: boolean }) {
  const { user } = useAuth()
  const notifications = useNotificationHistory({ organizationId, unread: true, limit: 50, locationId: null })
  const actions = useNotificationActions(organizationId)
  const [visible, setVisible] = useState<Array<{ item: HistoryNotification; seconds: number }>>([])
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
    if (notifications.data) setVisible(current => [...current.flatMap(entry => {
      const item = notifications.data.notifications.find(item => item.id === entry.item.id)
      return item ? [{ ...entry, item }] : []
    }), ...fresh.map(item => ({ item, seconds: 15 }))].slice(-4))
  }, [notifications.data, user?.id, suppressed])

  useEffect(() => {
    if (!pageVisible) return
    const timer = window.setInterval(() => setVisible((current) => current.map((entry) => ({ ...entry, seconds: entry.seconds - 1 })).filter((entry) => entry.seconds >= 0)), 1_000)
    return () => window.clearInterval(timer)
  }, [pageVisible])

  function close(id: string) { setVisible(current => current.map(entry => entry.item.id === id ? { ...entry, seconds: 0 } : entry)) }
  if (suppressed || !visible.length) return null
  return createPortal(<aside className="notification-alerts staffly-notification-stack" aria-label="Новые уведомления">{visible.filter(({ item }) => !organizationId || item.organization.id === organizationId).map(({ item, seconds }) => <div className={`notification-alert${seconds === 0 ? ' is-closing' : ''}`} role="status" key={item.id}>
    <NotificationItem item={item} floating compact showOrganization={!organizationId} now={Date.now()} busy={actions.read.isPending} onDismiss={() => close(item.id)} onNavigate={() => close(item.id)} onRead={(id, unread) => actions.read.mutate({ id, unread })} onInvite={(id, action) => actions.invitation.mutate({ id, action })} />
  </div>)}</aside>, document.body)
}
