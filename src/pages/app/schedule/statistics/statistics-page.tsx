import AsyncPanel from '../../../../component/ui/async-panel.tsx'
import ShiftDetailsDialog from '../time/shift-details-dialog.tsx'
import MemberProfileLink from '../../../../component/ui/member-profile-link.tsx'
import MemberAvatar from '../../../../component/ui/member-avatar.tsx'
import ActionSurface from '../../../../component/ui/action-surface.tsx'
import { canAccess } from '../../../../app/access/catalog.ts'
import EmployeePicker from '../../shared/employee-picker.tsx'
import Select from '../../../../component/ui/select/select.tsx'
import { useState } from 'react'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import { formatDuration, monthKeyInZone, moveMonth } from '../../../../app/schedule/date-utils.ts'
import { useMemberWorkTime, useShiftDetails, useWorkTimeStatistics } from '../../../../app/schedule/queries.ts'
import type { WorkTimeMember } from '../../../../app/schedule/types.ts'
import ScheduleSectionHeader from '../shared/schedule-section-header.tsx'
import WorkTimePanel from '../time/work-time-panel.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import { useOrganizationMembers } from '../../../../app/organizations/queries.ts'
import ReportDialog from '../reports/report-dialog.tsx'

const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const columns: Array<{ key: 'name' | 'workedMinutes' | 'workedShifts' | 'averageMinutes' | 'plannedMinutes' | 'plannedShifts'; label: string }> = [
  { key: 'name', label: 'Сотрудник' }, { key: 'workedMinutes', label: 'Отработано' }, { key: 'workedShifts', label: 'Смен' }, { key: 'plannedMinutes', label: 'Запланировано' }, { key: 'plannedShifts', label: 'Будущих смен' },
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
  const [reportOpen, setReportOpen] = useState(false)
  const [reportBusy, setReportBusy] = useState(false)
  const from = allTime ? undefined : `${month}-01`
  const to = allTime ? undefined : `${moveMonth(month, 1)}-01`
  const params = { from, to, memberState, sort, direction }
  const statistics = useWorkTimeStatistics(organization.id, params, canAccess(organization, 'statistics.view'))
  const organizationMembers = useOrganizationMembers(organization.id)
  const pickerMembers = [...(organizationMembers.data?.members ?? []), ...(statistics.data?.members ?? []).filter(item => !organizationMembers.data?.members.some(member => member.id === item.memberId)).map(item => ({ id: item.memberId, displayName: item.name, email: '', avatarUrl: item.avatarUrl }))]
  const detail = useMemberWorkTime(organization.id, selectedMember, { ...params, page: historyPage })
  const shiftDetail = useShiftDetails(organization.id, selectedShift, auditPage)
  const [year, monthNumber] = month.split('-').map(Number)
  const years = Array.from({ length: 8 }, (_, index) => Number(initialMonth.slice(0, 4)) - 4 + index)

  function changeSort(key: typeof sort) {
    if (sort === key) setDirection((value) => value === 'asc' ? 'desc' : 'asc')
    else { setSort(key); setDirection(key === 'name' ? 'asc' : 'desc') }
  }

  if (!canAccess(organization,'statistics.view') && (canAccess(organization,'reports.preview') || canAccess(organization,'reports.export'))) return <section className="schedule-page"><ScheduleSectionHeader organization={organization} title="Отчёты" description="Рабочие часы и смены для выгрузки"><button className="app-primary" onClick={()=>setReportOpen(true)}>Сформировать отчёт</button></ScheduleSectionHeader>{reportOpen && <AnimatedOverlay variant="modal" dismissible={!reportBusy} onClose={()=>setReportOpen(false)}>{close=><ReportDialog organization={organization} month={month} onClose={close} onBusy={setReportBusy}/>}</AnimatedOverlay>}</section>
  if (!canAccess(organization, 'statistics.view')) return <div className="schedule-state">Общая статистика доступна владельцу и администраторам.</div>
  return <section className="schedule-page schedule-redesign"><ScheduleSectionHeader organization={organization} title="Статистика смен" description="Завершённые смены и плановые рабочие часы">{(canAccess(organization, 'reports.preview') || canAccess(organization, 'reports.export')) && <button type="button" className="app-primary" onClick={() => setReportOpen(true)}>Выгрузить Excel</button>}</ScheduleSectionHeader>
    {reportOpen && <AnimatedOverlay variant="modal" dismissible={!reportBusy} onClose={() => setReportOpen(false)}>{close => <ReportDialog organization={organization} month={allTime ? initialMonth : month} onClose={close} onBusy={setReportBusy} />}</AnimatedOverlay>}
    <div className="statistics-member-picker"><EmployeePicker label="Найти сотрудника" members={pickerMembers} value="" onChange={(id) => { setSelectedMember(id || null); setHistoryPage(1) }} emptyLabel="Поиск по имени или почте" required={false} disabled={organizationMembers.isLoading} /><small>Выберите сотрудника или нажмите его строку для просмотра часов. Общая сводка не меняется.</small></div>
    <div className="statistics-filters"><div className="statistics-period"><button className={allTime ? '' : 'active'} onClick={() => setAllTime(false)}>Месяц</button><button className={allTime ? 'active' : ''} onClick={() => setAllTime(true)}>За всё время</button></div>{!allTime && <><Select aria-label="Месяц" value={monthNumber} onChange={(event) => setMonth(`${year}-${String(event.target.value).padStart(2, '0')}`)}>{months.map((label, index) => <option value={index + 1} key={label}>{label}</option>)}</Select><Select aria-label="Год" value={year} onChange={(event) => setMonth(`${event.target.value}-${String(monthNumber).padStart(2, '0')}`)}>{years.map((value) => <option value={value} key={value}>{value}</option>)}</Select></>}<Select aria-label="Состав сотрудников" value={memberState} onChange={(event) => setMemberState(event.target.value as typeof memberState)}><option value="active">Активные</option><option value="all">Все</option><option value="former">Бывшие</option></Select></div>
    <AsyncPanel pending={statistics.isLoading} identity={`${month}:${allTime}:${memberState}:${sort}:${direction}`} minHeight={350}>{statistics.isLoading ? <div className="schedule-state"><span className="app-spinner" />Считаем рабочее время…</div> : statistics.isError ? <div className="schedule-state"><strong>Не удалось загрузить статистику</strong><button className="app-secondary" onClick={() => void statistics.refetch()}>Повторить</button></div> : <>
      <div className="statistics-summary"><article><span>Итого отработано сотрудниками</span><strong>{formatDuration(statistics.data?.summary.workedMinutes ?? 0)}</strong><small>сумма по выбранному составу</small></article><article><span>Завершённых смен</span><strong>{statistics.data?.summary.workedShifts ?? 0}</strong></article><article><span>Сотрудников в отчёте</span><strong>{statistics.data?.summary.employees ?? 0}</strong></article><article><span>Будущие смены</span><strong>{formatDuration(statistics.data?.summary.plannedMinutes ?? 0)}</strong><small>{statistics.data?.summary.plannedShifts ?? 0} смен</small></article></div>
      {statistics.data?.members.length ? <div className="statistics-table"><div className="statistics-table__head">{columns.map((column) => <button onClick={() => changeSort(column.key)} key={column.key}>{column.label}{sort === column.key && <span>{direction === 'asc' ? '↑' : '↓'}</span>}</button>)}</div>{statistics.data.members.map((member: WorkTimeMember) => <ActionSurface aria-label={`Рабочее время: ${member.name}`} className="statistics-table__row" type="button" onClick={() => { setSelectedMember(member.memberId); setHistoryPage(1) }} key={member.memberId}><span className="statistics-employee"><MemberAvatar memberId={member.memberId} url={member.avatarUrl} name={member.name} className="statistics-avatar" /><span><MemberProfileLink memberId={member.memberId}><strong>{member.name}</strong></MemberProfileLink><small>{member.active ? 'Активный' : 'Бывший'}</small></span></span><span>{formatDuration(member.workedMinutes)}</span><span>{member.workedShifts}</span><span>{formatDuration(member.plannedMinutes)}</span><span>{member.plannedShifts}</span></ActionSurface>)}</div> : <div className="schedule-empty"><h3>За выбранный период нет завершённых смен</h3><p>Попробуйте выбрать другой период или состав сотрудников.</p></div>}
    </>}</AsyncPanel>
    {selectedMember && <AnimatedOverlay variant="modal" onClose={() => setSelectedMember(null)}>{(close) => <DocumentDialog title="Рабочее время сотрудника" eyebrow="Статистика" scrollBody className="statistics-member-dialog" onClose={close}>{detail.isLoading ? <div className="schedule-state"><span className="app-spinner" /></div> : detail.isError ? <div className="schedule-state">Не удалось загрузить данные сотрудника.</div> : detail.data && <WorkTimePanel historyPending={detail.isPlaceholderData} data={detail.data} onShift={(id) => { setSelectedShift(id); setAuditPage(1) }} onPage={setHistoryPage} />}</DocumentDialog>}</AnimatedOverlay>}
    {selectedShift && <AnimatedOverlay variant="modal" className="schedule-modal--front" onClose={() => setSelectedShift(null)}>{close => <ShiftDetailsDialog shift={shiftDetail.data?.shift} pending={shiftDetail.isLoading} error={shiftDetail.error?.message} onRetry={() => void shiftDetail.refetch()} timezone={organization.timezone} locationId={organization.locationId ?? undefined} page={auditPage} onPage={setAuditPage} onClose={close} />}</AnimatedOverlay>}
  </section>
}
