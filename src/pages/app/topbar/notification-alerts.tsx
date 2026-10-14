import { useEffect } from 'react'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useFloatingMessages } from '../../../component/ui/toast/toast-context.ts'
import { useNotificationHistory, useNotificationActions } from '../../../app/organizations/queries.ts'
import { takeFreshNotifications } from '../../../app/organizations/floating-notifications.ts'
import NotificationItem from './notification-item.tsx'

const seenByUser = new Map<string, Set<string>>()
const pendingByUser = new Map<string, Map<string,string>>()
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
  const { enqueue, dismiss, remove } = useFloatingMessages()
  const userId=user?.id??''
  if(!pendingByUser.has(userId))pendingByUser.set(userId,new Map())
  const pending=pendingByUser.get(userId)!
  useEffect(() => {
    if (!user?.id || !notifications.data) return
    const seen = seenNotices(user.id)
    const fresh = takeFreshNotifications(notifications.data.notifications, seen)
    try { sessionStorage.setItem(`staffly:floating-notices:${user.id}`, JSON.stringify([...seen].slice(-200))) } catch { /* In-memory fallback. */ }
    if (suppressed) { for (const [id,org] of pending) if(!organizationId||org===organizationId){remove(`notice:${id}`);pending.delete(id)};return }
    for (const [id,org] of pending) if ((!organizationId||org===organizationId)&&!notifications.data.notifications.some(item => item.id === id)) { remove(`notice:${id}`); pending.delete(id) }
    for (const item of fresh) {
      if (organizationId && item.organization.id !== organizationId) continue
      pending.set(item.id,item.organization.id)
      const id = `notice:${item.id}`
      const close = () => { pending.delete(item.id); dismiss(id) }
      enqueue({ id, duration: 7000, className: 'notification-alert', content: <NotificationItem item={item} floating compact showOrganization={!organizationId} now={Date.now()} busy={actions.read.isPending} onDismiss={close} onNavigate={close} onRead={(id, unread) => actions.read.mutate({ id, unread })} onInvite={(id, action) => actions.invitation.mutate({ id, action })} /> })
    }
  }, [notifications.data, user?.id, organizationId, suppressed, enqueue, dismiss, remove, actions.read, actions.invitation, pending])
  return null
}
