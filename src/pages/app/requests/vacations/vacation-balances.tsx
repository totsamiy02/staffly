import { useEffect, useId, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useSubscription } from '../../../../app/subscriptions/context.ts'
import { canAccess } from '../../../../app/access/catalog.ts'
import { invalidateOrganizationWork, liveQueryOptions } from '../../../../app/live-query.ts'
import { useLocations } from '../../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import type { VacationBalance, VacationBalanceRow, VacationBalanceHistoryItem } from '../../../../shared/vacation-balance.ts'
import { calculateVacationBalance, addVacationDays } from '../../../../shared/vacation-balance.ts'
import { displayDate, zonedDateAndTime } from '../../../../app/schedule/date-utils.ts'
import { useFormSafety } from '../../../../app/forms/use-form-safety.ts'
import MemberAvatar from '../../../../component/ui/member-avatar.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DatePicker from '../../../../component/ui/date-picker/date-picker.tsx'
import Select from '../../../../component/ui/select/select.tsx'
import { RequestErrorState } from '../../../../component/ui/request-error-message.tsx'
import { LockBadge } from '../../subscriptions/plan-ui.tsx'
import { BalanceNumbers, VacationBalanceCard, balanceDays } from './vacation-balance-card.tsx'
import './vacation-balances.scss'

type Pagination = { page: number; pages: number; total: number }

type List = { members: VacationBalanceRow[]; standardDays: number; pagination: Pagination }

type History = { balance: VacationBalance; items: VacationBalanceHistoryItem[]; pagination: Pagination }
export default function VacationBalances({ organization, header }: { organization: OrganizationSummary; header?: (action: ReactNode) => ReactNode }) {
  const { apiRequest, locationId, user } = useAuth()
  const subscription = useSubscription()
  const [opened, setOpened] = useState(false)
  const available = !subscription.pending && !subscription.error && subscription.available('vacationBalances')
  const manage = canAccess(organization, 'vacations.balances.view')
  const canReadOwn = canAccess(organization, 'requests.own') || manage
  const ownAvailable = available && canReadOwn
  const [ownHistory, setOwnHistory] = useState(false)
  useEffect(() => {
    if (!available || !manage) setOpened(false)
    if (!ownAvailable) setOwnHistory(false)
  }, [available, manage, ownAvailable])
  const own = useQuery({
    ...liveQueryOptions,
    queryKey: ['vacation-balance', organization.id, 'own', locationId],
    enabled: ownAvailable,
    queryFn: () => apiRequest<{ balance: VacationBalance }>(`/organizations/${organization.id}/vacation-balance`),
  })
  const ownRow: VacationBalanceRow | null = ownAvailable && own.isSuccess && own.data && organization.viewerMemberId ? {
    memberId: organization.viewerMemberId,
    name: user?.displayName ?? 'Ваш остаток отпуска',
    avatarUrl: user?.avatarUrl ?? null,
    positions: [],
    locations: [],
    canManage: canAccess(organization, 'vacations.balances.manage'),
    balance: own.data.balance,
  } : null
  const action = manage ? <button
    type="button"
    className="app-secondary"
    disabled={subscription.pending || !!subscription.error}
    onClick={() => {
      if (available) setOpened(true)
      else subscription.request({ feature: 'vacationBalances' })
    }}
  >Остатки сотрудников {!subscription.pending && !subscription.error && !available && <LockBadge plan="BUSINESS" />}
  </button> : null
  return <>
    {header ? header(action) : action}
    {canReadOwn && subscription.error && <RequestErrorState error={subscription.error} onRetry={() => subscription.refresh?.()} />}
    {ownAvailable && own.isLoading && <p role="status" className="vacation-balance-caption">Рассчитываем остаток…</p>}
    {ownAvailable && own.isError && <RequestErrorState error={own.error} onRetry={() => void own.refetch()} />}
    {ownAvailable && own.isSuccess && own.data && <VacationBalanceCard balance={own.data.balance} onHistory={ownRow ? () => setOwnHistory(true) : undefined} />}
    {available && manage && opened && <BalanceWorkspace organization={organization} onClose={() => setOpened(false)} />}
    {ownAvailable && ownHistory && ownRow && <BalanceWorkspace organization={organization} initialMember={ownRow} onClose={() => setOwnHistory(false)} />}
  </>
}

