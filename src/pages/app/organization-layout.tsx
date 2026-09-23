import { Link, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useState, type ReactNode } from 'react'
import { useOrganization } from '../../app/organizations/queries.ts'
import AppTopbar from './app-topbar.tsx'
import OrganizationDashboard from './organization-dashboard.tsx'
import OrganizationMembers from './organization-members.tsx'
import OrganizationSettings from './organization-settings.tsx'
import SchedulePage from './schedule/schedule-page.tsx'
import StatisticsPage from './schedule/statistics-page.tsx'
import MyWorkTimePage from './schedule/my-work-time-page.tsx'
import ModuleErrorBoundary from './module-error-boundary.tsx'
import Avatar from '../../component/ui/avatar/avatar.tsx'
import './app.scss'

const navigation = [
  ['', 'Главная'], ['employees', 'Сотрудники'], ['schedule', 'Расписание'], ['tasks', 'Задачи'], ['requests', 'Заявки'], ['documents', 'Документы'], ['calendar', 'Календарь'], ['settings', 'Настройки'],
] as const

function NavigationIcon({ section }: { section: string }) {
  const common = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true } as const
  if (section === '') return <svg {...common}><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v10h13V10M9 20v-6h6v6" /></svg>
  if (section === 'employees') return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 20v-2.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V20M15 5.5a3 3 0 0 1 0 5.5M17 13a4 4 0 0 1 3.5 4v3" /></svg>
  if (section === 'schedule') return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 17h3" /></svg>
  if (section === 'tasks') return <svg {...common}><path d="m5 7 1.5 1.5L9 6M12 7h7M5 13l1.5 1.5L9 12M12 13h7M5 19l1.5 1.5L9 18M12 19h7" /></svg>
  if (section === 'requests') return <svg {...common}><path d="M4 4h16v13H8l-4 4V4Z" /><path d="M8 9h8M8 13h5" /></svg>
  if (section === 'documents') return <svg {...common}><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></svg>
  if (section === 'calendar') return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18" /></svg>
  return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.5v-.1A1.7 1.7 0 0 0 8.4 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4 15a1.7 1.7 0 0 0-1.5-1H2.4V10h.1A1.7 1.7 0 0 0 4 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.46 4.2l.06.06A1.7 1.7 0 0 0 8.4 4a1.7 1.7 0 0 0 1.1-1.5v-.1h4.1v.1A1.7 1.7 0 0 0 15 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={collapsed ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} /></svg>
}

function Placeholder({ title }: { title: string }) {
  return <section className="workspace-placeholder"><p className="app-eyebrow">Раздел организации</p><h1>{title}</h1><p>Раздел подготовлен для следующего этапа разработки.</p></section>
}

function ModuleNotFound({ organizationPath }: { organizationPath: string }) {
  return <section className="workspace-problem">
    <p className="app-eyebrow">Страница не найдена</p>
    <h1>Такого раздела нет</h1>
    <p>Адрес мог устареть или сформироваться некорректно. Вы можете безопасно вернуться в рабочее пространство.</p>
    <div><Link className="app-primary" to={organizationPath}>На главную организации</Link><Link className="app-secondary" to="/app">Все организации</Link></div>
  </section>
}

function WorkspaceLoadError({ retry, notFound }: { retry: () => void; notFound: boolean }) {
  return <div className="app-page"><AppTopbar /><main className="workspace-load-error" role="alert">
    <p className="app-eyebrow">{notFound ? 'Организация не найдена' : 'Не удалось открыть организацию'}</p>
    <h1>{notFound ? 'Нет доступа или организация удалена' : 'Страница временно недоступна'}</h1>
    <p>{notFound ? 'Проверьте адрес или вернитесь к доступным организациям.' : 'Проверьте подключение и попробуйте ещё раз.'}</p>
    <div>{!notFound && <button className="app-primary" type="button" onClick={retry}>Повторить</button>}<Link className="app-secondary" to="/app">Все организации</Link></div>
  </main></div>
}

const roleNames = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Пользователь' } as const

export default function OrganizationLayout() {
  const { organizationId } = useParams()
  const location = useLocation()
  const query = useOrganization(organizationId)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('staffly:sidebar-collapsed') === 'true')
  if (query.isLoading) return <main className="app-loading"><span /></main>
  if (query.isError || !query.data) return <WorkspaceLoadError retry={() => void query.refetch()} notFound={Boolean(query.error && 'status' in query.error && query.error.status === 404)} />
  const organization = query.data.organization
  const organizationPath = `/app/organizations/${organization.id}`
  const currentSegment = location.pathname.slice(organizationPath.length).split('/').filter(Boolean)[0] ?? ''
  const currentSection = navigation.find(([path]) => path === currentSegment)?.[1] ?? 'Неизвестный раздел'
  const module = (content: ReactNode) => <ModuleErrorBoundary key={location.pathname} organizationPath={organizationPath}>{content}</ModuleErrorBoundary>
  function toggleSidebar() {
    setSidebarCollapsed((value) => {
      window.localStorage.setItem('staffly:sidebar-collapsed', String(!value))
      return !value
    })
  }
  return <div className="app-page"><AppTopbar organization={organization} /><div className={`workspace-shell${sidebarCollapsed ? ' workspace-shell--collapsed' : ''}`}>
    <aside className="workspace-sidebar" aria-label="Навигация организации">
      <div className="workspace-sidebar__organization"><Avatar url={organization.logoUrl} name={organization.name} className="workspace-sidebar__organization-avatar" eager /><div><strong>{organization.name}</strong><small>{roleNames[organization.role]} · {currentSection}</small></div></div>
      <button className="workspace-sidebar__collapse" type="button" aria-label={sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'} onClick={toggleSidebar}><CollapseIcon collapsed={sidebarCollapsed} /><span>{sidebarCollapsed ? 'Развернуть' : 'Свернуть'}</span></button>
      <nav aria-label="Разделы организации">{navigation.map(([path, label]) => <NavLink end title={sidebarCollapsed ? label : undefined} to={path ? `${organizationPath}/${path}` : organizationPath} key={label}><NavigationIcon section={path} /><span>{label}</span></NavLink>)}</nav>
      <div className="workspace-sidebar__footer"><NavLink className="workspace-sidebar__back" title={sidebarCollapsed ? 'Все организации' : undefined} to="/app"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m10 6-6 6 6 6M4 12h16" /></svg><span>Все организации</span></NavLink></div>
    </aside>
    <main className="workspace-content">
      <Routes>
        <Route index element={module(<OrganizationDashboard organization={organization} />)} />
        <Route path="employees" element={module(<OrganizationMembers organization={organization} />)} />
        <Route path="schedule" element={module(<SchedulePage organization={organization} />)} />
        <Route path="schedule/statistics" element={module(<StatisticsPage organization={organization} />)} />
        <Route path="schedule/work-time" element={module(<MyWorkTimePage organization={organization} />)} />
        <Route path="settings" element={module(<OrganizationSettings organization={organization} />)} />
        {navigation.slice(2, 7).filter(([path]) => path !== 'schedule').map(([path, label]) => <Route path={path} element={module(<Placeholder title={label} />)} key={path} />)}
        <Route path="*" element={<ModuleNotFound organizationPath={organizationPath} />} />
      </Routes>
    </main>
  </div></div>
}
