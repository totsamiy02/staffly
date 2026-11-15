import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSubscriptionDetails } from '../../../app/subscriptions/queries.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { featureLabels, featurePlans, plans } from '../../../app/subscriptions/plans.ts'
import { SubscriptionContext, type PlanNotice } from '../../../app/subscriptions/context.ts'
import { requestErrorDetails } from '../../../app/auth/request-errors.ts'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import './subscription-gate.scss'

type SubscriptionRefusal = PlanNotice & { organizationId: string; interactive?: boolean }

export default function SubscriptionProvider({ organization, children }: {
  organization: OrganizationSummary
  children: ReactNode
}) {
  const query = useSubscriptionDetails(organization.id)
  const navigate = useNavigate()
  const subscription = query.data?.subscription ?? organization.subscription
  const [notice, setNotice] = useState<PlanNotice | null>(null)
  const refetch = query.refetch

  function choose(plan = notice?.requiredPlan ?? (notice?.feature ? featurePlans[notice.feature] : undefined)) {
    setNotice(null)
    navigate(`/app/organizations/${organization.id}/settings?section=subscription${plan ? `&plan=${plan}` : ''}`)
  }

  useEffect(() => {
    function listener(event: Event) {
      const detail = (event as CustomEvent<SubscriptionRefusal>).detail
      if (detail.organizationId !== organization.id) return
      void refetch()
      // Focus/reconnect/background queries refresh access without interrupting
      // the user or reopening a tariff dialog that they already dismissed.
      if (!detail.interactive) return
      const storagePlan = detail.kind === 'storage'
        ? subscription?.effectivePlan === 'FREE' ? 'TEAM' : subscription?.effectivePlan === 'TEAM' ? 'BUSINESS' : null
        : undefined
      setNotice({ ...detail, requiredPlan: detail.requiredPlan ?? storagePlan })
    }
    window.addEventListener('staffly:subscription-required', listener)
    return () => window.removeEventListener('staffly:subscription-required', listener)
  }, [organization.id, refetch, subscription?.effectivePlan])

  const required = notice?.requiredPlan ?? (notice?.feature ? featurePlans[notice.feature] : null)
  const target = required ? plans[required] : null
  const owner = !!organization.owner
  const title = notice?.feature ? featureLabels[notice.feature]
    : notice?.kind === 'members' ? 'Больше места для команды'
    : notice?.kind === 'locations' ? 'Больше точек для бизнеса'
    : notice?.kind === 'storage' ? 'Больше места для файлов'
    : 'Продолжите работу с командой'

  return (
    <SubscriptionContext.Provider value={{
      pending: query.isPending,
      error: query.error,
      refresh: () => { void refetch() },
      subscription,
      usage: query.data?.usage,
      available: feature => !!subscription?.features.includes(feature),
      request: setNotice,
      choose,
    }}>
      {children}
      {notice && (
        <AnimatedOverlay variant="modal" onClose={() => setNotice(null)}>
          {close => (
            <DocumentDialog title={title} eyebrow="Тариф организации" className="subscription-gate" onClose={close}>
              <p className="subscription-gate__description">
                {notice.message ? requestErrorDetails(notice.message).message
                  : notice.feature ? `Функция доступна на тарифе «${target?.name}». Выберите его в настройках организации.`
                  : 'Выберите подходящий тариф в настройках организации.'}
              </p>
              {target && (
                <section className="subscription-gate__plan" aria-label="Возможности тарифа">
                  <div className="subscription-gate__plan-heading">
                    <strong>{target.name}</strong>
                    <span>Подключение без оплаты</span>
                  </div>
                  <dl className="subscription-gate__limits">
                    <div><dt>Участников</dt><dd>{target.members}</dd></div>
                    <div><dt>Точек</dt><dd>{target.locations}</dd></div>
                    <div><dt>Хранилище</dt><dd>{target.storageLabel}</dd></div>
                  </dl>
                </section>
              )}
              <p className="subscription-gate__organization"><span>Организация</span><strong>{organization.name}</strong></p>
              {!owner && <p>Изменение доступа согласует владелец организации.</p>}
              {notice.kind === 'storage' && (
                <button className="subscription-text-button" onClick={() => {
                  setNotice(null)
                  navigate(`/app/organizations/${organization.id}/documents?section=history`)
                }}>Управлять файлами</button>
              )}
              <footer>
                <button className="app-secondary" onClick={close}>Не сейчас</button>
                <button className="app-primary" onClick={() => choose()}>Перейти к тарифам</button>
              </footer>
            </DocumentDialog>
          )}
        </AnimatedOverlay>
      )}
    </SubscriptionContext.Provider>
  )
}
