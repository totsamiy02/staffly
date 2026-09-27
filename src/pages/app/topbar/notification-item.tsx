import { Link } from 'react-router-dom'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import type { HistoryNotification } from '../../../app/organizations/types.ts'
import { invitationTimeRemaining } from '../../../app/organizations/invitation-time.ts'

const typeLabels: Record<string, string> = { ABSENCE_REPORTED: 'Отсутствие', ABSENCE_CHANGED: 'Отсутствие', ABSENCE_CANCELLED: 'Отсутствие', ORGANIZATION_INVITATION: 'Приглашение', SHIFT_ASSIGNED: 'Расписание', SHIFT_CHANGED: 'Расписание', SHIFT_CANCELLED: 'Расписание', ROLE_CHANGED: 'Доступ', REQUEST_CREATED: 'Заявка', REQUEST_APPROVED: 'Заявка', REQUEST_REJECTED: 'Заявка', REQUEST_CANCELLED: 'Заявка' }
const stateLabels: Record<string, string> = { ACCEPTED: 'Принято', REJECTED: 'Отклонено', REVOKED: 'Отозвано', EXPIRED: 'Срок истёк', APPROVED: 'Одобрено', CANCELLED: 'Отменено', PENDING: 'На рассмотрении' }

type Props = { item: HistoryNotification; now: number; compact?: boolean; busy: boolean; onRead: (id: string, unread?: boolean) => void; onInvite: (id: string, action: 'accept' | 'reject') => void; onNavigate?: () => void }
export default function NotificationItem({ item, now, compact = false, busy, onRead, onInvite, onNavigate }: Props) {
  const active = item.source === 'invite' && item.state === 'ACTIVE' && Boolean(item.expiresAt && new Date(item.expiresAt).getTime() > now)
  const expired = item.source === 'invite' && item.state === 'ACTIVE' && !active
  const details = <><strong>{item.title}</strong><p>{item.source === 'invite' ? `Приглашает ${item.inviter}` : item.message}</p></>
  return <article className={`notification-item${!item.readAt ? ' notification-item--unread' : ''}${compact ? ' notification-item--compact' : ''}`}>
    <Avatar url={item.organization.logoUrl} name={item.organization.name} className="topbar-invitation__avatar" />
    <div className="notification-item__body">
      <div className="notification-item__source"><span>{typeLabels[item.type] ?? 'Уведомление'} · {item.organization.name}</span>{!item.readAt && <i aria-label="Не прочитано" />}</div>
      {item.href ? <Link className="notification-item__link" to={item.href} onClick={() => { if (!item.readAt) onRead(item.id); onNavigate?.() }}>{details}</Link> : <div>{details}</div>}
      <div className="notification-item__meta"><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</time>{item.source === 'invite' && <span title={item.expiresAt ? `До ${new Date(item.expiresAt).toLocaleString('ru-RU')}` : undefined}>{active && item.expiresAt ? invitationTimeRemaining(item.expiresAt, now) : expired ? 'Срок истёк' : stateLabels[item.state ?? '']}</span>}{item.source === 'event' && item.state && <span>{stateLabels[item.state] ?? item.state}</span>}</div>
      <div className="notification-item__actions">{active && <><button type="button" className="app-primary app-primary--small" disabled={busy} onClick={() => onInvite(item.id, 'accept')}>Принять</button><button type="button" className="app-secondary" disabled={busy} onClick={() => onInvite(item.id, 'reject')}>Отклонить</button></>}<button type="button" className="notification-read-button" disabled={busy} onClick={() => onRead(item.id, Boolean(item.readAt))}>{item.readAt ? 'Отметить непрочитанным' : 'Отметить прочитанным'}</button></div>
    </div>
  </article>
}
