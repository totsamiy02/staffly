import { useState } from 'react'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { monthKeyInZone, moveMonth } from '../../../app/schedule/date-utils.ts'
import { useMyWorkTime } from '../../../app/schedule/queries.ts'
import ScheduleTabs from './schedule-tabs.tsx'
import WorkTimePanel from './work-time-panel.tsx'

const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

export default function MyWorkTimePage({ organization }: { organization: OrganizationSummary }) {
  const initial = monthKeyInZone(new Date(), organization.timezone)
  const [month, setMonth] = useState(initial)
  const [page, setPage] = useState(1)
  const [year, monthNumber] = month.split('-').map(Number)
  const query = useMyWorkTime(organization.id, { from: `${month}-01`, to: `${moveMonth(month, 1)}-01`, page })
  const years = Array.from({ length: 8 }, (_, index) => new Date().getFullYear() - 4 + index)
  return <section className="schedule-page"><header className="schedule-heading"><div><p className="app-eyebrow">Личная статистика</p><h1>Рабочее время</h1><p>Ваши часы и смены в организации «{organization.name}».</p></div></header><ScheduleTabs organization={organization} /><div className="statistics-filters"><select value={monthNumber} onChange={(event) => { setMonth(`${year}-${String(event.target.value).padStart(2, '0')}`); setPage(1) }}>{months.map((label, index) => <option value={index + 1} key={label}>{label}</option>)}</select><select value={year} onChange={(event) => { setMonth(`${event.target.value}-${String(monthNumber).padStart(2, '0')}`); setPage(1) }}>{years.map((value) => <option value={value} key={value}>{value}</option>)}</select></div>{query.isLoading ? <div className="schedule-state"><span className="app-spinner" />Загружаем рабочее время…</div> : query.isError ? <div className="schedule-state"><strong>Не удалось загрузить рабочее время</strong><button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : query.data && <WorkTimePanel data={query.data} onPage={setPage} />}</section>
}
