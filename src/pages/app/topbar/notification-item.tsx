import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import NotificationIcon from './notification-icon.tsx'
import './notifications.scss'
import type { HistoryNotification } from '../../../app/organizations/types.ts'
import { invitationTimeRemaining } from '../../../app/organizations/invitation-time.ts'
import { formatNotificationTime, formatLegacyNotificationMessage, notificationTypeLabel, notificationStateLabel, notificationActionLabel, notificationAppearance } from '../../../app/organizations/notification-format.ts'

type Props = { item: HistoryNotification; now: number; compact?: boolean; floating?: boolean; onDismiss?: () => void; showOrganization?: boolean; removing?: boolean; busy: boolean; onRead: (id: string, unread?: boolean) => void; onInvite: (id: string, action: 'accept' | 'reject') => void; onDelete?: (id: string) => void; onNavigate?: () => void }
export default function NotificationItem({ item, now, compact = false, floating = false, onDismiss, showOrganization = true, removing, busy, onRead, onInvite, onDelete, onNavigate }: Props) {
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
  const appearance = notificationAppearance(item)
  const state = active && item.expiresAt ? invitationTimeRemaining(item.expiresAt, now) : expired ? 'Срок истёк' : notificationStateLabel(item)
  const message = item.source === 'invite' ? `Приглашает ${item.inviter}` : formatLegacyNotificationMessage(item.message)
  function interact() { if (!item.readAt) onRead(item.id); onNavigate?.() }
  return <article className={`notification-item${!item.readAt ? ' notification-item--unread' : ''}${compact ? ' notification-item--compact' : ''}${floating ? ' notification-item--floating' : ''}${removing ? ' is-removing' : ''}`}>
    <span className={`notification-symbol notification-symbol--${appearance.tone}`}><NotificationIcon icon={appearance.icon} /></span>
    <div className="notification-item__body">
      <div className="notification-item__top">{!item.readAt && <span className="notification-unread-dot" aria-label="Не прочитано" />}<time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString('ru-RU')}>{formatNotificationTime(item.createdAt, now)}</time>{floating ? <button type="button" className="notification-dismiss" aria-label="Закрыть уведомление" onClick={onDismiss}>×</button> : <div ref={menuHost} className="notification-context-menu" onMouseLeave={() => setMenu(false)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false) }} onKeyDown={event => { if (event.key === 'Escape' && menu) { event.stopPropagation(); setMenu(false); event.currentTarget.querySelector('button')?.focus() } }}><button type="button" disabled={busy} aria-label="Действия с уведомлением" aria-expanded={menu} onClick={() => setMenu(!menu)}>···</button>{menu && <div className="notification-context-menu__options"><button disabled={busy} onClick={() => { setMenu(false); onRead(item.id, Boolean(item.readAt)) }}>{item.readAt ? 'Отметить непрочитанным' : 'Отметить прочитанным'}</button>{onDelete && !item.actionable && <button disabled={busy} onClick={() => { setMenu(false); onDelete(item.id) }}>Удалить</button>}</div>}</div>}</div>
      {item.href ? <Link className="notification-item__link" to={item.href} onClick={interact}><strong>{item.title}</strong></Link> : <button className="notification-item__link notification-item__content-button" disabled={busy} onClick={() => { if (!item.readAt) onRead(item.id) }}><strong>{item.title}</strong></button>}
      <p>{message}</p>
      <div className="notification-item__source"><span>{[showOrganization ? item.organization.name : '', item.locationName || (!showOrganization ? notificationTypeLabel(item.type) : '')].filter(Boolean).join(' · ')}</span></div>
      {state && !floating && <span className={`notification-status notification-status--${appearance.tone}`}>{state}</span>}
      {active && !floating && <div className="notification-item__actions"><button type="button" className="app-primary app-primary--small" disabled={busy} onClick={() => onInvite(item.id, 'accept')}>Принять</button><button type="button" className="app-secondary" disabled={busy} onClick={() => onInvite(item.id, 'reject')}>Отклонить</button></div>}
      {item.href && (floating || (!compact && item.shiftOfferId)) && <div className="notification-item__actions"><Link className="notification-item__cta" to={item.href} onClick={interact}>{notificationActionLabel(item)}<span aria-hidden="true">→</span></Link></div>}
    </div>
  </article>
}
