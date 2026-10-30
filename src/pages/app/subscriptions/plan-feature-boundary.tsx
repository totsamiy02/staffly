import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { featureLabels, featurePlans, type PlanFeature } from '../../../app/subscriptions/plans.ts'
import { useSubscription } from '../../../app/subscriptions/context.ts'
import { canAccess } from '../../../app/access/catalog.ts'
import { LockBadge } from './plan-ui.tsx'
export default function PlanFeatureBoundary({ organization, feature, children }: { organization: OrganizationSummary; feature: PlanFeature; children: ReactNode }) {
  const subscription = useSubscription(), [opened, setOpened] = useState(false)
  // Published discussions also admit individual recipients without manager
  // permissions. The page/API checks their access to the particular draft.
  if (subscription.available(feature)) return children
  const permitted = feature === 'reports' ? canAccess(organization, 'reports.preview') || canAccess(organization, 'reports.export') : feature === 'customRoles' ? !!organization.owner : canAccess(organization, 'coverage.view') || canAccess(organization, 'drafts.view')
  if (!permitted) return <div className="app-state"><h2>Раздел недоступен</h2><p>Обратитесь к администратору организации.</p></div>
  return <section className="app-state"><LockBadge plan={featurePlans[feature]} /><h2>{featureLabels[feature]}</h2><p>Эта возможность доступна на платном тарифе для организации «{organization.name}».</p><button className="app-primary" onClick={() => { setOpened(true); subscription.request({ feature }) }}>{opened ? 'Посмотреть условия' : 'Открыть возможности тарифа'}</button><Link className="app-secondary" to={`/app/organizations/${organization.id}/schedule`}>Вернуться к расписанию</Link></section>
}
