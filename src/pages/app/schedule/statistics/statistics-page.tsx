import { useEffect, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { canAccess } from '../../../../app/access/catalog.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import { formatDuration, confirmedDuration, monthKeyInZone, moveMonth } from '../../../../app/schedule/date-utils.ts'
import { useMemberWorkTime, useShiftDetails, useWorkTimeStatistics } from '../../../../app/schedule/queries.ts'
import { useTimeCorrection } from '../../../../app/schedule/time/time-correction-context.tsx'
import AsyncPanel from '../../../../component/ui/async-panel.tsx'
import ActionSurface from '../../../../component/ui/action-surface.tsx'
import MemberAvatar from '../../../../component/ui/member-avatar.tsx'
import MemberProfileLink from '../../../../component/ui/member-profile-link.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import Select from '../../../../component/ui/select/select.tsx'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import ScheduleSectionHeader from '../shared/schedule-section-header.tsx'
import ShiftDetailsDialog from '../time/shift-details-dialog.tsx'
import WorkTimePanel from '../time/work-time-panel.tsx'
import { WorkTimeTotals, WorkTimeRulesButton } from '../time/work-time-totals.tsx'
import './statistics.scss'

const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const columns = [
  { key: 'name', label: 'Сотрудник' },
  { key: 'plannedMinutes', label: 'План' },
  { key: 'estimatedMinutes', label: 'Предварительно' },
  { key: 'workedMinutes', label: 'Подтверждено' },
  { key: 'pendingShifts', label: 'Без подтверждения' },
] as const

type SortKey = typeof columns[number]['key']

export default function StatisticsPage({ organization }: { organization: OrganizationSummary }) {
  const correction = useTimeCorrection()
  const [searchParams] = useSearchParams()
  const initialMonth = monthKeyInZone(new Date(), organization.timezone)
  const [month, setMonth] = useState(() => {
    const selected = searchParams.get('month')
    return selected && /^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/.test(selected) ? selected : initialMonth
  })
  const [allTime, setAllTime] = useState(false)
  const [memberState, setMemberState] = useState<'active' | 'all' | 'former'>('active')
  const [sort, setSort] = useState<SortKey>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selectedMember, setSelectedMember] = useState<string | null>(null)
  const [selectedShift, setSelectedShift] = useState<string | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [auditPage, setAuditPage] = useState(1)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const from = allTime ? undefined : `${month}-01`
  const to = allTime ? undefined : `${moveMonth(month, 1)}-01`
  const period = { from, to, memberState, sort, direction }
  const permitted = canAccess(organization, 'statistics.view')
  const statistics = useWorkTimeStatistics(organization.id, {
    ...period, search: debouncedSearch || undefined, page, limit: 25,
  }, permitted)
  const detail = useMemberWorkTime(organization.id, selectedMember, { ...period, page: historyPage })
  const shiftDetail = useShiftDetails(organization.id, selectedShift, auditPage)
  const [year, monthNumber] = month.split('-').map(Number)
  const years = Array.from({ length: 8 }, (_, index) => Number(initialMonth.slice(0, 4)) - 4 + index)
  const pagination = statistics.data?.pagination

  function changeSort(key: SortKey) {
    if (sort === key) setDirection(value => value === 'asc' ? 'desc' : 'asc')
    else {
      setSort(key)
      setDirection(key === 'name' ? 'asc' : 'desc')
    }
    setPage(1)
  }

  function changeMonth(value: string) {
    setMonth(value)
    setPage(1)
  }

  // Keep saved report links useful after moving all exports to the timesheet.
  if (searchParams.get('report') === '1' || !permitted && canAccess(organization, 'reports.preview')) {
    const params = new URLSearchParams({ month })
    if (organization.locationId) params.set('location', organization.locationId)
    return <Navigate replace to={`/app/organizations/${organization.id}/schedule/timesheet?${params}`} />
  }
  if (!permitted) return <div className="schedule-state">Для просмотра общей статистики требуется разрешение.</div>

  return (
    <section className="schedule-page statistics-page time-accounting-page">
      <ScheduleSectionHeader organization={organization} title="Статистика смен" description="План, предварительный расчёт и подтверждённые часы" />
      <div className="statistics-toolbar">
        <SegmentedNav className="statistics-range" label="Период статистики">
          <button type="button" aria-pressed={!allTime} onClick={() => { setAllTime(false); setPage(1) }}>Месяц</button>
          <button type="button" aria-pressed={allTime} onClick={() => { setAllTime(true); setPage(1) }}>За всё время</button>
        </SegmentedNav>
        {!allTime && (
          <div className="statistics-month">
            <Select aria-label="Месяц" value={monthNumber} onChange={event => changeMonth(`${year}-${String(event.target.value).padStart(2, '0')}`)}>
              {months.map((label, index) => <option value={index + 1} key={label}>{label}</option>)}
            </Select>
            <Select aria-label="Год" value={year} onChange={event => changeMonth(`${event.target.value}-${String(monthNumber).padStart(2, '0')}`)}>
              {years.map(value => <option value={value} key={value}>{value}</option>)}
            </Select>
          </div>
        )}
        <Select aria-label="Состав сотрудников" value={memberState} onChange={event => { setMemberState(event.target.value as typeof memberState); setPage(1) }}>
          <option value="active">Активные</option>
          <option value="all">Все сотрудники</option>
          <option value="former">Бывшие</option>
        </Select>
        <WorkTimeRulesButton />
      </div>
      <div className="statistics-list-toolbar">
        <label className="statistics-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
          <input type="search" aria-label="Поиск сотрудника" placeholder="Имя, фамилия или почта" autoComplete="off" maxLength={200} value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} />
        </label>
        <span aria-live="polite">Сотрудников: {pagination?.total ?? '—'}</span>
      </div>
      <AsyncPanel pending={statistics.isLoading} identity={`${month}:${allTime}:${memberState}:${sort}:${direction}:${page}:${debouncedSearch}`} minHeight={350}>
        {statistics.isLoading ? (
          <div className="schedule-state"><span className="app-spinner" />Считаем рабочее время…</div>
        ) : statistics.isError ? (
          <div className="schedule-state"><strong>Не удалось загрузить статистику</strong><button className="app-secondary" onClick={() => void statistics.refetch()}>Повторить</button></div>
        ) : (
          <>
            <WorkTimeTotals metrics={statistics.data?.summary} />
            {!!statistics.data?.summary.pendingShifts && (
              <div className="work-time-attention">
                <span>Без подтверждения после окончания: {statistics.data.summary.pendingShifts} смен.</span>
                <button type="button" className="app-secondary" onClick={() => { setSort('pendingShifts'); setDirection('desc'); setPage(1) }}>Показать сотрудников</button>
              </div>
            )}
            {!!statistics.data?.summary.plannedShifts && (
              <p className="work-time-footnote">Будущие и незавершённые смены: {statistics.data.summary.plannedShifts} · {formatDuration(statistics.data.summary.futureMinutes)} по плану. Они входят в предварительный прогноз.</p>
            )}
            {statistics.data?.members.length ? (
              <div className="statistics-table">
                <div className="statistics-table__head">
                  {columns.map(column => (
                    <button type="button" onClick={() => changeSort(column.key)} key={column.key}>
                      {column.label}{sort === column.key && <span>{direction === 'asc' ? '↑' : '↓'}</span>}
                    </button>
                  ))}
                </div>
                {statistics.data.members.map(member => (
                  <ActionSurface type="button" aria-label={`Рабочее время: ${member.name}`} className="statistics-table__row" key={member.memberId} onClick={() => { setSelectedMember(member.memberId); setHistoryPage(1) }}>
                    <span className="statistics-employee">
                      <MemberAvatar memberId={member.memberId} url={member.avatarUrl} name={member.name} className="statistics-avatar" />
                      <span><MemberProfileLink memberId={member.memberId}><strong>{member.name}</strong></MemberProfileLink><small>{member.active ? 'Активный' : 'Бывший'}</small></span>
                    </span>
                    <span data-label="План">{formatDuration(member.plannedMinutes)}</span>
                    <span data-label="Предварительно">{formatDuration(member.estimatedMinutes)}</span>
                    <span data-label="Подтверждено">{confirmedDuration(member.workedMinutes, member.confirmedShifts)}</span>
                    <span data-label="Без подтверждения">
                      {member.pendingShifts}
                      {member.firstPendingShiftId && correction?.canOpen(organization.locationId ?? undefined) && (
                        <button type="button" className="app-secondary statistics-review-button" onClick={event => { event.stopPropagation(); correction.open(member.firstPendingShiftId!, organization.locationId ?? undefined) }}>Разобрать</button>
                      )}
                    </span>
                  </ActionSurface>
                ))}
              </div>
            ) : (
              <div className="schedule-empty">
                <h3>{debouncedSearch ? 'Сотрудники не найдены' : 'За выбранный период нет данных'}</h3>
                <p>{debouncedSearch ? 'Попробуйте другое имя или почту.' : 'Попробуйте выбрать другой период или состав сотрудников.'}</p>
              </div>
            )}
            {pagination && pagination.pages > 1 && (
              <nav className="members-pagination" aria-label="Страницы статистики">
                <button className="app-secondary" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Назад</button>
                <span>{page} / {pagination.pages} · Всего: {pagination.total}</span>
                <button className="app-secondary" disabled={page >= pagination.pages} onClick={() => setPage(value => value + 1)}>Далее</button>
              </nav>
            )}
          </>
        )}
      </AsyncPanel>
      {selectedMember && (
        <AnimatedOverlay variant="modal" onClose={() => setSelectedMember(null)}>
          {close => (
            <DocumentDialog title="Рабочее время сотрудника" eyebrow="Статистика" scrollBody className="statistics-member-dialog" onClose={close}>
              {detail.isLoading ? <div className="schedule-state"><span className="app-spinner" /></div> : detail.isError ? <div className="schedule-state">Не удалось загрузить данные сотрудника.</div> : detail.data && (
                <WorkTimePanel historyPending={detail.isPlaceholderData} data={detail.data} onShift={id => { setSelectedShift(id); setAuditPage(1) }} onPage={setHistoryPage} />
              )}
            </DocumentDialog>
          )}
        </AnimatedOverlay>
      )}
      {selectedShift && (
        <AnimatedOverlay variant="modal" className="schedule-modal--front" onClose={() => setSelectedShift(null)}>
          {close => <ShiftDetailsDialog shift={shiftDetail.data?.shift} pending={shiftDetail.isLoading} error={shiftDetail.error?.message} onRetry={() => void shiftDetail.refetch()} timezone={organization.timezone} locationId={organization.locationId ?? undefined} page={auditPage} onPage={setAuditPage} onClose={close} />}
        </AnimatedOverlay>
      )}
    </section>
  )
}
