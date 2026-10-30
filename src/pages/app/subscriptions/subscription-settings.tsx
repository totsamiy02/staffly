import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { isPlanId, plans, money, type PlanId, type PaidPlanId } from '../../../app/subscriptions/plans.ts'
import { sizeLabel } from '../../../app/documents/types.ts'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import { PlanCards, PlanIcon } from './plan-ui.tsx'
import SubscriptionCheckout from './subscription-checkout.tsx'
import { useSubscriptionDetails, useSubscriptionRefresh } from '../../../app/subscriptions/queries.ts'
const phaseLabels = { trial: 'Пробный период', active: 'Активна', free: 'Без срока окончания', grace: 'Льготный период', expired: 'Завершилась' }
export default function SubscriptionSettings({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest } = useAuth(), refresh = useSubscriptionRefresh(), query = useSubscriptionDetails(organization.id)
  const [params, setParams] = useSearchParams(), planParam = params.get('plan')
  const [checkout, setCheckout] = useState<PaidPlanId | null>(null), [confirmFree, setConfirmFree] = useState(false), [busy, setBusy] = useState(false)
  const [confirmTrial, setConfirmTrial] = useState(false)
  const trial = useMutation({ mutationFn: () => apiRequest(`/organizations/${organization.id}/subscription/trial`, { method: 'POST', body: { confirm: true } }), onSuccess: async () => { setConfirmTrial(false); await refresh() } })
  useEffect(() => { if (planParam === 'TEAM' || planParam === 'BUSINESS') { if (organization.owner) setCheckout(planParam); setParams(previous => { const next = new URLSearchParams(previous); next.delete('plan'); return next }, { replace: true }) } }, [planParam, organization.owner, setParams])
  const free = useMutation({ mutationFn: () => apiRequest(`/organizations/${organization.id}/subscription/free`, { method: 'POST', body: { confirm: true, immediate: false } }), onSuccess: async () => { setConfirmFree(false); await refresh() } })
  const cancel = useMutation({ mutationFn: () => apiRequest(`/organizations/${organization.id}/subscription/scheduled-change`, { method: 'DELETE' }), onSuccess: refresh })
  if (query.isLoading) return <div className="app-state" role="status">Загружаем тариф…</div>
  if (!query.data) return <div className="app-state" role="alert"><p>{query.error?.message ?? 'Не удалось загрузить подписку.'}</p><button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div>
  const { subscription: sub, usage, canManage, purchases } = query.data, selected = plans[sub.plan]
  function choose(plan: PlanId) { if (!canManage) return; if (plan === 'FREE') { free.reset(); setConfirmFree(true) } else setCheckout(plan) }
  return <div className="subscription-settings"><div className="subscription-section-heading"><div><h2>Тариф и использование</h2><p>Подписка действует только для «{organization.name}».</p></div><span className="subscription-test-label">Тестовые покупки · без списания</span></div>
    <article className="subscription-current"><div className="subscription-current__heading"><PlanIcon plan={sub.plan} /><div><h3>{selected.name}</h3><p>{money(selected.priceMinor)} / месяц</p></div><div className="subscription-current__status"><strong>{phaseLabels[sub.phase]}</strong>{sub.validUntil && <small>До {new Date(sub.validUntil).toLocaleDateString('ru-RU')}</small>}</div></div>
      <div className="subscription-usage">{[{ label: 'Участники', used: usage.members, limit: sub.limits.members, text: `${usage.members} / ${sub.limits.members}` }, { label: 'Точки', used: usage.locations, limit: sub.limits.locations, text: `${usage.locations} / ${sub.limits.locations}` }, { label: 'Хранилище', used: usage.storageBytes, limit: sub.limits.storageBytes, text: `${sizeLabel(usage.storageBytes)} / ${sizeLabel(sub.limits.storageBytes)}` }].map(item => <div key={item.label} className={item.used / item.limit >= .8 ? 'is-near-limit' : ''}><div><strong>{item.label}</strong><span>{item.text}</span></div><progress value={Math.min(item.used, item.limit)} max={item.limit} aria-label={item.label} /></div>)}</div>
      <small>Участник в нескольких точках занимает одно место. Бывшие сотрудники не занимают места.</small>
    </article>
    {canManage && sub.scheduled && <div className="subscription-banner"><p>С {new Date(sub.scheduled.startsAt).toLocaleDateString('ru-RU')} — тариф «{plans[sub.scheduled.plan].name}».</p>{canManage && sub.scheduled.plan === 'FREE' && <button className="app-secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Отменить изменение</button>}</div>}
    {cancel.error && <p className="form-inline-error" role="alert">{cancel.error.message}</p>}
    <div className="subscription-section-heading"><div><h2>Выберите подходящий тариф</h2>{!canManage && <p>Изменить тариф может владелец организации.</p>}</div></div>
    <PlanCards current={sub.phase === 'trial' ? undefined : sub.effectivePlan} onChoose={choose} busy={!canManage || !!sub.scheduled} trialAvailable={canManage && sub.trialAvailable} onTrial={() => { trial.reset(); setConfirmTrial(true) }} />
    {confirmTrial && <AnimatedOverlay variant="modal" dismissible={!trial.isPending} onClose={() => setConfirmTrial(false)}>{close => <DocumentDialog title="Попробовать Бизнес бесплатно?" eyebrow="14 дней для вашей организации" onClose={close} busy={trial.isPending}><div className="subscription-trial-preview"><PlanIcon plan="BUSINESS" /><p>100 участников · 10 точек · 10 ГБ</p></div><p>Все возможности Бизнеса для «{organization.name}» на 14 дней с момента подключения. Карта не нужна, автоматического списания нет. Пробный период доступен один раз для каждой организации.</p>{trial.error && <p role="alert" className="form-inline-error">{trial.error.message}</p>}<footer><button className="app-secondary" disabled={trial.isPending} onClick={close}>Пока не нужно</button><button className="app-primary" disabled={trial.isPending} onClick={() => trial.mutate()}>{trial.isPending ? 'Подключаем…' : 'Начать пробный период'}</button></footer></DocumentDialog>}</AnimatedOverlay>}
    {canManage && <section className="subscription-history"><h2>История покупок</h2>{!purchases.length ? <p>Покупок пока нет. Пробный период не требует оплаты.</p> : purchases.map(item => <article key={item.id}><PlanIcon plan={item.plan} /><div><strong>{plans[item.plan].name} · {item.kind === 'UPGRADE' ? 'повышение тарифа' : '1 месяц'}</strong><small>Тестовая активация · {new Date(item.activatedAt).toLocaleDateString('ru-RU')}</small></div><strong>{money(item.amountMinor)}</strong></article>)}</section>}
    {checkout && isPlanId(checkout) && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setCheckout(null)}>{close => <SubscriptionCheckout key={`${organization.id}:${checkout}`} organization={organization} plan={checkout} onClose={close} onBusy={setBusy} />}</AnimatedOverlay>}
    {confirmFree && <AnimatedOverlay variant="modal" dismissible={!free.isPending} onClose={() => setConfirmFree(false)}>{close => <DocumentDialog title="Перейти на Бесплатный?" eyebrow="Тариф организации" onClose={close} busy={free.isPending}><p>Доступно 5 участников, 1 точка и 250 МБ. История и файлы сохранятся. Оплаченный тариф действует до конца периода; пробный период завершится сразу.</p>{free.error && <p className="form-inline-error" role="alert">{free.error.message}</p>}<footer><button className="app-secondary" disabled={free.isPending} onClick={close}>Назад</button><button className="app-primary" disabled={free.isPending} onClick={() => free.mutate()}>Подтвердить переход</button></footer></DocumentDialog>}</AnimatedOverlay>}
  </div>
}
