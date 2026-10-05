import { NavLink } from 'react-router-dom'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import './schedule.scss'
import './schedule-redesign.scss'

export default function ScheduleTabs({ organization }: { organization: OrganizationSummary }) {
  const base = `/app/organizations/${organization.id}/schedule`
  return <nav className="schedule-tabs" aria-label="Разделы расписания">
    <NavLink end to={base}>Календарь</NavLink>
    {organization.role === 'MEMBER' ? <NavLink to={`${base}/work-time`}>Рабочее время</NavLink> : <NavLink to={`${base}/statistics`}>Статистика</NavLink>}
    {organization.role !== 'MEMBER' && <NavLink to={`${base}/history`}>История смен</NavLink>}
  </nav>
}
