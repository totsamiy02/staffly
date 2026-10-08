import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import NotificationHistoryModal from './notification-history-modal.tsx'
import { useNotificationActions, useNotificationHistory } from '../../../app/organizations/queries.ts'
import { useInvitationClock } from '../../../app/organizations/invitation-time.ts'
import NotificationItem from './notification-item.tsx'
import NotificationIcon from './notification-icon.tsx'

type InvitationCenterProps = { organizationId?: string; onHistoryChange: (open: boolean) => void; open: boolean; onToggle: () => void; onClose: () => void }
export default function InvitationCenter({ organizationId, onHistoryChange, open, onToggle, onClose }: InvitationCenterProps) {
  const [present, setPresent] = useState(open)
  const [pendingHistory, setPendingHistory] = useState(false)
  useEffect(() => {
    if (open) { setPresent(true); return }
    const timer = window.setTimeout(() => setPresent(false), 180)
    return () => window.clearTimeout(timer)
  }, [open])
  const [full, setFull] = useState(false)
  useEffect(() => { if (pendingHistory && !present) { setPendingHistory(false); setFull(true) } }, [pendingHistory, present])
  const trigger = useRef<HTMLButtonElement>(null)
  const history = useNotificationHistory({ limit: 5, unread: true, organizationId })
  const actions = useNotificationActions(organizationId)
  const now = useInvitationClock()
  const total = history.data?.unreadCount ?? 0
  const items = history.data?.notifications ?? []
  return <div className="topbar-popover-host">
    <button ref={trigger} className={`topbar-icon-button${open ? ' topbar-icon-button--active' : ''}`} type="button" aria-label={`Уведомления${total ? `, требуют внимания: ${total}` : ''}`} aria-expanded={open} onClick={() => { if (!open) void history.refetch(); onToggle() }}><NotificationIcon />{total > 0 && <span className="topbar-notification-badge">{total > 9 ? '9+' : total}</span>}</button>
    {present && <section className={`topbar-popover topbar-popover--notifications${!open ? ' is-closing' : ''}`} aria-label="Уведомления">
      <header><div className="notification-heading"><h2>Уведомления</h2>{total > 0 && <span className="notification-count">{total}</span>}</div>{total > 0 && <button type="button" className="notification-read-all" disabled={actions.readAll.isPending} onClick={() => actions.readAll.mutate()}>Прочитать все</button>}<button type="button" className="notification-close" aria-label="Закрыть уведомления" onClick={() => { onClose(); trigger.current?.focus() }}>×</button></header>
      {actions.error && <p className="topbar-popover__error" role="alert">{actions.error instanceof Error ? actions.error.message : 'Не удалось обработать уведомление.'}</p>}
      {history.isLoading ? <div className="topbar-popover__state"><span className="app-spinner" />Загружаем…</div> : history.isError ? <div className="topbar-popover__state">Не удалось получить уведомления.<button type="button" onClick={() => void history.refetch()}>Повторить</button></div> : !items.length ? <div className="topbar-popover__empty"><span><NotificationIcon /></span><strong>Всё просмотрено</strong><p>Новых уведомлений нет.</p></div> : <div className="topbar-invitations">{items.map(item => <NotificationItem key={item.id} item={item} removing={actions.removingId === item.id} showOrganization={!organizationId} compact now={now} busy={actions.read.isPending || actions.invitation.isPending || actions.remove.isPending || actions.readAll.isPending} onDelete={id => actions.remove.mutate(id)} onRead={(id, unread) => actions.read.mutate({ id, unread })} onInvite={(id, action) => actions.invitation.mutate({ id, action })} onNavigate={onClose} />)}</div>}
      <button className="notifications-history-link" onClick={() => { onClose(); setPendingHistory(true); onHistoryChange(true) }}>Все уведомления <span aria-hidden="true">→</span></button>
    </section>}
    {full && createPortal(<NotificationHistoryModal organizationId={organizationId} onClose={() => { setFull(false); onHistoryChange(false); trigger.current?.focus() }} />, document.body)}
  </div>
}
