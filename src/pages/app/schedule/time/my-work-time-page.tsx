import AsyncPanel from '../../../../component/ui/async-panel.tsx'
import Select from '../../../../component/ui/select/select.tsx'
import { useState } from 'react'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import { monthKeyInZone, moveMonth } from '../../../../app/schedule/date-utils.ts'
import { useMyWorkTime } from '../../../../app/schedule/queries.ts'
import ScheduleSectionHeader from '../shared/schedule-section-header.tsx'
import WorkTimePanel from './work-time-panel.tsx'

const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

export default function MyWorkTimePage({ organization }: { organization: OrganizationSummary }) {
  const initial = monthKeyInZone(new Date(), organization.timezone)
  const [month, setMonth] = useState(initial)
  const [page, setPage] = useState(1)
  const [year, monthNumber] = month.split('-').map(Number)
  const query = useMyWorkTime(organization.id, { from: `${month}-01`, to: `${moveMonth(month, 1)}-01`, page })
  const years = Array.from({ length: 8 }, (_, index) => Number(initial.slice(0, 4)) - 4 + index)
  return <section className="schedule-page"><ScheduleSectionHeader organization={organization} title="Рабочее время" description={`Ваши часы и смены · ${organization.location?.name}`}/><div className="statistics-filters my-work-time-filters"><Select aria-label="Месяц" value={monthNumber} onChange={(event) => { setMonth(`${year}-${String(event.target.value).padStart(2, '0')}`); setPage(1) }}>{months.map((label, index) => <option value={index + 1} key={label}>{label}</option>)}</Select><Select aria-label="Год" value={year} onChange={(event) => { setMonth(`${event.target.value}-${String(monthNumber).padStart(2, '0')}`); setPage(1) }}>{years.map((value) => <option value={value} key={value}>{value}</option>)}</Select></div><AsyncPanel pending={query.isLoading} identity={`${month}:${page}`} minHeight={350}>{query.isLoading ? <div className="schedule-state"><span className="app-spinner" />Загружаем рабочее время…</div> : query.isError ? <div className="schedule-state"><strong>Не удалось загрузить рабочее время</strong><button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : query.data && <WorkTimePanel historyPending={query.isPlaceholderData} data={query.data} onPage={setPage} />}</AsyncPanel></section>
}
