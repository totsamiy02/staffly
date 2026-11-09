import { useSearchParams } from 'react-router-dom'
import { AdminLink as Link } from './admin-link.tsx'
import AdminTable from './admin-table.tsx'
import { useAdminData } from './admin-data.tsx'
import { Loading, ReadError } from './admin-feedback.tsx'
import { AttentionPanel } from './admin-workspace.tsx'
import { AdminBadge, AdminHelp, AdminIcon, Empty, LineChart, OrganizationName, PageHead, Panel, Range, count, date } from './admin-elements.tsx'
import { word } from './admin-format.ts'
import { plans } from '../../app/subscriptions/plans.ts'
import { eventModules, outcomeLabels } from './event-labels.ts'
import type { OverviewMonitor } from './contracts.ts'
import type { AdminEventResult } from './event-feed.tsx'
import './overview.scss'

function RecentEvents() {
  const { data, error, refresh, readState } = useAdminData<AdminEventResult>('/monitoring/events?page=1')
  return <Panel title="Последние события" subtitle="Действия и изменения в сервисе" className="admin-overview-events" action={<Link className="admin-text-link" to="/admin/events">Все события</Link>}>
    <ReadError error={error} retry={refresh} state={readState}/>
    {!data ? !error && <p className="admin-overview-loading" role="status">Загружаем события…</p> : data.items.length ? <ol className="admin-overview-timeline">
      {data.items.slice(0, 4).map(event => <li key={event.id} className={event.outcome === 'FAILED' ? 'is-failed' : undefined}>
        <span className={`admin-overview-event-dot ${event.outcome === 'SUCCEEDED' ? '' : 'is-warning'}`} aria-hidden="true"/>
        <div><Link className="admin-overview-event-title" to={'/admin/events?eventSearch=' + encodeURIComponent(event.id)}>{event.label}</Link>
          <p>{event.userId ? <Link to={'/admin/users/' + event.userId}>{event.actor}</Link> : event.actor}<span aria-hidden="true"> · </span>{eventModules[event.module] ?? 'Безопасность'}</p>
          <time dateTime={event.createdAt}>{date(event.createdAt, true)} · МСК</time>
        </div>
        <AdminBadge tone={event.outcome === 'SUCCEEDED' ? 'green' : 'amber'}>{outcomeLabels[event.outcome] ?? event.outcome}</AdminBadge>
      </li>)}
    </ol> : <Empty>События ещё не зафиксированы. Здесь появятся действия и изменения в сервисе.</Empty>}
  </Panel>
}

export default function OverviewPage() {
  const [params, setParams] = useSearchParams()
  const days = Number(params.get('days') || 1)
  const { data, error, refresh, readState } = useAdminData<OverviewMonitor>(`/monitoring/overview?days=${days}`)
  if (!data) return <div className="admin-overview"><PageHead title="Обзор сервиса"/><Loading error={error} retry={refresh}/></div>

  const stats = [
    { label: 'Организации', value: data.totals.organizations, note: `+${count(data.totals.new_organizations)} за 30 дней`, icon: 'org' },
    { label: 'Пользователи', value: data.totals.users, note: `+${count(data.totals.new_users)} за 30 дней`, icon: 'users' },
    { label: 'Пользователи онлайн', value: data.online.users, note: `в ${count(data.online.organizations)} ${word(data.online.organizations, 'организации', 'организациях', 'организациях')}`, icon: 'pulse' },
    { label: 'Активные организации за 30 дней', value: data.totals.active_month, note: 'По активности участников', icon: 'chart' },
  ]
  return <div className="admin-overview">
    <PageHead title="Обзор сервиса" subtitle="Ключевые показатели, активность и контроль состояния платформы" actions={<Link className="admin-btn" to="/admin/events"><AdminIcon name="layers"/>Открыть журнал</Link>}/>
    <ReadError error={error} retry={refresh} state={readState}/>
    <div className="admin-overview-stats">
      {stats.map(stat => <article className="admin-overview-stat" key={stat.label}>
        <span className="admin-overview-stat-icon"><AdminIcon name={stat.icon}/></span>
        <h2>{stat.label}</h2><strong>{count(stat.value)}</strong><p>{stat.note}</p>
      </article>)}
    </div>
    <div className="admin-overview-grid">
      <Panel title="Активность сервиса" subtitle="Пользователи и организации в выбранный период" className="admin-overview-activity" action={<Range days={days} onChange={value => { const next = new URLSearchParams(params); next.set('days', String(value)); setParams(next) }}/> }>
        <div className="admin-chart-totals"><div><strong>{count(data.online.users)}</strong><small>пользователей сейчас</small></div><div><strong>{count(data.online.organizations)}</strong><small>организации онлайн</small></div></div>
        <LineChart data={data.history} range={data.historyRange} observedSince={data.startedAt} historyStartedAt={data.startedAt}/>
      </Panel>
      <AttentionPanel/>
      <RecentEvents/>
      <Panel title="Организации онлайн" subtitle="Сейчас в рабочих пространствах" className="admin-overview-online" action={<AdminBadge tone={data.online.organizations ? 'green' : 'gray'}>{count(data.online.organizations)} онлайн</AdminBadge>}>
        {data.onlineOrganizations.length ? <div className="admin-simple-list">{data.onlineOrganizations.map(org => <div key={org.id}><OrganizationName organization={org}/><span><strong>{count(org.online)}</strong><small>онлайн</small></span></div>)}</div> : <div className="admin-overview-empty"><span className="admin-overview-empty-icon"><AdminIcon name="org"/></span><strong>Никого нет в сети</strong><p>Список обновится, когда участник откроет рабочее пространство.</p></div>}
        <div className="admin-panel-footer"><span>Всего онлайн: {count(data.online.organizations)}</span><Link to="/admin/online">Все организации <span aria-hidden="true">→</span></Link></div>
      </Panel>
      <Panel title="Новые организации" subtitle="Последние регистрации на платформе" className="admin-overview-new" action={<Link to="/admin/organizations" className="admin-text-link">Все организации</Link>}>
        <AdminTable primary={[0, 2, 1]}><table><thead><tr><th>Организация</th><th>Создана</th><th>Тариф</th><th>Участники</th></tr></thead><tbody>{data.newOrganizations.map(org => <tr key={org.id}><td><OrganizationName organization={org}/></td><td>{date(org.createdAt)}</td><td><AdminBadge>{plans[org.subscription.effectivePlan].name}</AdminBadge></td><td>{org.members}</td></tr>)}</tbody></table>{!data.newOrganizations.length && <Empty>Организации ещё не созданы.</Empty>}</AdminTable>
      </Panel>
      <Panel title="Сбор данных" className="admin-overview-collection">
        <dl className="admin-key-values"><div><dt>Начало наблюдений</dt><dd>{date(data.startedAt)}</dd></div><div><dt>Определение онлайна <AdminHelp label="Как считается онлайн">Один аккаунт учитывается один раз, независимо от количества устройств и вкладок.</AdminHelp></dt><dd>Активность за 90 секунд</dd></div><div><dt>Шаг истории онлайна</dt><dd>5 минут</dd></div><div><dt>Часовой пояс</dt><dd>Москва · UTC+3</dd></div></dl>
      </Panel>
    </div>
  </div>
}
