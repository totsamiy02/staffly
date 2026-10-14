import { useDrafts, useTeamSettings } from '../../../app/schedule/team-planning.ts'
import { canAccess } from '../../../app/access/catalog.ts'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import { NavLink } from 'react-router-dom'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import './schedule.scss'
import './schedule-redesign.scss'

export default function ScheduleTabs({ organization }: { organization: OrganizationSummary }) {
  const drafts = useDrafts(organization.id), settings = useTeamSettings(organization.id)
  const base = `/app/organizations/${organization.id}/schedule`
  return <SegmentedNav label="Разделы расписания">
    {(canAccess(organization,'schedule.view') || canAccess(organization,'schedule.own') || canAccess(organization,'coverage.view')) && <NavLink end to={base}>Календарь</NavLink>}
    {(settings.data?.discussionEnabled || !!drafts.data?.drafts.length) && <NavLink to={`${base}/drafts?location=${organization.locationId}`}>Согласование графика</NavLink>}
    {settings.data?.coverageEnabled && canAccess(organization,'coverage.view') && <NavLink to={`${base}/demand?location=${organization.locationId}`}>Потребность</NavLink>}
    {canAccess(organization,'statistics.own') && <NavLink to={`${base}/work-time`}>Рабочее время</NavLink>}
    {(canAccess(organization,'statistics.view') || canAccess(organization,'reports.preview')) && <NavLink to={`${base}/statistics`}>{canAccess(organization,'statistics.view')?'Статистика':'Отчёты'}</NavLink>}
    {canAccess(organization,'schedule.history') && <NavLink to={`${base}/history`}>История смен</NavLink>}
  </SegmentedNav>
}
