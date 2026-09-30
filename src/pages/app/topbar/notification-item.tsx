import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import type { HistoryNotification } from '../../../app/organizations/types.ts'
import { invitationTimeRemaining } from '../../../app/organizations/invitation-time.ts'
import { formatNotificationTime, formatLegacyNotificationMessage } from '../../../app/organizations/notification-format.ts'

const typeLabels: Record<string, string> = { DOCUMENT_ASSIGNED: 'Документ', ABSENCE_REPORTED: 'Отсутствие', ABSENCE_CHANGED: 'Отсутствие', ABSENCE_CANCELLED: 'Отсутствие', ORGANIZATION_INVITATION: 'Приглашение', SHIFT_ASSIGNED: 'Расписание', SHIFT_CHANGED: 'Расписание', SHIFT_CANCELLED: 'Расписание', ROLE_CHANGED: 'Доступ', REQUEST_CREATED: 'Заявка', REQUEST_APPROVED: 'Заявка', REQUEST_REJECTED: 'Заявка', REQUEST_CANCELLED: 'Заявка' }
const stateLabels: Record<string, string> = { REQUIRED: 'Требует ознакомления', ACKNOWLEDGED: 'Ознакомлен', ACCEPTED: 'Принято', REJECTED: 'Отклонено', REVOKED: 'Отозвано', EXPIRED: 'Срок истёк', APPROVED: 'Одобрено', CANCELLED: 'Отменено', PENDING: 'На рассмотрении' }
type Props = { item: HistoryNotification; now: number; compact?: boolean; showOrganization?: boolean; removing?: boolean; busy: boolean; onRead: (id: string, unread?: boolean) => void; onInvite: (id: string, action: 'accept' | 'reject') => void; onDelete?: (id: string) => void; onNavigate?: () => void }
export default function NotificationItem({ item, now, compact = false, showOrganization = true, removing, busy, onRead, onInvite, onDelete, onNavigate }: Props) {
  const [menu, setMenu] = useState(false)
  const menuHost = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => { if (!menuHost.current?.contains(event.target as Node)) setMenu(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menu])
  const active = item.source === 'invite' && item.state === 'ACTIVE' && Boolean(item.expiresAt && new Date(item.expiresAt).getTime() > now)
  const expired = item.source === 'invite' && item.state === 'ACTIVE' && !active
  const details = <><strong>{item.title}</strong><p>{item.source === 'invite' ? `Приглашает ${item.inviter}` : formatLegacyNotificationMessage(item.message)}</p></>
  function interact() { if (!item.readAt) onRead(item.id); onNavigate?.() }
  return <article className={`notification-item${!item.readAt ? ' notification-item--unread' : ''}${compact ? ' notification-item--compact' : ''}${removing ? ' is-removing' : ''}`}>
    {showOrganization && <Avatar url={item.organization.logoUrl} name={item.organization.name} className="notification-organization-avatar" />}
    <div className="notification-item__body">
      <div className="notification-item__top">{!item.readAt && <span className="notification-unread-dot" aria-label="Не прочитано" />}<time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString('ru-RU')}>{formatNotificationTime(item.createdAt, now)}</time><div ref={menuHost} className="notification-context-menu" onMouseLeave={() => setMenu(false)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false) }} onKeyDown={event => { if (event.key === 'Escape' && menu) { event.stopPropagation(); setMenu(false); event.currentTarget.querySelector('button')?.focus() } }}><button type="button" disabled={busy} aria-label="Действия с уведомлением" aria-expanded={menu} onClick={() => setMenu(!menu)}>···</button>{menu && <div className="notification-context-menu__options"><button disabled={busy} onClick={() => { setMenu(false); onRead(item.id, Boolean(item.readAt)) }}>{item.readAt ? 'Отметить непрочитанным' : 'Отметить прочитанным'}</button>{onDelete && !item.actionable && <button disabled={busy} onClick={() => { setMenu(false); onDelete(item.id) }}>Удалить</button>}</div>}</div></div>
      {item.href ? <Link className="notification-item__link" to={item.href} onClick={interact}>{details}</Link> : <button className="notification-item__link notification-item__content-button" disabled={busy} onClick={() => { if (!item.readAt) onRead(item.id) }}>{details}</button>}
      <div className="notification-item__source"><span>{typeLabels[item.type] ?? 'Уведомление'}{showOrganization ? ` · ${item.organization.name}` : ''}</span>{item.source === 'invite' && <span className="notification-status">{active && item.expiresAt ? invitationTimeRemaining(item.expiresAt, now) : expired ? 'Срок истёк' : stateLabels[item.state ?? '']}</span>}{item.source === 'event' && item.state && <span className="notification-status">{stateLabels[item.state] ?? item.state}</span>}</div>
      {active && <div className="notification-item__actions"><button type="button" className="app-primary app-primary--small" disabled={busy} onClick={() => onInvite(item.id, 'accept')}>Принять</button><button type="button" className="app-secondary" disabled={busy} onClick={() => onInvite(item.id, 'reject')}>Отклонить</button></div>}
    </div>
  </article>
}