function Pages({ pagination, onPage }: { pagination: Pagination; onPage: (page: number) => void }) {
  if (pagination.pages <= 1) return null
  return <nav className="members-pagination" aria-label="Страницы остатков">
    <button className="app-secondary" disabled={pagination.page === 1} onClick={() => onPage(pagination.page - 1)}>Назад</button>
    <span>{pagination.page} / {pagination.pages}
    </span>
    <button
      className="app-secondary"
      disabled={pagination.page >= pagination.pages}
      onClick={() => onPage(pagination.page + 1)}
    >Далее</button>
  </nav>
}

function BalanceWorkspace({ organization, initialMember, onClose }: { organization: OrganizationSummary; initialMember?: VacationBalanceRow; onClose: () => void }) {
  const { apiRequest, locationId } = useAuth()
  const [search, setSearch] = useState(''), [point, setPoint] = useState(''), [state, setState] = useState('all'), [page, setPage] = useState(1)
  const [member, setMember] = useState(initialMember ?? null), [historyPage, setHistoryPage] = useState(1)
  const [editor, setEditor] = useState<VacationBalanceRow | null>(null)
  const canEdit = canAccess(organization, 'vacations.balances.manage')
  useEffect(() => {
    if (!canEdit) setEditor(null)
  }, [canEdit])
  const locations = useLocations(organization.id)
  const list = useQuery({
    ...liveQueryOptions,
    queryKey: ['vacation-balances', organization.id, search, point, state, page, locationId],
    enabled: !initialMember,
    queryFn: () => apiRequest<List>(`/organizations/${organization.id}/vacation-balances?${new URLSearchParams({ search, state, page: String(page), ...(point ? { locationId: point } : {}) })}`),
  })
  const history = useQuery({
    ...liveQueryOptions,
    queryKey: ['vacation-balance-history', organization.id, member?.memberId, historyPage, locationId],
    enabled: !!member,
    queryFn: () => apiRequest<History>(`/organizations/${organization.id}/vacation-balances/${member!.memberId}/history?page=${historyPage}`),
  })
  const current = member && history.data ? { ...member, balance: history.data.balance } : member
  if (editor && canEdit) return <BalanceEditor
    key={editor.memberId}
    organization={organization}
    member={editor}
    standardDays={list.data?.standardDays ?? editor.balance.annualDays}
    onClose={() => setEditor(null)}
  />
  return <AnimatedOverlay variant="modal" onClose={onClose}>
    {close => <DocumentDialog
      title={member ? 'История остатка отпуска' : 'Остатки отпусков'}
      eyebrow="Отпуска"
      onClose={close}
      className={`vacation-balances-dialog${member ? ' vacation-balances-dialog--history' : ''}`}
      scrollBody
      description={member ? undefined : 'Остаток общий для сотрудника во всей организации. Перевод в другую точку его не меняет.'}
      footer={<footer>{member && !initialMember && <button className="app-secondary" onClick={() => setMember(null)}>К списку сотрудников</button>}<button className="app-secondary" onClick={close}>Закрыть</button>
      </footer>}
    >
      {member ? <>
        <div className="vacation-balance-person">
          <MemberAvatar memberId={member.memberId} url={member.avatarUrl} name={member.name} className="app-avatar" />
          <div>
            <strong>{member.name}
            </strong>
            <small>{member.positions.join(', ')}
              {member.locations.length ? ` · ${member.locations.map(item => item.name).join(', ')}` : ''}
            </small>
          </div>
          {canEdit && current?.canManage && history.isSuccess && <button className="app-secondary" onClick={() => setEditor(current)}>
            {current.balance.configured ? 'Скорректировать' : 'Начать учёт'}
          </button>}
        </div>
        {history.isLoading ? <p role="status" className="app-state">Загружаем историю…</p> : history.isError ? <RequestErrorState error={history.error} onRetry={() => void history.refetch()} /> : history.data && <>
          {history.data.balance.configured && <>
            <BalanceNumbers balance={history.data.balance} />
            <p className="vacation-balance-caption">Норма: {history.data.balance.annualDays} дн./год · Стаж: {history.data.balance.serviceMonths} полных мес. · Начислено{history.data.balance.openingDate ? ' после переноса' : ''}: {balanceDays(history.data.balance.accrued)} дн. · Исключено из стажа: {history.data.balance.excludedDays} дн.</p>
            <p className="vacation-balance-caption">{history.data.balance.openingDate && <>Перенесено на {displayDate(history.data.balance.openingDate)}: {balanceDays(history.data.balance.openingBalance)} дн. · Использовано после переноса: {balanceDays(history.data.balance.used)} дн. </>}Начисления рассчитываются автоматически за полные месяцы стажа. Повторный приём требует нового учёта; история прежнего периода сохраняется.</p>
          </>}
          <div className="vacation-balance-history">{history.data.items.length ? history.data.items.map(item => <article key={item.id}>
            <header>
              <strong>{item.title}
              </strong>{item.amount !== null && <span className="vacation-balance-chip">{item.type === 'ADJUSTMENT' && item.amount > 0 ? '+' : ''}
                {balanceDays(item.amount)} дн.</span>}
            </header>
            <p className="vacation-balance-caption">{item.type === 'ACCRUAL' ? displayDate(item.date.slice(0, 10)) : new Date(item.date).toLocaleString('ru-RU', { timeZone: organization.organizationTimezone ?? organization.timezone })} · {item.actor}
            </p>
            <p>{item.reason}
            </p>
            {item.before !== undefined && item.before !== null && item.after !== undefined && <small>Остаток: {balanceDays(item.before)} → {balanceDays(item.after)} дн.</small>}
            {item.requestId && <Link
              className="app-secondary"
              onClick={close}
              to={`/app/organizations/${organization.id}/requests?tab=${canAccess(organization, 'requests.view') ? 'history' : 'mine'}&request=${item.requestId}`}
            >Открыть отпуск</Link>}
          </article>) : <p className="app-state">Учёт ещё не настроен. Дату приёма укажет сотрудник с правом управления остатками.</p>}
          </div>
          <Pages pagination={history.data.pagination} onPage={setHistoryPage} />
        </>}
      </> : <>
        <div className="vacation-balance-filters">
          <label>
            <span>Поиск сотрудника</span>
            <input
              type="search"
              placeholder="Имя или рабочая почта"
              value={search}
              onChange={event => {
                setSearch(event.target.value)
                setPage(1)
              }}
            />
          </label>
          <label>
            <span>Рабочая точка</span>
            <Select value={point} onChange={event => {
              setPoint(event.target.value)
              setPage(1)
            }}>
              <option value="">Все доступные точки</option>{locations.data?.locations.filter(item => !item.archivedAt && (organization.owner || item.permissions?.includes('vacations.balances.view'))).map(item => <option value={item.id} key={item.id}>
                {item.name}
              </option>)}
            </Select>
          </label>
          <label>
            <span>Остатки</span>
            <Select value={state} onChange={event => {
              setState(event.target.value)
              setPage(1)
            }}>
              <option value="all">Все остатки</option>
              <option value="unconfigured">Учёт не настроен</option>
              <option value="available">Есть доступные дни</option>
              <option value="exceeded">С превышением</option>
            </Select>
          </label>
        </div>
        {list.isLoading ? <p className="app-state" role="status">Рассчитываем остатки…</p> : list.isError ? <RequestErrorState error={list.error} onRetry={() => void list.refetch()} /> : list.data && <>
          <div className="vacation-balance-table">
            <table>
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Остаток</th>
                  <th>Запланировано</th>
                  <th>На рассмотрении</th>
                  <th>Доступно</th>
                  <th>
                    <span className="visually-hidden">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>{list.data.members.map(row => <tr key={row.memberId}>
                <td data-label="Сотрудник">
                  <div className="vacation-balance-person">
                    <MemberAvatar memberId={row.memberId} url={row.avatarUrl} name={row.name} className="app-avatar" />
                    <div>
                      <strong>{row.name}
                      </strong>
                      <small>{row.positions.join(', ')} · {row.locations.map(item => item.name).join(', ')}
                      </small>
                    </div>
                  </div>
                </td>
                <td data-label="Остаток">{balanceDays(row.balance.remaining)}
                </td>
                <td data-label="Запланировано">{row.balance.reserved}
                </td>
                <td data-label="На рассмотрении">{row.balance.pending}
                </td>
                <td data-label="Доступно">{row.balance.configured ? <strong className={(row.balance.available ?? 0) < 0 ? 'is-negative' : ''}>
                  {balanceDays(row.balance.available)}
                </strong> : <span className="vacation-balance-chip">Не настроен</span>}
                </td>
                <td>
                  <div className="vacation-balance-row-actions">
                    <button
                      className="app-secondary"
                      aria-label={`История: ${row.name}`}
                      onClick={() => {
                        setMember(row)
                        setHistoryPage(1)
                      }}
                    >История</button>
                    {canEdit && row.canManage && <button
                      className="app-secondary"
                      aria-label={`${row.balance.configured ? 'Изменить' : 'Начать учёт'}: ${row.name}`}
                      onClick={() => setEditor(row)}
                    >
                      {row.balance.configured ? 'Изменить' : 'Начать учёт'}
                    </button>}
                  </div>
                </td>
              </tr>)}
              </tbody>
            </table>
          </div>
          {!list.data.members.length && <p className="app-state">По этим условиям сотрудников нет.</p>}
          <p className="vacation-balance-caption">На рассмотрении — справочная сумма, она не вычитается из доступных дней.</p>
          <Pages pagination={list.data.pagination} onPage={setPage} />
        </>}
      </>}
    </DocumentDialog>}
  </AnimatedOverlay>
}

