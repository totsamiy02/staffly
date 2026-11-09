import { useSearchParams } from 'react-router-dom'
import ConsoleLayout from '../console-layout.tsx'
import AdminTable from '../admin-table.tsx'
import AdminDisclosure from '../admin-disclosure.tsx'
import { AdminLink as Link } from '../admin-link.tsx'
import { useAdminData } from '../admin-data.tsx'
import { Loading, ReadError } from '../admin-feedback.tsx'
import { AdminHelp, AdminBadge, AdminIcon, Empty, LineChart, PageHead, Panel, Stat, bytes, count, date } from '../admin-elements.tsx'
import { KeyValues } from './elements.tsx'
import { duration, nodeLabels, word } from './presentation.ts'
import type { RuntimeNode, ServiceState } from './contracts.ts'

function RuntimeCard({node}:{node:RuntimeNode}){
  const s=node.snapshot
  return <AdminDisclosure className="admin-ops-node" label={<><span className={`admin-ops-dot is-${node.state}`}/><span><strong>{node.role==='api'?'API сервиса':'Фоновый процесс'} <small>· {node.id.slice(0,8)}</small></strong><small>{node.stoppedAt?'Завершён '+date(node.stoppedAt,true):'Сигнал '+date(node.heartbeatAt,true)}</small></span><AdminBadge tone={node.state==='healthy'?'green':node.state==='warning'||node.state==='offline'?'amber':'gray'}>{nodeLabels[node.state]}</AdminBadge></>}><div className="admin-ops-node-body">{s?<><KeyValues items={[["Время работы",duration(s.uptime)],['Память процесса',bytes(s.rss)],['Ожидают БД',s.pool.waiting],['Соединения с БД',`${s.pool.total-s.pool.idle} занято · ${s.pool.idle} свободно`],...(s.http?[["Запросов с запуска",count(s.http.requests)],['Средний ответ',`${count(s.http.meanMs)} мс`],['Ответы 5xx',count(s.http.errors)]] as Array<[string,string]>:[])]}/><div className="admin-ops-task-list">{s.tasks.map(task=><div key={task.name}><span className={`admin-ops-task-icon ${task.failures?'is-warning':''}`}><AdminIcon name={task.failures?'bell':task.running?'pulse':'check'}/></span><div><strong>{task.label}</strong><small>{task.running?'Выполняется · '+duration(task.durationMs/1000):task.lastSuccessAt?'Последний успех '+date(task.lastSuccessAt,true):'Ожидаем первый результат'}</small>{task.error&&<code>{task.error.code??task.error.name}</code>}</div><span>{task.failures?`${count(task.failures)} ${word(task.failures,'ошибка','ошибки','ошибок')} подряд`:task.running?'В работе':`${count(task.runs)} ${word(task.runs,'цикл','цикла','циклов')}`}</span></div>)}</div>{!s.tasks.length&&<p className="admin-note">{s.config.backgroundWorkers?'Пока нет результатов фоновых циклов.':'Фоновые задачи — в отдельном процессе.'}</p>}{s.droppedErrors>0&&<p className="admin-notice">При перегрузке буфера {count(s.droppedErrors)} записей не попали в диагностику. Полный журнал процесса доступен на сервере.</p>}</>:<Empty>Снимок процесса пока недоступен.</Empty>}</div></AdminDisclosure>
}

function ServiceConnections({ data }: { data: ServiceState }) {
  return <div className="admin-ops-connections admin-console-connections">{data.connections.map(connection => <div key={connection.key}>
    <span className="admin-console-component-icon"><AdminIcon name={connection.key.includes('database') ? 'database' : connection.key.includes('mail') ? 'mail' : connection.key.includes('storage') ? 'disk' : 'server'}/></span>
    <div>{connection.href ? <Link to={connection.href}><strong>{connection.title}</strong></Link> : <strong>{connection.title}</strong>}<p>{connection.note}</p>{connection.at && <small>Последняя доставка: {date(connection.at, true)} · МСК</small>}</div>
    <AdminBadge tone={connection.state === 'working' ? 'green' : connection.state === 'attention' ? 'amber' : 'gray'}>{connection.label}</AdminBadge>
  </div>)}</div>
}

