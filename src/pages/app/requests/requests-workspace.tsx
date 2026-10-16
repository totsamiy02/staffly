import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { requestSections, type RequestTab } from '../../../app/requests/navigation.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'

const descriptions: Record<RequestTab, string> = {
  mine: 'Ваши обращения и их статусы.', incoming: 'Заявки, ожидающие решения.', history: 'Решённые и отменённые обращения.', staffing: 'Открытые смены в других точках.', vacations: 'Планирование отпусков и пожелания команды.', offers: 'Предложения передачи и обмена сменами.',
}
export default function RequestsWorkspace({ organization, section, actions, children }: { organization: OrganizationSummary; section: RequestTab; actions?: ReactNode; children: ReactNode }) {
  const [params] = useSearchParams(), sections = requestSections(organization)
  const location = params.get('location') ?? organization.locationId
  return <section className="requests-page requests-redesign requests-workspace"><header className="requests-heading"><div><nav className="requests-breadcrumbs" aria-label="Путь раздела"><span>Заявки</span><span aria-hidden="true">/</span><span>{sections.find(item => item.id === section)?.label}</span></nav><h1>Заявки</h1><p>{descriptions[section]}</p></div>{actions && <div className="requests-header-actions">{actions}</div>}</header>
    <SegmentedNav label="Разделы заявок">{sections.map(item => <Link key={item.id} className={item.id === section ? 'active' : ''} aria-current={item.id === section ? 'page' : undefined} to={`/app/organizations/${organization.id}/requests?${new URLSearchParams({ tab: item.id, ...(location ? { location } : {}) })}`}>{item.label}</Link>)}</SegmentedNav>
    {children}
  </section>
}
