import NavigationIcon from '../../../component/ui/module-icon.tsx'
import TimeCorrectionProvider from '../schedule/time/time-correction-provider.tsx'
import MemberProfileProvider from '../members/profile/member-profile-provider.tsx'
import { canAccess, type Permission } from '../../../app/access/catalog.ts'
import { locationTone } from '../../../app/organizations/format.ts'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import LocationSwitcher from '../../../component/ui/location-switcher/location-switcher.tsx'
import { Navigate, Link, NavLink, Route, Routes, useLocation, useParams, useNavigate, useNavigationType } from 'react-router-dom'
import { lazy, Suspense, useState, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useOrganization, useLocations } from '../../../app/organizations/queries.ts'
import AppTopbar from '../topbar/app-topbar.tsx'
import ModuleErrorBoundary from './module-error-boundary.tsx'
import GuideIcon from '../../guide/guide-icon.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import OrganizationInfoDialog, { OrganizationInfoIcon } from '../organizations/organization-info-dialog.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { useDocuments } from '../../../app/documents/queries.ts'
import '../app.scss'

const DraftPage = lazy(() => import('../schedule/planning/draft-page.tsx'))
const DemandPage = lazy(() => import('../schedule/planning/demand-page.tsx'))

const OrganizationDashboard = lazy(() => import('../dashboard/organization-dashboard.tsx'))
const OrganizationMembers = lazy(() => import('../members/organization-members.tsx'))
const OrganizationSettings = lazy(() => import('../settings/organization/organization-settings.tsx'))
const SchedulePage = lazy(() => import('../schedule/calendar/schedule-page.tsx'))
const StatisticsPage = lazy(() => import('../schedule/statistics/statistics-page.tsx'))
const MyWorkTimePage = lazy(() => import('../schedule/time/my-work-time-page.tsx'))
const DocumentsPage = lazy(() => import('../documents/documents-page.tsx'))
const RequestsPage = lazy(() => import('../requests/requests-page.tsx'))
const EventsPage = lazy(() => import('../events/events-page.tsx'))

const modulePermissions:Record<string,Permission[]> = {employees:['members.view'],schedule:['coverage.view','drafts.view','schedule.own','schedule.view','statistics.own','statistics.view','reports.preview','reports.export'],requests:['offers.accept','offers.approve','offers.transfer','offers.swap','vacations.view','vacations.collect','requests.own','requests.view','staffing.respond','staffing.create'],documents:['documents.view'],events:['events.view','events.create','events.edit','events.cancel'],settings:['coverage.manage','organization.edit','schedule.settings','schedule.templates','positions.manage','offers.settings','locations.edit','locations.create','requestTypes.manage']}
const navigation = [
  ['', 'Главная'], ['employees', 'Сотрудники'], ['schedule', 'Расписание'], ['requests', 'Заявки'], ['events', 'События'], ['documents', 'Документы'], ['settings', 'Настройки'],
] as const

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={collapsed ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} /></svg>
}

function DocumentNavBadge({ organizationId }: { organizationId: string }) {
  const required = useDocuments(organizationId, { scope: 'required', pageSize: 1 })
  const count = required.data?.pagination.total ?? 0
  return count > 0 ? <span className="workspace-nav-badge" aria-label={`Требуют ознакомления: ${count}`}>{count > 99 ? '99+' : count}</span> : null
}

function ModuleNotFound({ organizationPath }: { organizationPath: string }) {
  return <section className="workspace-problem">
    <p className="app-eyebrow">Страница не найдена</p>
    <h1>Такого раздела нет</h1>
    <p>Адрес мог устареть или сформироваться некорректно. Вы можете безопасно вернуться в рабочее пространство.</p>
    <div><Link className="app-primary" to={organizationPath}>На главную организации</Link><Link className="app-secondary" to="/app">Все организации</Link></div>
  </section>
}