export default function ServiceStatusPage() {
  const [params] = useSearchParams(), details = params.get('view') === 'checks'
  const { data, error, refresh, readState, busy } = useAdminData<ServiceState>('/operations/service')
  if (!data) return <ConsoleLayout><PageHead title={details ? 'Детальные проверки' : 'Состояние сервиса'}/><Loading error={error} retry={refresh}/></ConsoleLayout>
  const live = data.nodes.filter(node => node.state !== 'offline' && node.state !== 'stopped' && node.snapshot)
  const rss = live.reduce((total, node) => total + (node.snapshot?.rss ?? 0), 0)
  return <ConsoleLayout className={details ? 'admin-console--checks' : 'admin-console--status'} section="Операции / Состояние сервиса">
    {details && <div className="admin-breadcrumb"><Link className="admin-back" to="/admin/operations/service">← К состоянию сервиса</Link></div>}
    <PageHead title={details ? 'Детальные проверки' : 'Состояние сервиса'} subtitle={details ? 'Подробные результаты компонентов и текущий снимок процессов' : 'Доступность компонентов, нагрузка и работа фоновых процессов'} actions={details ? <button type="button" className="admin-btn" disabled={busy} onClick={refresh}><AdminIcon name="refresh"/>{busy ? 'Проверяем…' : 'Повторить проверку'}</button> : <Link className="admin-btn" to="/admin/operations/maintenance">Обслуживание сервиса</Link>}/>
    <ReadError error={error} retry={refresh} state={readState}/>
    {!details && <>
      <section className={`admin-ops-banner is-${data.state}`}>
        <div><AdminIcon name={data.state === 'healthy' ? 'check' : data.state === 'warning' ? 'bell' : 'clock'}/></div>
        <section><AdminBadge tone={data.state === 'healthy' ? 'green' : data.state === 'warning' ? 'amber' : 'gray'}>{data.state === 'healthy' ? 'Проверки пройдены' : data.state === 'warning' ? 'Требует внимания' : 'Ожидаем наблюдения'}</AdminBadge>
          <h2>{data.state === 'healthy' ? 'Проверки без текущих сигналов' : data.state === 'warning' ? 'Есть сигналы для проверки' : 'Ожидаем данные процессов'}</h2>
          <p>Доступность и состояние по последним сигналам от компонентов сервиса.</p>
          <AdminHelp label="Как читать состояние сервиса">«Настроено» — параметры есть; «работает» — результат подтверждён. Сигнал процесса старше 45 секунд требует проверки. Доступность файлового провайдера отдельно не проверяется. Целостность копии БД не подтверждает пробное восстановление или сохранность файлов.</AdminHelp>
        </section><time dateTime={data.at}>Снимок {date(data.at, true)} · МСК</time>
      </section>
      <div className="admin-stats"><Stat decorate label="API на связи" value={data.totals.apis} icon="server"/><Stat decorate label="Фоновые процессы" value={data.totals.workers} note="включая обработчики внутри API" icon="layers"/><Stat decorate label="Ответ базы данных" value={count(data.databaseMs)} suffix="мс" icon="database"/><Stat decorate label="Память процессов" value={bytes(rss)} icon="disk"/></div>
    </>}
    <div className="admin-console-split">
      <Panel title="Сервисы и подключения" subtitle="Фактические результаты и конфигурация компонентов" action={!details && <Link className="admin-text-link" to="/admin/operations/service?view=checks">Детальные проверки →</Link>}><ServiceConnections data={data}/></Panel>
      <Panel title="Сбои API за 24 часа" subtitle="По сохранённым замерам сервиса" action={<AdminBadge tone={data.totals.errors ? 'amber' : 'green'}>{count(data.totals.errors)} {word(data.totals.errors, 'сбой', 'сбоя', 'сбоев')}</AdminBadge>}>
        {data.history.length ? <LineChart data={data.history} range={data.historyRange} series={[{ key: 'errors', label: 'Сбои API' }]}/> : <Empty>За этот период зарегистрированных сбоев API нет.</Empty>}
      </Panel>
    </div>
    {details && <Panel title="Результаты текущей проверки" subtitle={`Снимок ${date(data.at, true)} · МСК`}><AdminTable primary={[0, 1]}><table><thead><tr><th>Компонент</th><th>Результат</th><th>Подробности</th></tr></thead><tbody>{data.connections.map(connection => <tr key={connection.key}><td>{connection.title}</td><td><AdminBadge tone={connection.state === 'working' ? 'green' : connection.state === 'attention' ? 'amber' : 'gray'}>{connection.label}</AdminBadge></td><td>{connection.note}</td></tr>)}</tbody></table></AdminTable></Panel>}
    <Panel title="Работа приложения" subtitle="Процессы, подключения к базе и фоновые циклы"><div className="admin-ops-nodes">{data.nodes.map(node => <RuntimeCard key={node.id} node={node}/>)}{!data.nodes.length && <Empty>Данные появятся после первого сигнала от API или фонового процесса.</Empty>}</div></Panel>
    <Panel title="Доставка и выгрузки"><KeyValues items={[["Писем с ошибкой за 24 часа", count(data.totals.email_failed)], ['Неудавшихся действующих выгрузок', count(data.totals.report_failed)]]}/></Panel>
  </ConsoleLayout>
}
