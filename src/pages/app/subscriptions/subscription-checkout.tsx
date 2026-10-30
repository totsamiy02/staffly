import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { cardBrand, cardNumber, validateDemoCard } from '../../../app/subscriptions/demo-card.ts'
import { money, plans, type PaidPlanId } from '../../../app/subscriptions/plans.ts'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import { PlanIcon } from './plan-ui.tsx'
import { useSubscriptionRefresh } from '../../../app/subscriptions/queries.ts'
type Order = { id: string; plan: PaidPlanId; kind: string; amountMinor: number; periodStart: string; periodEnd: string; expiresAt: string }
const date = (value: string) => new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
export default function SubscriptionCheckout({ organization, plan, onClose, onBusy }: { organization: OrganizationSummary; plan: PaidPlanId; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const { apiRequest, user } = useAuth(), refresh = useSubscriptionRefresh(), navigate = useNavigate()
  const [nonce] = useState(() => crypto.randomUUID()), [success, setSuccess] = useState(false)
  const [fields, setFields] = useState({ number: '', expiry: '', cvc: '', holder: '', email: user?.email ?? '', confirm: false })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const form = useRef<HTMLFormElement>(null)
  const quote = useQuery({ queryKey: ['subscription-checkout', organization.id, plan, nonce], queryFn: () => apiRequest<{ order: Order }>(`/organizations/${organization.id}/subscription/checkout`, { method: 'POST', body: { plan } }), retry: false, staleTime: Infinity, gcTime: 0 })
  const purchase = useMutation({ mutationFn: () => apiRequest(`/organizations/${organization.id}/subscription/purchases/${quote.data!.order.id}/test-activation`, { method: 'POST', body: { email: fields.email.trim(), confirm: true, mode: 'test' } }), onSuccess: async () => { setFields(previous => ({ ...previous, number: '', cvc: '', expiry: '', holder: '' })); setSuccess(true); await refresh() } })
  useEffect(() => { onBusy(purchase.isPending); return () => onBusy(false) }, [purchase.isPending, onBusy])
  const order = quote.data?.order, chosen = plans[plan]
  function change(key: keyof typeof fields, value: string | boolean) { setFields(previous => ({ ...previous, [key]: value })); setErrors(previous => { const next = { ...previous }; delete next[key]; return next }) }
  function submit(event: FormEvent) {
    event.preventDefault(); if (purchase.isPending || !order) return
    const found = validateDemoCard({ ...fields, email: fields.email.trim() }); setErrors(found)
    if (Object.keys(found).length) { form.current?.querySelector<HTMLElement>(`[name="${Object.keys(found)[0]}"]`)?.focus(); return }
    purchase.mutate()
  }
  if (success && order) return <DocumentDialog title={order.kind === 'DOWNGRADE' ? 'Изменение тарифа запланировано' : `Подписка «${chosen.name}» ${order.kind === 'RENEW' ? 'продлена' : 'активирована'}`} eyebrow="Тариф организации" onClose={onClose} className="subscription-success">
    <div className="subscription-success__emblem"><PlanIcon plan={plan} /><span aria-hidden="true">✓</span></div>
    <p>Для <strong>{organization.name}</strong></p><div className="subscription-success__limits"><span>{chosen.members} участников</span><span>{chosen.locations} {chosen.locations === 3 ? 'точки' : 'точек'}</span><span>{chosen.storageLabel}</span></div>
    <p>{date(order.periodStart)} — {date(order.periodEnd)}</p><small>Тестовая покупка. Деньги не списаны.</small>
    <footer><button className="app-primary" onClick={() => { onClose(); navigate(`/app/organizations/${organization.id}`) }}>Перейти в организацию</button></footer>
  </DocumentDialog>
  return <DocumentDialog title="Подключение подписки" description="Всё готово для следующего шага вашей команды." eyebrow="Staffly · тестовое оформление" busy={purchase.isPending} onClose={onClose} className="subscription-checkout" scrollBody>
    {quote.isLoading ? <div className="app-state" role="status">Рассчитываем стоимость…</div> : quote.isError || !order ? <div className="app-state" role="alert"><p>{quote.error?.message ?? 'Заказ недоступен.'}</p><button className="app-secondary" onClick={() => void quote.refetch()}>Повторить</button></div> : <form onSubmit={submit} noValidate ref={form} aria-busy={purchase.isPending}>
      {purchase.isPending && <div className="subscription-checkout__activating" role="status"><div><PlanIcon plan={plan} /><strong>Подключаем «{chosen.name}»</strong><span>Для {organization.name}</span></div></div>}
      <div className="subscription-checkout__grid"><fieldset disabled={purchase.isPending}>
        <div className="subscription-checkout__form-heading"><h3>Данные карты</h3><span>VISA · Mastercard · МИР</span></div><p className="subscription-checkout__demo">Демонстрационный режим. <button className="subscription-text-button" type="button" onClick={() => { setFields(previous => ({ ...previous, number: '4242 4242 4242 4242', expiry: '12 / 29', cvc: '123', holder: 'TEST USER' })); setErrors({}) }}>Заполнить тестовые данные</button></p>
        <label><span>Номер карты</span><div className="subscription-card-input"><input name="number" autoComplete="off" inputMode="numeric" maxLength={19} placeholder="4242 4242 4242 4242" value={fields.number} aria-invalid={!!errors.number} aria-describedby={errors.number ? 'card-error-number' : undefined} onChange={event => change('number', cardNumber(event.target.value).replace(/(.{4})/g, '$1 ').trim())} /><span>{cardBrand(cardNumber(fields.number))}</span></div>{errors.number && <small id="card-error-number" role="alert">{errors.number}</small>}</label>
        <div className="subscription-checkout__pair"><label><span>ММ / ГГ</span><input name="expiry" autoComplete="off" inputMode="numeric" placeholder="12 / 29" maxLength={7} value={fields.expiry} aria-invalid={!!errors.expiry} onChange={event => { const digits = event.target.value.replace(/\D/g, '').slice(0, 4); change('expiry', digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits) }} />{errors.expiry && <small role="alert">{errors.expiry}</small>}</label><label><span>CVC</span><input name="cvc" type="password" autoComplete="off" inputMode="numeric" maxLength={3} placeholder="•••" value={fields.cvc} aria-invalid={!!errors.cvc} onChange={event => change('cvc', event.target.value.replace(/\D/g, '').slice(0, 3))} />{errors.cvc && <small role="alert">{errors.cvc}</small>}</label></div>
        <label><span>Имя на карте</span><input name="holder" autoComplete="off" maxLength={80} placeholder="TEST USER" value={fields.holder} aria-invalid={!!errors.holder} onChange={event => change('holder', event.target.value.toUpperCase())} />{errors.holder && <small role="alert">{errors.holder}</small>}</label>
        <label><span>Email для истории покупки</span><input name="email" type="email" autoComplete="email" maxLength={254} placeholder="demo@example.test" value={fields.email} aria-invalid={!!errors.email} onChange={event => change('email', event.target.value)} />{errors.email && <small role="alert">{errors.email}</small>}</label>
        <p className="subscription-checkout__note">Используйте только тестовые данные. Реквизиты карты не отправляются на сервер.</p>
      </fieldset><aside className="subscription-checkout__summary"><div className="subscription-checkout__plan"><PlanIcon plan={plan} /><div><small>Ваш новый тариф</small><h3>{chosen.name}</h3></div></div><p className="subscription-checkout__intro">{chosen.description}</p><div className="subscription-checkout__metrics"><span><b>{chosen.members}</b>участников</span><span><b>{chosen.locations}</b>точек</span><span><b>{chosen.storageLabel}</b>хранилища</span></div><ul className="subscription-checkout__benefits"><li>Отчёты и выгрузка Excel</li>{plan === 'BUSINESS' && <><li>Планирование и обсуждение графиков</li><li>Свои роли и права доступа</li></>}<li>Расписание, заявки и документы</li></ul><dl><dt>{order.kind === 'UPGRADE' ? 'Доплата за оставшийся срок' : order.kind === 'DOWNGRADE' ? 'Начнёт действовать' : 'Срок'}</dt><dd>{order.kind === 'DOWNGRADE' ? date(order.periodStart) : order.kind === 'UPGRADE' ? `До ${date(order.periodEnd)}` : '1 месяц'}</dd><dt>Итого</dt><dd className="subscription-checkout__total">{money(order.amountMinor)}</dd></dl><div className="subscription-checkout__organization"><span>Для организации</span><strong>{organization.name}</strong></div><small>{order.kind === 'DOWNGRADE' ? 'Без списания денег · изменение начнётся со следующего периода' : 'Без списания денег · возможности включатся сразу после подтверждения'}</small></aside></div>
      <label className="subscription-checkout__confirm"><input name="confirm" type="checkbox" checked={fields.confirm} disabled={purchase.isPending} onChange={event => change('confirm', event.target.checked)} /><span>Подтверждаю тестовую активацию для «{organization.name}». Деньги не списываются.</span></label>{errors.confirm && <p className="form-inline-error" role="alert">{errors.confirm}</p>}
      {purchase.error && <div className="form-inline-error" role="alert"><p>{purchase.error.message}</p><button type="button" className="subscription-text-button" disabled={purchase.isPending} onClick={() => { purchase.reset(); void quote.refetch() }}>Обновить условия покупки</button></div>}
      <footer><button type="button" className="app-secondary" disabled={purchase.isPending} onClick={onClose}>Назад</button><button className="app-primary" disabled={purchase.isPending}>{purchase.isPending ? 'Активируем…' : `Купить за ${money(order.amountMinor)}`}</button></footer>
    </form>}
  </DocumentDialog>
}
