import { Link, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useOrganization } from '../../app/organizations/queries.ts'
import AppTopbar from './app-topbar.tsx'
import OrganizationDashboard from './organization-dashboard.tsx'
import OrganizationMembers from './organization-members.tsx'
import OrganizationSettings from './organization-settings.tsx'
import ModuleErrorBoundary from './module-error-boundary.tsx'
import './app.scss'

const navigation = [
  ['', 'Главная'], ['employees', 'Сотрудники'], ['schedule', 'Расписание'], ['tasks', 'Задачи'], ['requests', 'Заявки'], ['documents', 'Документы'], ['calendar', 'Календарь'], ['settings', 'Настройки'],
] as const

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

function WorkspaceLoadError({ retry }: { retry: () => void }) {
  return <div className="app-page"><AppTopbar /><main className="workspace-load-error" role="alert">
    <p className="app-eyebrow">Не удалось открыть организацию</p>
    <h1>Страница временно недоступна</h1>
    <p>Проверьте подключение и попробуйте ещё раз. Если доступ к организации был закрыт, вернитесь к списку организаций.</p>
    <div><button className="app-primary" type="button" onClick={retry}>Повторить</button><Link className="app-secondary" to="/app">Все организации</Link></div>
  </main></div>
}

const roleNames = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Участник' } as const

export default function OrganizationLayout() {
  const { organizationId } = useParams()
  const location = useLocation()
  const query = useOrganization(organizationId)
  if (query.isLoading) return <main className="app-loading"><span /></main>
  if (query.isError || !query.data) return <WorkspaceLoadError retry={() => void query.refetch()} />
  const organization = query.data.organization
  const organizationPath = `/app/organizations/${organization.id}`
  const currentSegment = location.pathname.slice(organizationPath.length).split('/').filter(Boolean)[0] ?? ''
  const currentSection = navigation.find(([path]) => path === currentSegment)?.[1] ?? 'Неизвестный раздел'
  const module = (content: ReactNode) => <ModuleErrorBoundary key={location.pathname} organizationPath={organizationPath}>{content}</ModuleErrorBoundary>
  return <div className="app-page"><AppTopbar /><div className="workspace-shell">
    <aside className="workspace-sidebar">
      <div className="workspace-sidebar__organization"><span>{organization.name.slice(0, 1).toUpperCase()}</span><div><strong>{organization.name}</strong><small>{roleNames[organization.role]} · {currentSection}</small></div></div>
      <nav aria-label="Разделы организации">{navigation.map(([path, label]) => <NavLink end to={path ? `${organizationPath}/${path}` : organizationPath} key={label}>{label}</NavLink>)}</nav>
      <NavLink className="workspace-sidebar__back" to="/app">Все организации</NavLink>
    </aside>
    <main className="workspace-content">
      <Routes>
        <Route index element={module(<OrganizationDashboard organization={organization} />)} />
        <Route path="employees" element={module(<OrganizationMembers organization={organization} />)} />
        <Route path="settings" element={module(<OrganizationSettings organization={organization} />)} />
        {navigation.slice(2, 7).map(([path, label]) => <Route path={path} element={module(<Placeholder title={label} />)} key={path} />)}
        <Route path="*" element={<ModuleNotFound organizationPath={organizationPath} />} />
      </Routes>
    </main>
  </div></div>
}
