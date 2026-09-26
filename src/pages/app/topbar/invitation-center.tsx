import { Link } from 'react-router-dom'
import { useNotificationActions, useNotificationHistory } from '../../../app/organizations/queries.ts'
import { useInvitationClock } from '../../../app/organizations/invitation-time.ts'
import NotificationItem from './notification-item.tsx'

function EnvelopeIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4.5 7 7.5 5.5L19.5 7" /></svg>
}

type InvitationCenterProps = { open: boolean; onToggle: () => void; onClose: () => void }
export default function InvitationCenter({ open, onToggle, onClose }: InvitationCenterProps) {
  const history = useNotificationHistory({ limit: 6 })
  const actions = useNotificationActions()
  const now = useInvitationClock()
  const total = history.data?.unreadCount ?? 0
  const items = history.data?.notifications ?? []
  return <div className="topbar-popover-host">
    <button className={`topbar-icon-button${open ? ' topbar-icon-button--active' : ''}`} type="button" aria-label={`Уведомления${total ? `, непрочитанных: ${total}` : ''}`} aria-expanded={open} onClick={() => { if (!open) void history.refetch(); onToggle() }}><EnvelopeIcon />{total > 0 && <span className="topbar-notification-badge">{total > 9 ? '9+' : total}</span>}</button>
    {open && <section className="topbar-popover topbar-popover--notifications" aria-label="Уведомления">
      <header><div><p className="app-eyebrow">Последние события</p><h2>Уведомления</h2></div><button type="button" aria-label="Закрыть уведомления" onClick={onClose}>×</button></header>
      {actions.error && <p className="topbar-popover__error" role="alert">{actions.error instanceof Error ? actions.error.message : 'Не удалось обработать уведомление.'}</p>}
      {history.isLoading ? <div className="topbar-popover__state"><span className="app-spinner" />Загружаем…</div> : history.isError ? <div className="topbar-popover__state">Не удалось получить уведомления.<button type="button" onClick={() => void history.refetch()}>Повторить</button></div> : !items.length ? <div className="topbar-popover__empty"><span><EnvelopeIcon /></span><strong>Уведомлений пока нет</strong><p>Приглашения, заявки, роли и смены появятся здесь.</p></div> : <div className="topbar-invitations">{items.map(item => <NotificationItem key={item.id} item={item} compact now={now} busy={actions.read.isPending || actions.invitation.isPending} onRead={(id, unread) => actions.read.mutate({ id, unread })} onInvite={(id, action) => actions.invitation.mutate({ id, action })} onNavigate={onClose} />)}</div>}
      <Link className="notifications-history-link" to="/app/notifications" onClick={onClose}>Все уведомления <span aria-hidden="true">→</span></Link>
    </section>}
  </div>
}
