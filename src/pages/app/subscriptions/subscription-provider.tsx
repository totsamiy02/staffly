import { useSubscriptionDetails } from '../../../app/subscriptions/queries.ts'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { featureLabels, featurePlans, money, plans } from '../../../app/subscriptions/plans.ts'
import { SubscriptionContext, type PlanNotice } from '../../../app/subscriptions/context.ts'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import { PlanIcon } from './plan-ui.tsx'
export default function SubscriptionProvider({ organization, children }: { organization: OrganizationSummary; children: ReactNode }) {
  const query = useSubscriptionDetails(organization.id), navigate = useNavigate()
  const subscription = query.data?.subscription ?? organization.subscription
  const [notice, setNotice] = useState<PlanNotice | null>(null)
  function choose(plan = notice?.requiredPlan ?? (notice?.feature ? featurePlans[notice.feature] : undefined)) {
    setNotice(null); navigate(`/app/organizations/${organization.id}/settings?section=subscription${plan ? `&plan=${plan}` : ''}`)
  }
  const refetch = query.refetch
  useEffect(() => {
    const listener = (event: Event) => { const detail = (event as CustomEvent<PlanNotice & { organizationId: string }>).detail; if (detail.organizationId === organization.id) { setNotice({ ...detail, requiredPlan: detail.requiredPlan ?? (detail.kind === 'storage' ? subscription?.effectivePlan === 'FREE' ? 'TEAM' : subscription?.effectivePlan === 'TEAM' ? 'BUSINESS' : null : undefined) }); void refetch() } }
    window.addEventListener('staffly:subscription-required', listener)
    return () => window.removeEventListener('staffly:subscription-required', listener)
  }, [organization.id, refetch, subscription?.effectivePlan])
  const required = notice?.requiredPlan ?? (notice?.feature ? featurePlans[notice.feature] : null), target = required ? plans[required] : null
  const owner = !!organization.owner
  return <SubscriptionContext.Provider value={{ subscription, usage: query.data?.usage, available: feature => !!subscription?.features.includes(feature), request: setNotice, choose }}>
    {children}
    {notice && <AnimatedOverlay variant="modal" onClose={() => setNotice(null)}>{close => <DocumentDialog title={notice.feature ? featureLabels[notice.feature] : notice.kind === 'members' ? 'Больше места для команды' : notice.kind === 'locations' ? 'Больше точек для бизнеса' : notice.kind === 'storage' ? 'Больше места для файлов' : 'Продолжите работу с командой'} eyebrow="Возможности Staffly" className="subscription-gate" onClose={close}>
      <div className="subscription-gate__preview" aria-hidden="true"><div className="subscription-gate__preview-lines"><i/><i/><i/></div><PlanIcon plan={required ?? subscription?.effectivePlan ?? 'TEAM'} /><div className="subscription-gate__preview-bars"><i/><i/><i/><i/></div></div>
      <p>{notice.message ?? (notice.feature ? `Подключите «${required === 'TEAM' ? 'Команду' : target?.name}», чтобы использовать эту возможность в вашей организации.` : 'Выберите подходящий тариф для продолжения работы.')}</p>
      {target && <div className="subscription-gate__offer"><div><PlanIcon plan={required!}/><span><strong>{target.name}</strong><small>{target.members} участников · {target.locations} точек · {target.storageLabel}</small></span></div><p><b>{money(target.priceMinor)}</b><small>/ месяц</small></p></div>}
      <div className="subscription-gate__organization"><span>Для организации</span><strong>{organization.name}</strong></div>
      {!owner && <p>Изменить тариф может владелец организации.</p>}
      {notice.kind === 'storage' && <button className="subscription-text-button" onClick={() => { setNotice(null); navigate(`/app/organizations/${organization.id}/documents?section=history`) }}>Управлять файлами</button>}
      <footer><button className="app-secondary" onClick={close}>{owner ? 'Не сейчас' : 'Понятно'}</button><button className="app-primary" onClick={() => choose()}>{owner ? target ? `Выбрать ${required === 'TEAM' ? 'Команду' : 'Бизнес'}` : 'Посмотреть тарифы' : 'Посмотреть тарифы'}</button></footer>
    </DocumentDialog>}</AnimatedOverlay>}
  </SubscriptionContext.Provider>
}
