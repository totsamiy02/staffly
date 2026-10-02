import Avatar from '../../../component/ui/avatar/avatar.tsx'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useAccountNotifications } from '../../../app/organizations/queries.ts'
import type { AccountNotification } from '../../../app/organizations/types.ts'

const dismissed = new Set<string>()

export default function RequestAlerts({ organizationId, suppressed }: { organizationId?: string; suppressed?: boolean }) {
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const notifications = useAccountNotifications(organizationId)
  const [visible, setVisible] = useState<Array<{ item: AccountNotification; seconds: number }>>([])
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible')

  useEffect(() => { setVisible([]) }, [user?.id])

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    const fresh = (notifications.data?.notifications ?? []).filter((item) => item.type === 'REQUEST_CREATED' && !dismissed.has(item.id))
    if (!fresh.length) return
    for (const item of fresh) dismissed.add(item.id)
    setVisible((current) => [...current, ...fresh.reverse().map((item) => ({ item, seconds: 15 }))].slice(-4))
  }, [notifications.data])

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
  return <aside className="request-alerts" aria-label="Новые заявки">{visible.filter(({ item }) => !organizationId || item.organization.id === organizationId).map(({ item, seconds }) => <div className={`request-alert${seconds === 0 ? ' is-closing' : ''}`}  role="status" key={item.id}>
    <div>{!organizationId && <div className="request-alert__organization"><Avatar url={item.organization.logoUrl} name={item.organization.name} className="notification-organization-avatar" /><small>{item.organization.name}</small></div>}<strong>{item.title}</strong><p>{item.message}</p></div>
    <div className="request-alert__actions"><button type="button" aria-label="Закрыть уведомление" onClick={() => close(item.id)}>×</button><Link to={item.href ?? `/app/organizations/${item.organization.id}/requests?tab=incoming&request=${item.requestId}`} onClick={() => open(item)}>Открыть</Link></div>
  </div>)}</aside>
}
