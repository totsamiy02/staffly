import { useDrafts, useTeamSettings } from '../../../../app/schedule/planning/team-planning.ts'
import { canAccess } from '../../../../app/access/catalog.ts'
import { useSubscription } from '../../../../app/subscriptions/context.ts'
import { LockBadge } from '../../subscriptions/plan-ui.tsx'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import { NavLink, useNavigate, useSearchParams } from 'react-router-dom'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import '../schedule.scss'
import '../schedule-redesign.scss'

export default function ScheduleTabs({ organization }: { organization: OrganizationSummary }) {
  const drafts = useDrafts(organization.id), settings = useTeamSettings(organization.id), subscription = useSubscription(), navigate = useNavigate()
  const base = `/app/organizations/${organization.id}/schedule`
  const [params] = useSearchParams()
  const timesheetParams = new URLSearchParams()
  if (params.get('month')) timesheetParams.set('month', params.get('month')!)
  if (organization.locationId) timesheetParams.set('location', organization.locationId)
  const timesheetHref = `${base}/timesheet${timesheetParams.size ? `?${timesheetParams}` : ''}`
  const planning = subscription.available('planning')
  const canViewTimesheet = canAccess(organization, 'timesheets.view')
  const canPreviewReport = canAccess(organization, 'reports.preview')
  const timesheetAvailable = canViewTimesheet && subscription.available('timesheets')
    || canPreviewReport && subscription.available('reports')
  return <div className="schedule-navigation"><SegmentedNav className="schedule-module-tabs" label="Разделы расписания" continuityKey={`schedule:${organization.id}:${organization.locationId}`}>
    {(canAccess(organization,'schedule.view') || canAccess(organization,'schedule.own') || canAccess(organization,'coverage.view')) && <NavLink end to={base}>Календарь</NavLink>}
    {canAccess(organization,'statistics.own') && <NavLink to={`${base}/work-time${timesheetParams.size ? `?${timesheetParams}` : ''}`}>Рабочее время</NavLink>}
    {canAccess(organization,'statistics.view') && <NavLink to={`${base}/statistics${timesheetParams.size ? `?${timesheetParams}` : ''}`}>Статистика</NavLink>}

    {canAccess(organization,'schedule.history') && <NavLink to={`${base}/history`}>История смен</NavLink>}
    {(canViewTimesheet || canPreviewReport) && (timesheetAvailable
      ? <NavLink to={timesheetHref}>Табель</NavLink>
      : <button type="button" disabled={subscription.pending} onClick={() => subscription.request({ feature: canPreviewReport ? 'reports' : 'timesheets' })}>Табель<LockBadge plan={canPreviewReport ? 'TEAM' : 'BUSINESS'} /></button>)}
  </SegmentedNav><div className="schedule-navigation__tools" aria-label="Инструменты расписания">
    {((settings.data?.discussionEnabled || !!drafts.data?.drafts.length) || canAccess(organization,'drafts.view')) && <button type="button" disabled={subscription.pending} onClick={() => planning ? navigate(`${base}/drafts?location=${organization.locationId}`) : subscription.request({ feature: 'planning' })}>Согласование графика{!planning && <LockBadge plan="BUSINESS" />}</button>}
    {canAccess(organization,'coverage.view') && <button type="button" disabled={subscription.pending} onClick={() => planning ? navigate(`${base}/demand?location=${organization.locationId}`) : subscription.request({ feature: 'planning' })}>Потребность{!planning && <LockBadge plan="BUSINESS" />}</button>}
  </div></div>
}
