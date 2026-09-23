import { useState } from 'react'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { formatDuration, formatTime, monthKeyInZone, moveMonth } from '../../../app/schedule/date-utils.ts'
import { useMemberWorkTime, useShiftDetails, useWorkTimeStatistics } from '../../../app/schedule/queries.ts'
import type { WorkTimeMember } from '../../../app/schedule/types.ts'
import ScheduleTabs from './schedule-tabs.tsx'
import WorkTimePanel from './work-time-panel.tsx'
import AnimatedOverlay from './animated-overlay.tsx'
import { useOrganizationMembers } from '../../../app/organizations/queries.ts'

const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const columns: Array<{ key: 'name' | 'workedMinutes' | 'workedShifts' | 'averageMinutes' | 'plannedMinutes' | 'plannedShifts'; label: string }> = [
  { key: 'name', label: 'Сотрудник' }, { key: 'workedMinutes', label: 'Отработано' }, { key: 'workedShifts', label: 'Смен' }, { key: 'averageMinutes', label: 'Средняя смена' }, { key: 'plannedMinutes', label: 'Запланировано' }, { key: 'plannedShifts', label: 'Будущих смен' },
]

export default function StatisticsPage({ organization }: { organization: OrganizationSummary }) {
  const initialMonth = monthKeyInZone(new Date(), organization.timezone)
  const [month, setMonth] = useState(initialMonth)
  const [allTime, setAllTime] = useState(false)
  const [memberState, setMemberState] = useState<'active' | 'all' | 'former'>('active')
  const [sort, setSort] = useState<typeof columns[number]['key']>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [selectedMember, setSelectedMember] = useState<string | null>(null)
  const [selectedShift, setSelectedShift] = useState<string | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [auditPage, setAuditPage] = useState(1)
  const from = allTime ? undefined : `${month}-01`
  const to = allTime ? undefined : `${moveMonth(month, 1)}-01`
  const params = { from, to, memberState, sort, direction }
  const statistics = useWorkTimeStatistics(organization.id, params, organization.role !== 'MEMBER')
  const organizationMembers = useOrganizationMembers(organization.id)
  const detail = useMemberWorkTime(organization.id, selectedMember, { ...params, page: historyPage })
  const shiftDetail = useShiftDetails(organization.id, selectedShift, auditPage)
  const [year, monthNumber] = month.split('-').map(Number)
  const years = Array.from({ length: 8 }, (_, index) => new Date().getFullYear() - 4 + index)

  function changeSort(key: typeof sort) {
    if (sort === key) setDirection((value) => value === 'asc' ? 'desc' : 'asc')
    else { setSort(key); setDirection(key === 'name' ? 'asc' : 'desc') }
  }

  if (organization.role === 'MEMBER') return <div className="schedule-state">Общая статистика доступна владельцу и администраторам.</div>
  return <section className="schedule-page"><header className="schedule-heading"><div><p className="app-eyebrow">Аналитика команды</p><h1>Статистика рабочего времени</h1><p>Завершённые смены считаются автоматически, будущие показаны отдельно.</p></div></header><ScheduleTabs organization={organization} />
    <div className="statistics-member-picker"><label htmlFor="statistics-member">Чьи часы показать</label><select id="statistics-member" value={selectedMember ?? ''} onChange={(event) => { setSelectedMember(event.target.value || null); setHistoryPage(1) }}><option value="">Общая статистика всех сотрудников</option>{organizationMembers.data?.members.map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select><small>Выберите сотрудника, чтобы открыть его часы, смены и личную историю.</small></div>
    <div className="statistics-filters"><div className="statistics-period"><button className={allTime ? '' : 'active'} onClick={() => setAllTime(false)}>Месяц</button><button className={allTime ? 'active' : ''} onClick={() => setAllTime(true)}>За всё время</button></div>{!allTime && <><select aria-label="Месяц" value={monthNumber} onChange={(event) => setMonth(`${year}-${String(event.target.value).padStart(2, '0')}`)}>{months.map((label, index) => <option value={index + 1} key={label}>{label}</option>)}</select><select aria-label="Год" value={year} onChange={(event) => setMonth(`${event.target.value}-${String(monthNumber).padStart(2, '0')}`)}>{years.map((value) => <option value={value} key={value}>{value}</option>)}</select></>}<select aria-label="Состав сотрудников" value={memberState} onChange={(event) => setMemberState(event.target.value as typeof memberState)}><option value="active">Активные</option><option value="all">Все</option><option value="former">Бывшие</option></select></div>
    {statistics.isLoading ? <div className="schedule-state"><span className="app-spinner" />Считаем рабочее время…</div> : statistics.isError ? <div className="schedule-state"><strong>Не удалось загрузить статистику</strong><button className="app-secondary" onClick={() => void statistics.refetch()}>Повторить</button></div> : <>
      <div className="statistics-summary"><article><span>Итого отработано сотрудниками</span><strong>{formatDuration(statistics.data?.summary.workedMinutes ?? 0)}</strong><small>сумма по выбранному составу</small></article><article><span>Завершённых смен</span><strong>{statistics.data?.summary.workedShifts ?? 0}</strong></article><article><span>Сотрудников в отчёте</span><strong>{statistics.data?.summary.employees ?? 0}</strong></article><article><span>Будущие смены</span><strong>{formatDuration(statistics.data?.summary.plannedMinutes ?? 0)}</strong><small>{statistics.data?.summary.plannedShifts ?? 0} смен</small></article></div>
      {statistics.data?.members.length ? <div className="statistics-table"><div className="statistics-table__head">{columns.map((column) => <button onClick={() => changeSort(column.key)} key={column.key}>{column.label}{sort === column.key && <span>{direction === 'asc' ? '↑' : '↓'}</span>}</button>)}</div>{statistics.data.members.map((member: WorkTimeMember) => <button className="statistics-table__row" type="button" onClick={() => { setSelectedMember(member.memberId); setHistoryPage(1) }} key={member.memberId}><span><strong>{member.name}</strong><small>{member.active ? 'Активный' : 'Бывший'}</small></span><span>{formatDuration(member.workedMinutes)}</span><span>{member.workedShifts}</span><span>{member.workedShifts ? formatDuration(member.averageMinutes) : '—'}</span><span>{formatDuration(member.plannedMinutes)}</span><span>{member.plannedShifts}</span></button>)}</div> : <div className="schedule-empty"><h3>За выбранный период нет завершённых смен</h3><p>Попробуйте выбрать другой период или состав сотрудников.</p></div>}
    </>}
    {selectedMember && <AnimatedOverlay variant="drawer" onClose={() => setSelectedMember(null)}>{(close) => <aside className="schedule-drawer schedule-drawer--wide"><button className="schedule-drawer__close" aria-label="Закрыть" onClick={close}>×</button>{detail.isLoading ? <div className="schedule-state"><span className="app-spinner" /></div> : detail.isError ? <div className="schedule-state">Не удалось загрузить данные сотрудника.</div> : detail.data && <WorkTimePanel data={detail.data} onShift={(id) => { setSelectedShift(id); setAuditPage(1) }} onPage={setHistoryPage} />}</aside>}</AnimatedOverlay>}
    {selectedShift && <AnimatedOverlay variant="modal" className="schedule-modal--front" onClose={() => setSelectedShift(null)}>{(close) => <section className="shift-audit" role="dialog" aria-modal="true"><header><div><p className="app-eyebrow">История изменений</p><h2>Корректировки смены</h2></div><button aria-label="Закрыть" onClick={close}>×</button></header>{shiftDetail.isLoading ? <div className="schedule-state"><span className="app-spinner" /></div> : shiftDetail.isError ? <div className="schedule-state">Не удалось загрузить историю.</div> : shiftDetail.data?.shift.adjustments.length ? <><div className="shift-audit__list">{shiftDetail.data.shift.adjustments.map((item) => <article key={item.id}><div><strong>{item.changedByName}</strong><span>{new Date(item.createdAt).toLocaleString('ru-RU')}</span></div><p>{item.reason}</p><dl><div><dt>Было</dt><dd>{formatTime(item.previousStartAt, organization.timezone)}–{formatTime(item.previousEndAt, organization.timezone)}</dd></div><div><dt>Стало</dt><dd>{formatTime(item.newStartAt, organization.timezone)}–{formatTime(item.newEndAt, organization.timezone)}</dd></div></dl></article>)}</div>{shiftDetail.data.shift.adjustmentPagination.pages > 1 && <div className="shift-history__pagination"><button disabled={auditPage <= 1} onClick={() => setAuditPage((page) => page - 1)}>Назад</button><span>{auditPage} из {shiftDetail.data.shift.adjustmentPagination.pages}</span><button disabled={auditPage >= shiftDetail.data.shift.adjustmentPagination.pages} onClick={() => setAuditPage((page) => page + 1)}>Далее</button></div>}</> : <div className="schedule-state">Корректировок этой смены нет.</div>}</section>}</AnimatedOverlay>}
  </section>
}
