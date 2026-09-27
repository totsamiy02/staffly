import { useState } from 'react'
import { Link } from 'react-router-dom'
import AppTopbar from './app-topbar.tsx'
import NotificationItem from './topbar/notification-item.tsx'
import { useNotificationActions, useNotificationHistory } from '../../app/organizations/queries.ts'
import { useInvitationClock } from '../../app/organizations/invitation-time.ts'
import './app.scss'

export default function NotificationsPage() {
  const [unread, setUnread] = useState(false)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const history = useNotificationHistory({ limit: 20, cursor: cursors.at(-1), unread })
  const actions = useNotificationActions()
  const now = useInvitationClock()
  return <div className="app-page"><AppTopbar /><main className="notifications-page">
    <Link className="app-back" to="/app">К организациям</Link>
    <header><p className="app-eyebrow">История событий</p><h1>Уведомления</h1><p>Прочтение приглашения не меняет его статус. Принять или отклонить его можно отдельно.</p></header>
    <div className="notifications-filter" role="group" aria-label="Фильтр уведомлений">{[false, true].map(value => <button type="button" key={String(value)} aria-pressed={unread === value} onClick={() => { setUnread(value); setCursors([undefined]) }}>{value ? 'Непрочитанные' : 'Все события'}</button>)}</div>
    {actions.error && <p className="app-alert app-alert--error" role="alert">{actions.error instanceof Error ? actions.error.message : 'Не удалось обработать уведомление.'}</p>}
    {history.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем уведомления…</div> : history.isError ? <div className="app-state">Не удалось загрузить историю.<button className="app-secondary" onClick={() => void history.refetch()}>Повторить</button></div> : <><section className="notifications-list" aria-label="События">{history.data?.notifications.length ? history.data.notifications.map(item => <NotificationItem key={item.id} item={item} now={now} busy={actions.read.isPending || actions.invitation.isPending} onRead={(id, value) => actions.read.mutate({ id, unread: value })} onInvite={(id, action) => actions.invitation.mutate({ id, action })} />) : <div className="app-state">{unread ? 'На этой странице нет непрочитанных уведомлений.' : 'На этой странице нет событий.'}</div>}</section>{(cursors.length > 1 || history.data?.nextCursor) && <nav className="members-pagination" aria-label="Страницы уведомлений"><button className="app-secondary" disabled={cursors.length <= 1 || history.isFetching} onClick={() => setCursors(current => current.slice(0, -1))}>Назад</button><span>Страница {cursors.length}</span><button className="app-secondary" disabled={!history.data?.nextCursor || history.isFetching} onClick={() => { const next = history.data?.nextCursor; if (next) { setCursors(current => [...current, next]); window.scrollTo({ top: 0, behavior: 'smooth' }) } }}>Далее</button></nav>}</>}
  </main></div>
}