function WorkspaceLoadError({ retry, notFound, organizationId }: { retry: () => void; notFound: boolean; organizationId?: string }) {
  return <div className="app-page"><AppTopbar notificationOrganizationId={organizationId} /><main className="workspace-load-error" role="alert">
    <p className="app-eyebrow">{notFound ? 'Организация не найдена' : 'Не удалось открыть организацию'}</p>
    <h1>{notFound ? 'Нет доступа или организация удалена' : 'Страница временно недоступна'}</h1>
    <p>{notFound ? 'Проверьте адрес или вернитесь к доступным организациям.' : 'Проверьте подключение и попробуйте ещё раз.'}</p>
    <div>{!notFound && <button className="app-primary" type="button" onClick={retry}>Повторить</button>}<Link className="app-secondary" to="/app">Все организации</Link></div>
  </main></div>
}

export default function OrganizationLayout() {
  const { organizationId } = useParams()
  const location = useLocation()
  const navigationType = useNavigationType(), previousPath = useRef(location.pathname)
  useLayoutEffect(() => { if (previousPath.current !== location.pathname && navigationType !== 'POP') window.scrollTo({ top: 0, behavior: 'instant' }); previousPath.current = location.pathname }, [location.pathname, navigationType])
  const query = useOrganization(organizationId)
  const locations = useLocations(organizationId)
  const { user, locationId: requestedLocationId } = useAuth()
  const navigate = useNavigate()
  const selectedId = query.data?.organization.locationId
  const sectionParams = new URLSearchParams(location.search)
  useEffect(() => {
    if (selectedId) window.sessionStorage.setItem(`staffly:location:${user?.id}:${organizationId}`, selectedId)
  }, [selectedId, user?.id, organizationId])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('staffly:sidebar-collapsed') === 'true')
  const [infoOrganizationId, setInfoOrganizationId] = useState<string | null>(null)
  useEffect(() => { setInfoOrganizationId(null) }, [organizationId])
  if (query.isLoading) return <main className="app-loading"><span /></main>
  if (query.isError || !query.data) return <WorkspaceLoadError organizationId={organizationId} retry={() => void query.refetch()} notFound={Boolean(query.error && 'status' in query.error && query.error.status === 404)} />
  const organization = query.data.organization
  const organizationPath = `/app/organizations/${organization.id}`
  const currentSegment = location.pathname.slice(organizationPath.length).split('/').filter(Boolean)[0] ?? ''
  const currentSection = navigation.find(([path]) => path === currentSegment)?.[1] ?? 'Неизвестный раздел'
  const points = locations.data?.locations ?? (organization.location ? [organization.location] : [])
  const locationAddress = [organization.location?.city, organization.location?.address].filter(Boolean).join(' · ')
  const allowed = location.pathname.startsWith(organizationPath+'/schedule/drafts') || !currentSegment || currentSegment==='settings' && organization.owner || (modulePermissions[currentSegment]??[]).some(p=>canAccess(organization,p))
  const module = (content: ReactNode) => !allowed ? <section className="workspace-problem"><h1>Раздел недоступен</h1><p>Владелец может изменить вашу роль и доступ к этой точке.</p><Link className="app-secondary" to={organizationPath}>На главную</Link></section> : <ModuleErrorBoundary key={location.pathname + organization.locationId} organizationPath={organizationPath}><Suspense fallback={<section className="route-loading" role="status">Загрузка раздела…</section>}>{content}</Suspense></ModuleErrorBoundary>
  function toggleSidebar() {
    setSidebarCollapsed((value) => {
      window.localStorage.setItem('staffly:sidebar-collapsed', String(!value))
      return !value
    })
  }
  return <TimeCorrectionProvider key={organization.id + organization.locationId} organization={organization}><MemberProfileProvider organization={organization}><div className="app-page"><AppTopbar key={organization.locationId} organization={organization} /><div className={`workspace-shell${sidebarCollapsed ? ' workspace-shell--collapsed' : ''}`}>
    <aside className="workspace-sidebar" aria-label="Навигация организации">
      <button className="workspace-sidebar__organization workspace-organization-card" type="button" onClick={() => setInfoOrganizationId(organization.id)} aria-label={`Об организации: ${organization.name}`} aria-haspopup="dialog" aria-expanded={infoOrganizationId === organization.id}><Avatar url={organization.logoUrl} name={organization.name} className="workspace-sidebar__organization-avatar" eager /><span><strong>{organization.name}</strong><small>{currentSection}</small><span className="workspace-organization-info-trigger"><OrganizationInfoIcon /><span>Об организации</span></span></span></button>
      <LocationSwitcher onOpen={() => { if (sidebarCollapsed) toggleSidebar() }} points={points} value={requestedLocationId ?? organization.locationId ?? ''} onChange={pointId => { const next = new URLSearchParams({ location: pointId }); for (const key of ['section', 'tab', 'view']) { const value = sectionParams.get(key); if (value) next.set(key, value) } navigate({ pathname: location.pathname, search: `?${next}` }) }} />
      <button className="workspace-sidebar__collapse" type="button" onClick={toggleSidebar} aria-label={sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'}><CollapseIcon collapsed={sidebarCollapsed} /><span>{sidebarCollapsed ? '' : 'Свернуть меню'}</span></button>
      <nav aria-label="Разделы организации">{navigation.filter(([path]) => !path || path === 'settings' && organization.owner || (modulePermissions[path] ?? []).some(p => canAccess(organization,p))).map(([path, label]) => <NavLink end title={sidebarCollapsed ? label : undefined} to={`${path ? `${organizationPath}/${path}` : organizationPath}?location=${organization.locationId}`} key={label}><NavigationIcon section={path} /><span>{label}</span>{path === 'documents' && <DocumentNavBadge organizationId={organization.id} />}</NavLink>)}</nav>
      <div className="workspace-sidebar__footer"><NavLink className="workspace-sidebar__back" title={sidebarCollapsed ? 'Все организации' : undefined} to="/app"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m10 6-6 6 6 6M4 12h16" /></svg><span>Все организации</span></NavLink><Link className="workspace-sidebar__guide" to="/guide" title="Справочник" aria-label="Справочник"><GuideIcon name="book" /><span>Справочник</span></Link></div>
    </aside>
    <main className="workspace-content" key={currentSegment ? organization.locationId : organization.id}>{currentSegment && <div className="workspace-location-banner" data-tone={locationTone(organization.locationId ?? '')}><NavigationIcon section="location" /><strong title={organization.location?.name}>{organization.location?.name}</strong>{locationAddress && <span title={locationAddress}>{locationAddress}</span>}</div>}
      {query.isPlaceholderData ? <section className="route-loading" role="status">Переключаем точку…</section> : <Routes>
        <Route index element={module(<OrganizationDashboard organization={organization} />)} />
        <Route path="employees" element={module(<OrganizationMembers organization={organization} />)} />
        <Route path="schedule" element={module(<>{!canAccess(organization,'schedule.view') && !canAccess(organization,'schedule.own') && !canAccess(organization,'coverage.view') ? <Navigate to={organizationPath + (canAccess(organization,'statistics.own') ? '/schedule/work-time' : '/schedule/statistics') + location.search} replace/> : <SchedulePage key="calendar" organization={organization}/>}</>)} />
        <Route path="schedule/demand" element={module(<DemandPage organization={organization} />)} />
        <Route path="schedule/drafts" element={module(<DraftPage organization={organization} />)} />
        <Route path="schedule/drafts/:draftId" element={module(<DraftPage organization={organization} />)} />
        <Route path="schedule/history" element={!canAccess(organization, 'schedule.history') ? <Navigate to={`/app/organizations/${organization.id}/schedule`} replace /> : module(<SchedulePage key="history" organization={organization} historyMode />)} />
        <Route path="schedule/statistics" element={module(<StatisticsPage organization={organization} />)} />
        <Route path="schedule/work-time" element={module(<MyWorkTimePage organization={organization} />)} />
        <Route path="requests" element={module(<RequestsPage organization={organization} />)} />
        <Route path="settings" element={module(<OrganizationSettings organization={organization} />)} />
        <Route path="events" element={module(<EventsPage organization={organization} />)} />
        <Route path="documents" element={module(<DocumentsPage organization={organization} />)} />
        <Route path="*" element={<ModuleNotFound organizationPath={organizationPath} />} />
      </Routes>}
    </main>
  </div></div>{infoOrganizationId === organization.id && <AnimatedOverlay variant="modal" onClose={() => setInfoOrganizationId(null)}>{close => <OrganizationInfoDialog key={organization.id} organization={organization} onClose={close} />}</AnimatedOverlay>}</MemberProfileProvider></TimeCorrectionProvider>
}
