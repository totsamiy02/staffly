import Select from '../../../component/ui/select/select.tsx'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import { Fragment, useRef, useState } from 'react'
import { useNotificationActions, useNotificationHistory, useOrganizations } from '../../../app/organizations/queries.ts'
import { useInvitationClock } from '../../../app/organizations/invitation-time.ts'
import { notificationDayLabel } from '../../../app/organizations/notification-format.ts'
import AnimatedOverlay from '../schedule/animated-overlay.tsx'
import DocumentDialog from '../documents/document-dialog.tsx'
import NotificationItem from './notification-item.tsx'
import NotificationIcon from './notification-icon.tsx'

const categories = [['', 'Все типы'], ['SHIFT', 'Смены'], ['REQUEST', 'Заявки'], ['EVENT', 'События'], ['DOCUMENT', 'Документы'], ['ABSENCE', 'Отсутствия'], ['ROLE', 'Доступ'], ['ORGANIZATION', 'Приглашения']]

export default function NotificationHistoryModal({ organizationId, locationId, onClose }: { organizationId?: string; locationId?: string | null; onClose: () => void }) {
  const [unread, setUnread] = useState(false)
  const [category, setCategory] = useState('')
  const [organizationFilter, setOrganizationFilter] = useState('')
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const list = useRef<HTMLDivElement>(null)
  const history = useNotificationHistory({ organizationId: organizationId ?? (organizationFilter || undefined), locationId, category: category || undefined, unread, cursor: cursors.at(-1) })
  const organizations = useOrganizations()
  const actions = useNotificationActions(organizationId ?? (organizationFilter || undefined))
  const now = useInvitationClock()
  const count = history.data?.unreadCount ?? 0
  const items = history.data?.notifications ?? []
  function reset() { setCursors([undefined]); list.current?.scrollTo(0, 0) }
  const busy = actions.read.isPending || actions.invitation.isPending || actions.remove.isPending || actions.readAll.isPending
  return <AnimatedOverlay variant="drawer" className="notification-history-backdrop" onClose={onClose}>{close => <DocumentDialog drawer title="Уведомления" onClose={close} className="notification-panel" headerContent={<header className="notification-panel__header">
    <div className="notification-heading"><h2>Уведомления</h2>{count > 0 && <span className="notification-count">{count}</span>}<button className="notification-close" type="button" aria-label="Закрыть уведомления" onClick={close}>×</button></div>
    <div className="notification-panel__intro"><p>Все важное по вашим сменам и команде</p>{count > 0 && <button className="notification-read-all" disabled={busy} onClick={() => actions.readAll.mutate()}>Прочитать все</button>}</div>
  </header>}>
    <div className="notification-panel__filters">
      <SegmentedNav label="Статус уведомлений" variant="underline"><button aria-pressed={!unread} onClick={() => { setUnread(false); reset() }}>Все</button><button aria-pressed={unread} onClick={() => { setUnread(true); reset() }}>Непрочитанные {count > 0 && <span className="notification-count notification-count--soft">{count}</span>}</button></SegmentedNav>
      <div className="notification-categories" aria-label="Тип уведомлений"><Select aria-label="Все типы уведомлений" value={category} onChange={event => { setCategory(event.target.value); reset() }}>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>{categories.slice(1, 4).map(([value, label]) => <button key={value} aria-pressed={category === value} onClick={() => { setCategory(category === value ? '' : value); reset() }}>{label}</button>)}</div>
      {!organizationId && <label className="notification-organization-filter"><span>Организация</span><Select aria-label="Организация" value={organizationFilter} onChange={event => { setOrganizationFilter(event.target.value); reset() }}><option value="">Все организации</option>{organizations.data?.organizations.map(org => <option value={org.id} key={org.id}>{org.name}</option>)}</Select></label>}
    </div>
    {actions.error && <p role="alert" className="topbar-popover__error">Не удалось обработать уведомление. Попробуйте ещё раз.</p>}
    <div className="notification-panel__list" ref={list}>{history.isLoading ? <div className="notification-state"><span className="app-spinner" />Загружаем уведомления…</div> : history.isError ? <div className="notification-state"><NotificationIcon /><strong>Не удалось загрузить уведомления</strong><button onClick={() => void history.refetch()}>Повторить</button></div> : items.length ? items.map((item, index) => {
      const day = notificationDayLabel(item.createdAt, now)
      return <Fragment key={item.id}>{(!index || day !== notificationDayLabel(items[index - 1].createdAt, now)) && <h3 className="notification-day">{day}</h3>}<NotificationItem item={item} removing={actions.removingId === item.id} showOrganization={!organizationId} now={now} busy={busy} onDelete={id => actions.remove.mutate(id)} onRead={(id, value) => actions.read.mutate({ id, unread: value })} onInvite={(id, action) => actions.invitation.mutate({ id, action })} onNavigate={onClose} /></Fragment>
    }) : <div className="notification-state"><span className="notification-state__symbol"><NotificationIcon /></span><strong>{unread || category || organizationFilter ? 'Здесь пока ничего нет' : 'Уведомлений пока нет'}</strong><p>{unread || category || organizationFilter ? 'Попробуйте выбрать другие фильтры.' : 'Новые сообщения о сменах и команде появятся здесь.'}</p>{(unread || category || organizationFilter) && <button onClick={() => { setUnread(false); setCategory(''); setOrganizationFilter(''); reset() }}>Сбросить фильтры</button>}</div>}</div>
    <footer className="notification-panel__footer">{cursors.length > 1 || history.data?.nextCursor ? <nav aria-label="Страницы уведомлений"><button disabled={cursors.length === 1 || history.isFetching} onClick={() => { setCursors(current => current.slice(0, -1)); list.current?.scrollTo(0, 0) }}>← Назад</button><span>Страница {cursors.length}</span><button disabled={!history.data?.nextCursor || history.isFetching} onClick={() => { if (history.data?.nextCursor) setCursors(current => [...current, history.data!.nextCursor!]); list.current?.scrollTo(0, 0) }}>Далее →</button></nav> : <span>{items.length ? 'Показаны последние уведомления' : 'Уведомления вашей команды'}</span>}</footer>
  </DocumentDialog>}</AnimatedOverlay>
}