function BalanceEditor({ organization, member, standardDays, onClose }: { organization: OrganizationSummary; member: VacationBalanceRow; standardDays: number; onClose: () => void }) {
  const { apiRequest } = useAuth(), client = useQueryClient()
  const formId = useId()
  const setup = !member.balance.configured
  const today = zonedDateAndTime(new Date().toISOString(), organization.organizationTimezone ?? organization.timezone).date
  const [start, setStart] = useState(setup ? '' : member.balance.employmentStartDate ?? ''), [annual, setAnnual] = useState(setup ? standardDays : member.balance.annualDays)
  const [importing, setImporting] = useState(false), [openingDate, setOpeningDate] = useState(today), [opening, setOpening] = useState('')
  const [operation, setOperation] = useState('ADD'), [amount, setAmount] = useState(''), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [key] = useState(() => crypto.randomUUID())
  const safety = useFormSafety({
    scope: `vacation-balance:${organization.id}:${member.memberId}`,
    value: { start, annual, importing, openingDate, opening, operation, amount, reason },
    busy
  })
  const preview = setup && start && start <= today ? calculateVacationBalance({
    asOf: today,
    standardDays: annual,
    account: { id: '', revision: 1, employmentStartDate: start, annualDays: annual }
  }).accrued : null
  const delta = (operation === 'SUBTRACT' ? -1 : 1) * Number(amount || 0)
  const result = (member.balance.remaining ?? 0) + delta
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = setup ? {
        submissionKey: key,
        employmentStartDate: start,
        annualDays: annual,
        reason: reason.trim() || 'Начало автоматического учёта',
        ...(importing ? { openingDate, openingDays: Number(opening) } : {})
      }
        : {
          submissionKey: key,
          revision: member.balance.revision,
          reason,
          ...(operation === 'POLICY' ? { kind: 'POLICY', annualDays: annual } : operation === 'EMPLOYMENT' ? { kind: 'EMPLOYMENT', employmentStartDate: start } : { kind: 'ADJUSTMENT', amount: delta })
        }
      await apiRequest(`/organizations/${organization.id}/vacation-balances/${member.memberId}${setup ? '' : '/changes'}`, { method: 'POST', body })
      safety.markSaved()
      await invalidateOrganizationWork(client, organization.id)
      onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить изменение.') }
    finally { setBusy(false) }
  }
  return <AnimatedOverlay variant="modal" beforeClose={safety.confirmClose} dismissible={!busy} onClose={onClose}>
    {close => <DocumentDialog
      title={setup ? 'Начать учёт отпуска' : 'Изменить остаток отпуска'}
      eyebrow="Отпуска"
      onClose={close}
      busy={busy}
      className="vacation-balance-editor"
      scrollBody
      footer={<footer>
        <button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button>
        <button type="submit" form={formId} className="app-primary" disabled={busy}>
          {busy ? 'Сохраняем…' : setup ? 'Начать учёт' : 'Сохранить изменение'}
        </button>
      </footer>}
    >
      <form id={formId} onSubmit={save}>
        <div className="vacation-balance-person">
          <MemberAvatar memberId={member.memberId} url={member.avatarUrl} name={member.name} className="app-avatar" />
          <div>
            <strong>{member.name}
            </strong>
            <small>{member.positions.join(', ')} · {member.locations.map(item => item.name).join(', ')}
            </small>
          </div>
        </div>
        {setup ? <>
          <p className="vacation-balance-caption">Укажите дату приёма на работу. Норма подставлена из настроек; далее дни начисляются автоматически за полные месяцы отпускного стажа.</p>
          <div className="vacation-balance-fields">
            <label>
              <span>Дата приёма на работу</span>
              <DatePicker required min="1900-01-01" max={today} value={start} onChange={event => setStart(event.target.value)} />
            </label>
            <label>
              <span>Норма, дней в год</span>
              <input
                type="number"
                min={28}
                max={366}
                required
                value={annual}
                onChange={event => setAnnual(Number(event.target.value))}
              />
            </label>
          </div>
          {preview !== null && <p className="vacation-balance-caption">По указанной дате начислено: <strong>{balanceDays(preview)} дн.</strong> Использованные отпуска и периоды, исключённые из стажа, система учтёт при сохранении.</p>}
          <label className="vacation-balance-check">
            <input type="checkbox" checked={importing} onChange={event => setImporting(event.target.checked)} />
            <span>Перенести остаток из прежнего учёта</span>
          </label>
          {importing && <section className="vacation-balance-import">
            <p>Используйте, если прежние начисления и отпуска не полностью внесены в Staffly. Указанный остаток уже должен учитывать отпуска по выбранную дату включительно.</p>
            <div className="vacation-balance-fields">
              <label>
                <span>На дату</span>
                <DatePicker
                  required
                  min={start || '1900-01-01'}
                  max={today}
                  value={openingDate}
                  onChange={event => setOpeningDate(event.target.value)}
                />
              </label>
              <label>
                <span>Сколько дней осталось</span>
                <input
                  type="number"
                  step="0.01"
                  min={-10000}
                  max={10000}
                  required
                  value={opening}
                  onChange={event => setOpening(event.target.value)}
                />
              </label>
            </div>
          </section>}
        </> : <>
          <BalanceNumbers balance={member.balance} />
          <label>
            <span>Операция</span>
            <Select value={operation} onChange={event => setOperation(event.target.value)}>
              <option value="ADD">Добавить дни</option>
              <option value="SUBTRACT">Вычесть дни</option>
              <option value="POLICY">Изменить годовую норму</option>
              <option value="EMPLOYMENT">Уточнить дату приёма</option>
            </Select>
          </label>
          {operation === 'EMPLOYMENT' ? <label>
            <span>Дата приёма на работу</span>
            <DatePicker
              required
              min="1900-01-01"
              max={member.balance.openingDate ?? today}
              value={start}
              onChange={event => setStart(event.target.value)}
            />
            <small>Начисления пересчитаются. Прежняя дата и причина изменения сохранятся в истории.</small>
          </label> : operation === 'POLICY' ? <label>
            <span>Новая норма, дней в год</span>
            <input
              type="number"
              required
              min={28}
              max={366}
              value={annual}
              onChange={event => setAnnual(Number(event.target.value))}
            />
            <small>С {displayDate(addVacationDays(today, 1))}. Уже выполненные начисления сохранятся.</small>
          </label>
            : <label>
              <span>Количество дней</span>
              <input
                type="number"
                required
                min={0.01}
                max={10000}
                step="0.01"
                value={amount}
                onChange={event => setAmount(event.target.value)}
              />
            </label>}
          {['ADD', 'SUBTRACT'].includes(operation) && <p className="vacation-balance-result">После изменения: <strong>{balanceDays(result)} дн.</strong> · Можно запланировать: <strong>{balanceDays(result - member.balance.reserved)} дн.</strong>
          </p>}
        </>}
        <label>
          <span>{setup ? importing ? 'Основание переноса' : 'Комментарий' : 'Причина изменения'}
          </span>
          <textarea
            required={!setup || importing}
            minLength={3}
            maxLength={1000}
            rows={3}
            value={reason}
            onChange={event => setReason(event.target.value)}
            placeholder={setup && importing ? 'Например, по данным бухгалтерии' : undefined}
          />
        </label>
        <p className="vacation-balance-caption">Автор и время сохранятся в истории автоматически.</p>
        {error && <p className="form-inline-error" role="alert">{error}
        </p>}
      </form>
    </DocumentDialog>}
  </AnimatedOverlay>
}
