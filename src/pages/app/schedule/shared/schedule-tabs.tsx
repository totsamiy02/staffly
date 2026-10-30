import { useDrafts, useTeamSettings } from '../../../../app/schedule/planning/team-planning.ts'
import { canAccess } from '../../../../app/access/catalog.ts'
import { useSubscription } from '../../../../app/subscriptions/context.ts'
import { LockBadge } from '../../subscriptions/plan-ui.tsx'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import { NavLink, useNavigate } from 'react-router-dom'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import '../schedule.scss'
import '../schedule-redesign.scss'

export default function ScheduleTabs({ organization }: { organization: OrganizationSummary }) {
  const drafts = useDrafts(organization.id), settings = useTeamSettings(organization.id), subscription = useSubscription(), navigate = useNavigate()
  const base = `/app/organizations/${organization.id}/schedule`
  const planning = subscription.available('planning'), reports = subscription.available('reports')
  return <div className="schedule-navigation"><SegmentedNav className="schedule-module-tabs" label="Разделы расписания" continuityKey={`schedule:${organization.id}:${organization.locationId}`}>
    {(canAccess(organization,'schedule.view') || canAccess(organization,'schedule.own') || canAccess(organization,'coverage.view')) && <NavLink end to={base}>Календарь</NavLink>}
    {canAccess(organization,'statistics.own') && <NavLink to={`${base}/work-time`}>Рабочее время</NavLink>}
    {(canAccess(organization,'statistics.view') || canAccess(organization,'reports.preview')) && <NavLink to={`${base}/statistics`}>{canAccess(organization,'statistics.view')?'Статистика':'Отчёты'}</NavLink>}

    {canAccess(organization,'schedule.history') && <NavLink to={`${base}/history`}>История смен</NavLink>}
  </SegmentedNav><div className="schedule-navigation__tools" aria-label="Инструменты расписания">
    {(canAccess(organization,'reports.preview') || canAccess(organization,'reports.export')) && <button type="button" onClick={() => reports ? navigate(`${base}/statistics?report=1`) : subscription.request({ feature: 'reports' })}>Выгрузка Excel{!reports && <LockBadge plan="TEAM" />}</button>}
    {((settings.data?.discussionEnabled || !!drafts.data?.drafts.length) || canAccess(organization,'drafts.view')) && <button type="button" onClick={() => planning ? navigate(`${base}/drafts?location=${organization.locationId}`) : subscription.request({ feature: 'planning' })}>Согласование графика{!planning && <LockBadge plan="BUSINESS" />}</button>}
    {canAccess(organization,'coverage.view') && <button type="button" onClick={() => planning ? navigate(`${base}/demand?location=${organization.locationId}`) : subscription.request({ feature: 'planning' })}>Потребность{!planning && <LockBadge plan="BUSINESS" />}</button>}
  </div></div>
}
