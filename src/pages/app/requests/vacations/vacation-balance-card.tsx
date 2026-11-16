import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useSubscription } from '../../../../app/subscriptions/context.ts'
import { canAccess } from '../../../../app/access/catalog.ts'
import { liveQueryOptions } from '../../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import type { VacationBalance } from '../../../../shared/vacation-balance.ts'
import { vacationDays } from '../../../../shared/request-workflow.ts'
import { displayDate } from '../../../../app/schedule/date-utils.ts'
import HelpTip from '../../../../component/ui/help-tip/help-tip.tsx'
import { RequestErrorState } from '../../../../component/ui/request-error-message.tsx'
import './vacation-balances.scss'
// oxlint-disable-next-line react/only-export-components -- Shared formatting for this feature's adjacent components.
export const balanceDays = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)

export function BalanceNumbers({ balance }: { balance: VacationBalance }) {
  return <dl className="vacation-balance-numbers">
    <div>
      <dt>Остаток</dt>
      <dd>{balanceDays(balance.remaining)} <small>дн.</small>
      </dd>
    </div>
    <div>
      <dt>Запланировано</dt>
      <dd>{balanceDays(balance.reserved)} <small>дн.</small>
      </dd>
    </div>
    <div>
      <dt>Можно запланировать</dt>
      <dd className={(balance.available ?? 0) < 0 ? 'is-negative' : ''}>
        {balanceDays(balance.available)} <small>дн.</small>
      </dd>
    </div>
  </dl>
}

export function VacationBalanceCard({ balance, onHistory }: { balance: VacationBalance; onHistory?: () => void }) {
  return <section className="vacation-balance-card" aria-label="Ваш остаток отпуска">
    <header>
      <div>
        <h3>Ваш остаток отпуска<HelpTip label="Как считается остаток">Норма — {balance.annualDays} дней за 12 полных месяцев отпускного стажа. Неиспользованные дни сохраняются. Будущие согласованные отпуска резервируются отдельно. Отпуск авансом можно согласовать при отрицательном остатке.</HelpTip>
        </h3>
        <p>{balance.configured ? `На ${displayDate(balance.asOf)} · ${balance.annualDays} дн. в год` : 'Для автоматического расчёта нужна дата приёма на работу.'}
        </p>
      </div>
      {onHistory && <button type="button" className="app-secondary" onClick={onHistory}>История</button>}
    </header>
    {balance.configured ? <BalanceNumbers balance={balance} /> : <strong className="vacation-balance-unconfigured">Учёт ещё не настроен</strong>}
    <p className="vacation-balance-caption">На рассмотрении: {balanceDays(balance.pending)} дн. — в резерв пока не входят.</p>
  </section>
}
export default function VacationBalancePreview({ organization, memberId, startDate, endDate, requestId }: {
  organization: OrganizationSummary
  memberId?: string
  startDate: string
  endDate: string
  requestId?: string
}) {
  const { apiRequest, locationId } = useAuth()
  const subscription = useSubscription()
  const permitted = !memberId || memberId === organization.viewerMemberId || canAccess(organization, 'vacations.balances.view')
  const available = !subscription.pending && !subscription.error && subscription.available('vacationBalances') && permitted
  const query = useQuery({
    ...liveQueryOptions,
    queryKey: ['vacation-balance', organization.id, memberId, locationId, requestId, startDate, endDate],
    enabled: available && !!startDate && !!endDate && startDate <= endDate,
    queryFn: () => apiRequest<{ balance: VacationBalance; days?: number; availableAfterApproval?: number | null }>(`/organizations/${organization.id}/vacation-balance?${new URLSearchParams({
      ...(memberId ? { memberId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(startDate && endDate && startDate <= endDate ? { startDate, endDate } : {})
    })}`),
  })
  if (!available || !startDate || !endDate || startDate > endDate) return null
  if (query.isLoading) return <p className="vacation-balance-caption" role="status">Рассчитываем остаток отпуска…</p>
  if (query.isError) return <RequestErrorState error={query.error} onRetry={() => void query.refetch()} />
  const balance = query.data?.balance
  if (!balance) return null
  if (!balance.configured) return <p className="vacation-balance-unconfigured">Остаток ещё не настроен. Подать и согласовать заявку можно.</p>
  if (!startDate || !endDate || endDate < startDate) return null
  const requested = query.data?.days ?? vacationDays(startDate, endDate)
  const after = query.data?.availableAfterApproval ?? Math.round(((balance.available ?? 0) - requested) * 100) / 100
  return <section className="vacation-balance-preview" aria-label="Расчёт остатка отпуска">
    <h3>Остаток отпуска</h3>
    <p>На {displayDate(balance.asOf)}: {balanceDays(balance.remaining)} дн. · Запланировано: {balanceDays(balance.reserved)} дн.</p>
    <dl className="vacation-balance-numbers">
      <div>
        <dt>Доступно сейчас</dt>
        <dd>{balanceDays(balance.available)} <small>дн.</small>
        </dd>
      </div>
      <div>
        <dt>Запрашивается</dt>
        <dd>{balanceDays(requested)} <small>дн.</small>
        </dd>
      </div>
      <div>
        <dt>После согласования</dt>
        <dd className={after < 0 ? 'is-negative' : ''}>
          {balanceDays(after)} <small>дн.</small>
        </dd>
      </div>
    </dl>
    {after < 0 && <p className="vacation-balance-warning">Запрос превышает доступный остаток на {balanceDays(-after)} дн. Отпуск можно согласовать авансом.</p>}
    <small>Расчёт из текущего остатка; будущие начисления здесь не прибавляются. Заявки на рассмотрении резерв не уменьшают.</small>
  </section>
}
