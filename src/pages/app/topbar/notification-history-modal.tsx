import Select from '../../../component/ui/select/select.tsx'
import { useEffect, useRef, useState } from 'react'
import { useNotificationActions, useNotificationHistory, useOrganizations } from '../../../app/organizations/queries.ts'
import { useInvitationClock } from '../../../app/organizations/invitation-time.ts'
import AnimatedOverlay from '../schedule/animated-overlay.tsx'
import NotificationItem from './notification-item.tsx'

export default function NotificationHistoryModal({ organizationId, onClose }: { organizationId?: string; onClose: () => void }) {
  const [unread, setUnread] = useState(false)
  const [category, setCategory] = useState('')
  const [organizationFilter, setOrganizationFilter] = useState('')
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const history = useNotificationHistory({ organizationId: organizationId ?? (organizationFilter || undefined), category: category || undefined, unread, cursor: cursors.at(-1) })
  const organizations = useOrganizations()
  const actions = useNotificationActions(organizationId ?? (organizationFilter || undefined))
  const now = useInvitationClock()
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [])
  return <AnimatedOverlay variant="modal" className="notification-history-backdrop" onClose={onClose}>{close => <section ref={dialog} className="notification-history-modal" role="dialog" aria-modal="true" aria-labelledby="notification-history-title" onKeyDown={event => {
    if (event.key !== 'Tab') return
    const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], select, summary, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length)
    const first = elements[0], last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <header><h2 id="notification-history-title">Уведомления</h2>{!!history.data?.unreadCount && <button className="notification-read-all" disabled={actions.readAll.isPending} onClick={() => actions.readAll.mutate()}>Прочитать все</button>}<button type="button" aria-label="Закрыть уведомления" onClick={close}>×</button></header>
    <div className="notifications-filter"><button aria-pressed={!unread} onClick={() => { setUnread(false); setCursors([undefined]) }}>Все</button><button aria-pressed={unread} onClick={() => { setUnread(true); setCursors([undefined]) }}>Непрочитанные</button><label>Категория <Select aria-label="Категория" value={category} onChange={event => { setCategory(event.target.value); setCursors([undefined]) }}><option value="">Все категории</option><option value="SHIFT">Расписание</option><option value="REQUEST">Заявки</option><option value="ABSENCE">Отсутствия</option><option value="ROLE">Доступ</option><option value="ORGANIZATION">Приглашения</option></Select></label>{!organizationId && <label>Организация <Select aria-label="Организация" value={organizationFilter} onChange={event => { setOrganizationFilter(event.target.value); setCursors([undefined]) }}><option value="">Все организации</option>{organizations.data?.organizations.map(org => <option value={org.id} key={org.id}>{org.name}</option>)}</Select></label>}</div>
    {actions.error && <p role="alert" className="app-alert app-alert--error">Не удалось обработать уведомление.</p>}
    <div className="notification-history-modal__list">{history.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем уведомления…</div> : history.isError ? <div className="app-state">Не удалось загрузить уведомления<button onClick={() => void history.refetch()}>Повторить</button></div> : history.data?.notifications.length ? history.data.notifications.map(item => <NotificationItem key={item.id} item={item} removing={actions.removingId === item.id} showOrganization={!organizationId} now={now} busy={actions.read.isPending || actions.invitation.isPending || actions.remove.isPending || actions.readAll.isPending} onDelete={id => actions.remove.mutate(id)} onRead={(id, value) => actions.read.mutate({ id, unread: value })} onInvite={(id, action) => actions.invitation.mutate({ id, action })} onNavigate={onClose} />) : <div className="app-state">{unread || category || organizationFilter ? 'По выбранным фильтрам уведомлений нет' : 'Уведомлений пока нет'}</div>}</div>
    <nav className="members-pagination"><button disabled={cursors.length === 1 || history.isFetching} onClick={() => setCursors(current => current.slice(0, -1))}>Назад</button><span>Страница {cursors.length}</span><button disabled={!history.data?.nextCursor || history.isFetching} onClick={() => { if (history.data?.nextCursor) setCursors(current => [...current, history.data!.nextCursor!]); dialog.current?.querySelector('.notification-history-modal__list')?.scrollTo(0, 0) }}>Далее</button></nav>
  </section>}</AnimatedOverlay>
}
