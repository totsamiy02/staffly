import { plans, planIds, money, type PlanId } from '../../../app/subscriptions/plans.ts'
import { useEffect, useRef } from 'react'
import './subscriptions.scss'
export function PlanIcon({ plan, className = '' }: { plan: PlanId; className?: string }) {
  return <span className={`plan-icon plan-icon--${plan.toLowerCase()} ${className}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{plan === 'BUSINESS' ? <path d="m12 2 3.3 6.7L22 12l-6.7 3.3L12 22l-3.3-6.7L2 12l6.7-3.3L12 2Z" /> : <><circle cx="9" cy="7" r="3" /><path d="M3 21v-4a6 6 0 0 1 12 0v4" />{plan === 'TEAM' && <><path d="M17 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 4v4" /></>}</>}</svg></span>
}
export function PlanBadge({ plan, trial = false }: { plan: PlanId; trial?: boolean }) { return <span className={`plan-badge plan-badge--${plan.toLowerCase()}`}><PlanIcon plan={plan} />{plans[plan].name}{trial ? ' · пробный' : ''}</span> }
export function LockBadge({ plan }: { plan: PlanId }) { return <span className="plan-lock"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="3" y="7" width="10" height="8" rx="2" /><path d="M5 7V4a3 3 0 0 1 6 0v3" /></svg>{plans[plan].name}</span> }
export function PlanCards({ current, onChoose, busy = false, trialAvailable = false, onTrial }: { current?: PlanId; onChoose: (plan: PlanId) => void; busy?: boolean; trialAvailable?: boolean; onTrial?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = host.current
    if (!element || typeof IntersectionObserver === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { element.classList.add('subscription-plans--enter'); observer.disconnect() } }, { threshold: .08 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <div className="subscription-plans" ref={host}>{planIds.map(id => { const plan = plans[id]; return <article className={`subscription-plan${id === 'TEAM' ? ' subscription-plan--featured' : ''}`} key={id}>
    {id === 'TEAM' && <span className="subscription-plan__recommended">Для ежедневной работы</span>}
    <div className="subscription-plan__title"><div><h3>{plan.name}</h3><p>{plan.description}</p></div><PlanIcon plan={id} /></div>
    <p className="subscription-plan__price">{money(plan.priceMinor)}<small>/ месяц</small></p>
    <ul><li>{plan.members} участников, включая владельца</li><li>{plan.locations} {plan.locations === 1 ? 'точка' : plan.locations === 3 ? 'точки' : 'точек'}</li><li>{plan.storageLabel} хранилища</li></ul>
    <ul className="subscription-plan__features"><li>Расписание, заявки и события</li><li>Документы и ознакомления</li>{id !== 'FREE' && <li>Отчёты и выгрузка Excel</li>}{id === 'BUSINESS' && <><li>Свои роли и разрешения</li><li>Расширенное планирование</li></>}</ul>
    <div className="subscription-plan__actions">{id === 'BUSINESS' && trialAvailable && onTrial && <><button className="subscription-trial-button" disabled={busy} onClick={onTrial}>Попробовать 14 дней бесплатно</button><small>Один раз для этой организации · без карты</small></>}<button className={id === 'TEAM' ? 'app-primary' : 'app-secondary'} disabled={busy || current === id && id === 'FREE'} onClick={() => onChoose(id)}>{current === id ? id === 'FREE' ? 'Текущий тариф' : 'Продлить подписку' : id === 'FREE' ? 'Выбрать бесплатный' : `Выбрать ${plan.name === 'Команда' ? 'Команду' : 'Бизнес'}`}</button></div>
  </article> })}</div>
}
