import type { RequestFailure } from '../../../../app/auth/request-errors.ts'
import { useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useSubscription } from '../../../../app/subscriptions/context.ts'
import { liveQueryOptions, invalidateOrganizationWork } from '../../../../app/live-query.ts'
import { useFormSafety } from '../../../../app/forms/use-form-safety.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import {
  availabilityConfigSchema, availabilityRuleLabel, emptyAvailabilityWeek, availabilityWeekdays as weekdays,
  type AvailabilityConfig, type AvailabilityRule, type AvailabilitySave, type AvailabilityState,
} from '../../../../shared/availability.ts'
import { stableJson } from '../../../../shared/stable-json.ts'
import { displayDate, shiftTimeRange, zonedDateAndTime } from '../../../../app/schedule/date-utils.ts'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import Avatar from '../../../../component/ui/avatar/avatar.tsx'
import Select from '../../../../component/ui/select/select.tsx'
import DatePicker from '../../../../component/ui/date-picker/date-picker.tsx'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import RequestErrorMessage, { RequestErrorState } from '../../../../component/ui/request-error-message.tsx'
import EmployeePicker from '../../shared/employee-picker.tsx'
import { AvailabilityFooter, AvailabilityIcon, RuleEditor } from './availability-elements.tsx'
import ReplacementDialog from './replacement-dialog.tsx'
import { canAccess } from '../../../../app/access/catalog.ts'

type Person = { id: string; displayName: string; avatarUrl: string | null; email: string }
type Tab = 'week' | 'exceptions' | 'conflicts' | 'history'
type History = { events: Array<{ id: string; revision: number; createdAt: string; actorName: string; before: AvailabilityConfig | null; after: AvailabilityConfig }>; hasMore: boolean }

export default function AvailabilityWorkspace({ organization }: { organization: OrganizationSummary }) {
  const [params, setParams] = useSearchParams()
  const requested = params.get('availability')
  const subscription = useSubscription()
  const { apiRequest } = useAuth()
  const enabled = !!requested && subscription.available('availability')
  const list = useQuery({
    ...liveQueryOptions,
    queryKey: ['availability-members', organization.id, organization.locationId],
    queryFn: () => apiRequest<{ members: Person[] }>(`/organizations/${organization.id}/availability-members`),
    enabled,
  })
  const [selected, setSelected] = useState('')
  const own = !canAccess(organization, 'availability.view')
  const requestedId = requested === 'own' || own ? organization.viewerMemberId : requested === 'select' ? undefined : requested
  const memberId = requestedId || selected || list.data?.members[0]?.id
  const close = () => setParams(previous => {
    const next = new URLSearchParams(previous)
    next.delete('availability')
    next.delete('availabilityConflicts')
    return next
  }, { replace: true })
  if (!requested) return null
  if (!enabled) return <AnimatedOverlay variant="modal" onClose={close}>{dismiss =>
    <DocumentDialog title="Доступность сотрудников" eyebrow="Расписание" onClose={dismiss} className="availability-exception-dialog" scrollBody>
      {subscription.pending ? <p role="status">Проверяем доступ…</p> : subscription.error ? <RequestErrorState error={subscription.error} onRetry={() => subscription.refresh?.()} /> : <>
        <p className="availability-note">Доступно на тарифах «Команда» и «Бизнес».</p>
        <AvailabilityFooter onClose={dismiss} action="Возможности и лимиты" onSave={() => { dismiss(); subscription.choose('TEAM') }} />
      </>}
    </DocumentDialog>
  }</AnimatedOverlay>
  return <AvailabilityDialog
    key={`${organization.id}:${organization.locationId}:${memberId ?? 'loading'}`}
    organization={organization}
    memberId={memberId}
    own={own || requested === 'own'}
    members={list.isSuccess ? list.data.members : []}
    listError={list.error}
    retryList={() => void list.refetch()}
    onSelect={id => { setSelected(id); setParams(previous => { const next = new URLSearchParams(previous); next.set('availability', id); return next }, { replace: true }) }}
    initialTab={params.has('availabilityConflicts') ? 'conflicts' : 'week'}
    onClose={close}
  />
}

function AvailabilityDialog({ organization, memberId, own, members, listError, retryList, onSelect, initialTab, onClose }: {
  organization: OrganizationSummary
  memberId?: string
  own: boolean
  members: Person[]
  listError: unknown
  retryList: () => void
  onSelect: (id: string) => void
  initialTab: Tab
  onClose: () => void
}) {
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [draft, setDraft] = useState<{ config: AvailabilityConfig; revision: number; periodId: string } | null>(null)
  const [from, setFrom] = useState('')
  const [exception, setException] = useState<{ date: string; rule: AvailabilityRule } | null>(null)
  const [replacement, setReplacement] = useState<string | null>(null)
  const operation = useRef<{ serialized: string; payload: AvailabilitySave } | null>(null)
  const query = useQuery({
    ...liveQueryOptions,
    queryKey: ['availability', organization.id, memberId, organization.locationId],
    queryFn: () => apiRequest<AvailabilityState>(`/organizations/${organization.id}/availability/${memberId}`),
    enabled: !!memberId,
  })
  const data = query.isSuccess ? query.data : undefined
  const config = draft?.config ?? data?.config
  const today = zonedDateAndTime(new Date().toISOString(), data?.timezone ?? organization.organizationTimezone ?? organization.timezone).date
  const effective = from || config?.weeks.filter(week => week.from <= today).at(-1)?.from || today
  const currentWeek = config?.weeks.filter(week => week.from <= effective).at(-1)?.days ?? emptyAvailabilityWeek()
  const changedElsewhere = !!draft && !!data && draft.revision !== data.revision
  const save = useMutation({
    mutationFn: async () => {
      if (!data || !draft) return
      const checked = availabilityConfigSchema.safeParse(draft.config)
      if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Проверьте правила доступности.')
      const body = { employmentPeriodId: draft.periodId, revision: draft.revision, config: checked.data }
      const serialized = stableJson(body)
      if (operation.current?.serialized !== serialized) {
        operation.current = { serialized, payload: { ...body, operationId: crypto.randomUUID() } }
      }
      return apiRequest(`/organizations/${organization.id}/availability/${memberId}`, { method: 'POST', body: operation.current.payload })
    },
    onSuccess: async () => {
      setDraft(null)
      safety.markSaved()
      operation.current = null
      await invalidateOrganizationWork(client, organization.id)
      setTab('conflicts')
    },
  })
  const canRetry = save.isError && ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes((save.error as RequestFailure).code ?? '') && !!operation.current
  const safety = useFormSafety({ scope: `availability:${organization.id}:${memberId}`, value: config, dirty: !!draft, busy: save.isPending })
  const history = useQuery({
    ...liveQueryOptions,
    queryKey: ['availability-history', organization.id, memberId],
    queryFn: () => apiRequest<History>(`/organizations/${organization.id}/availability/${memberId}/history?page=1`),
    enabled: !!data && tab === 'history',
  })
  function change(next: AvailabilityConfig) {
    if (!data?.canManage) return
    setDraft({ config: next, revision: draft?.revision ?? data.revision, periodId: draft?.periodId ?? data.employmentPeriodId })
    save.reset()
  }
  function changeFrom(next: string) {
    if (!next || !config || !data?.canManage) { setFrom(next); return }
    // A new effective date starts a new version. Moving an unsaved version must
    // not leave unintended restrictions at its old date.
    const previousSaved = data.config.weeks.find(week => week.from === effective)
    const weeks = config.weeks.filter(week => week.from !== next && week.from !== effective)
    if (previousSaved && previousSaved.from !== next) weeks.push(previousSaved)
    weeks.push({ from: next, days: currentWeek })
    change({ ...config, weeks: weeks.sort((a, b) => a.from.localeCompare(b.from)) })
    setFrom(next)
  }
  function changeDay(index: number, rule: AvailabilityRule) {
    if (!config) return
    const days = currentWeek.map((item, day) => day === index ? rule : item)
    change({ ...config, weeks: [...config.weeks.filter(week => week.from !== effective), { from: effective, days }].sort((a, b) => a.from.localeCompare(b.from)) })
  }
  function discardStaleDraft() {
    void safety.close(() => {
      setDraft(null)
      save.reset()
      operation.current = null
    })
  }
  function openShift(shift: AvailabilityState['conflicts'][number], close: () => void) {
    void safety.close(() => {
      close()
      const params = new URLSearchParams({
        shift: shift.id,
        location: shift.locationId,
        month: zonedDateAndTime(shift.start, shift.timezone).date.slice(0, 7),
      })
      navigate(`/app/organizations/${organization.id}/schedule?${params}`)
    })
  }
  const title = own ? 'Моя доступность' : 'Доступность сотрудников'
  return <AnimatedOverlay variant="modal" dismissible={!save.isPending && !exception && !replacement} onClose={onClose} beforeClose={safety.confirmClose}>
    {close => <>
      <DocumentDialog title={title} eyebrow="Расписание" className="availability-dialog" scrollBody busy={save.isPending} formRef={safety.ref} onClose={close}
        footer={<AvailabilityFooter onClose={close} busy={save.isPending} disabled={!draft || !data?.canManage || (changedElsewhere && !canRetry)}
          onSave={data?.canManage ? () => save.mutate() : undefined}
          note={data?.updatedAt ? `Изменено ${new Date(data.updatedAt).toLocaleString('ru-RU', { timeZone: data.timezone, dateStyle: 'short', timeStyle: 'short' })} · ${data.updatedBy ?? 'Сотрудник'}` : 'Без ограничений, пока правила не заданы'} />}
      >
        {!own && <EmployeePicker members={members} value={memberId ?? ''} onChange={id => void safety.close(() => onSelect(id))} disabled={save.isPending} />}
        {!!listError && !own && <RequestErrorState error={listError} onRetry={retryList} />}
        {query.isPending && <p className="app-state" role="status">Загружаем доступность…</p>}
        {query.isError && <RequestErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {data && config && <>
          {own && <div className="availability-person availability-own-person">
            <Avatar url={data.avatarUrl} name={data.memberName} className="app-avatar" eager />
            <div><strong>{data.memberName}</strong><p>{organization.name}</p></div>
          </div>}
          <div className="availability-explanation"><AvailabilityIcon /><p>Когда сотрудник может работать. Правила учитываются при назначении смен и подборе замены во всех точках организации.</p></div>
          {!data.canManage && <p className="availability-note">Просмотр доступности. Изменять общие правила можно при наличии прав во всех рабочих точках сотрудника.</p>}
          {changedElsewhere && <div className="availability-stale" role="alert">
            <p>Правила уже изменились. Ваши правки сохранены в форме; перед новым сохранением загрузите актуальные данные.</p>
            <button className="app-secondary" onClick={discardStaleDraft}>Загрузить актуальные правила</button>
          </div>}
          <SegmentedNav label="Правила доступности" className="availability-tabs">
            <button aria-pressed={tab === 'week'} onClick={() => setTab('week')}>По дням недели</button>
            <button aria-pressed={tab === 'exceptions'} onClick={() => setTab('exceptions')}>Исключения · {config.exceptions.length}</button>
            <button aria-pressed={tab === 'conflicts'} onClick={() => setTab('conflicts')}>Смены · {data.conflicts.length}</button>
            <button aria-pressed={tab === 'history'} onClick={() => setTab('history')}>История</button>
          </SegmentedNav>
          {tab === 'week' && <>
            <div className="availability-period">
              <label><span>Правила действуют с</span><DatePicker value={effective} disabled={save.isPending} onChange={event => changeFrom(event.target.value)} /></label>
              <p><strong>{data.timezone}</strong><span>Часовой пояс доступности</span></p>
            </div>
            {config.weeks.length > 1 && <label className="availability-version-picker">
              <span>Сохранённые правила</span>
              <Select aria-label="Сохранённые правила"
                value={config.weeks.some(week => week.from === effective) ? effective : ''}
                onChange={event => setFrom(event.target.value)}
              >
                <option value="">Новая дата начала</option>
                {config.weeks.map(week => <option key={week.from} value={week.from}>С {displayDate(week.from)}</option>)}
              </Select>
            </label>}
            <div className="availability-week" aria-label="Доступность по дням недели">
              {weekdays.map((label, index) => <RuleEditor key={label} label={label} rule={currentWeek[index]} onChange={rule => changeDay(index, rule)} disabled={!data.canManage || save.isPending} />)}
            </div>
            <p className="availability-note">Выберите дату начала и измените нужные дни. Предыдущие правила сохранятся. Ночное время относится к дню начала; исключение на следующую дату заменяет и ночную часть этого дня.</p>
          </>}
          {tab === 'exceptions' && <>
            <div className="exception-list-heading">
              <div><h3>Отдельные даты</h3><p>Заменяют правило недели на выбранную дату.</p></div>
              {data.canManage && <button className="app-secondary" onClick={() => setException({ date: today, rule: { mode: 'OFF' } })}>+ Добавить дату</button>}
            </div>
            <div className="exception-list">
              {!config.exceptions.length && <p className="availability-note">Исключений пока нет. Используются правила недели.</p>}
              {config.exceptions.map(item => <article key={item.date}>
                <div className="exception-day"><strong>{Number(item.date.slice(8))}</strong><span>{new Date(item.date).toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' })}</span></div>
                <div className="exception-copy"><strong>{displayDate(item.date)}</strong><span>{availabilityRuleLabel(item.rule)}</span></div>
                {data.canManage && <>
                  <button className="app-secondary" onClick={() => setException(item)}>Изменить</button>
                  <button className="exception-delete" aria-label={`Удалить исключение ${displayDate(item.date)}`}
                    onClick={() => change({ ...config, exceptions: config.exceptions.filter(other => other.date !== item.date) })}
                  >×</button>
                </>}
              </article>)}
            </div>
            <p className="availability-note">{data.timezone}. Отпуска и другие отсутствия проверяются дополнительно.</p>
          </>}
          {tab === 'conflicts' && <>
            <div className="availability-conflicts-message">
              <AvailabilityIcon />
              <div>
                <strong>{data.conflicts.length ? 'Проверьте будущие смены' : 'Смен вне доступности нет'}</strong>
                <p>Изменение доступности не отменяет смены. Здесь показаны сохранённые правила; сначала сохраните правки формы.</p>
              </div>
            </div>
            <div className="availability-conflict-list">{data.conflicts.map(shift => <article key={shift.id}>
              <header><strong>{new Date(shift.start).toLocaleDateString('ru-RU', { timeZone: shift.timezone, day: 'numeric', month: 'long', weekday: 'long' })}</strong><span>{shift.locationName}</span></header>
              <div><strong>{shiftTimeRange(shift.start, shift.end, shift.timezone)}</strong><small>{shift.message}</small></div>
              <footer><button className="app-secondary" onClick={() => openShift(shift, close)}>Открыть смену</button>
                {shift.canEdit && <button className="app-primary" onClick={() => setReplacement(shift.id)}>Подобрать замену</button>}</footer>
            </article>)}</div>
          </>}
          {tab === 'history' && <>
            {history.isPending && <p role="status">Загружаем историю…</p>}
            {history.isError && <RequestErrorState error={history.error} onRetry={() => void history.refetch()} />}
            {history.isSuccess && <AvailabilityHistory key={history.data.events[0]?.id ?? 'empty'} history={history.data} timezone={data.timezone} organizationId={organization.id} memberId={data.memberId} />}
          </>}
        </>}
        {save.isError && <RequestErrorMessage error={save.error} />}
      </DocumentDialog>
      {exception && data && config && <ExceptionEditor initial={exception} timezone={data.timezone} onClose={() => setException(null)} onSave={item => {
        const others = config.exceptions.filter(other => other.date !== exception.date && other.date !== item.date)
        change({ ...config, exceptions: [...others, item].sort((a, b) => a.date.localeCompare(b.date)) })
        setException(null)
      }} />}
      {replacement && <ReplacementDialog organization={organization} shiftId={replacement} onClose={() => setReplacement(null)} onSaved={async () => { setReplacement(null); await invalidateOrganizationWork(client, organization.id) }} />}
    </>}
  </AnimatedOverlay>
}

function ExceptionEditor({ initial, timezone, onClose, onSave }: {
  initial: { date: string; rule: AvailabilityRule }
  timezone: string
  onClose: () => void
  onSave: (value: { date: string; rule: AvailabilityRule }) => void
}) {
  const [date, setDate] = useState(initial.date)
  const [rule, setRule] = useState(initial.rule)
  const [error, setError] = useState('')
  return <AnimatedOverlay variant="modal" onClose={onClose}>{close =>
    <DocumentDialog title="Исключение на дату" eyebrow="Доступность сотрудника" className="availability-exception-dialog" scrollBody onClose={close}
      footer={<AvailabilityFooter onClose={close} action="Добавить в правила" onSave={() => {
        const checked = availabilityConfigSchema.safeParse({ weeks: [], exceptions: [{ date, rule }] })
        if (!checked.success) { setError(checked.error.issues[0]?.message ?? 'Проверьте дату и время.'); return }
        onSave({ date, rule })
      }} />}
    >
      <label className="availability-field"><span>Дата</span><DatePicker value={date} onChange={event => setDate(event.target.value)} /></label>
      <div className="availability-exception-rule"><RuleEditor label="В этот день" rule={rule} onChange={setRule} /></div>
      <div className="exception-result"><AvailabilityIcon /><div><strong>{date ? displayDate(date) : 'Выберите дату'} · {availabilityRuleLabel(rule)}</strong><p>Заменяет правило недели. Изменения применятся после сохранения доступности.</p></div></div>
      <p className="availability-note">Часовой пояс: {timezone}</p>
      {error && <p className="form-inline-error" role="alert">{error}</p>}
    </DocumentDialog>
  }</AnimatedOverlay>
}

function AvailabilityHistory({ history, timezone, organizationId, memberId }: {
  history: History; timezone: string; organizationId: string; memberId: string
}) {
  const { apiRequest } = useAuth()
  const [older, setOlder] = useState<History['events']>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(history.hasMore)
  const load = useMutation({
    mutationFn: () => apiRequest<History>(`/organizations/${organizationId}/availability/${memberId}/history?page=${page + 1}`),
    onSuccess: data => { setOlder(current => [...current, ...data.events]); setPage(current => current + 1); setHasMore(data.hasMore) },
  })
  const events = [...new Map([...history.events, ...older].map(event => [event.id, event])).values()]
  return <div className="availability-history">
    {!events.length && <p className="availability-note">Доступность ещё не изменяли.</p>}
    {events.map(event => <article key={event.id}>
      <strong>Правила обновлены · версия {event.revision}</strong>
      <small>{event.actorName} · {new Date(event.createdAt).toLocaleString('ru-RU', { timeZone: timezone })}</small>
      <details><summary>Посмотреть правила</summary>
        {event.after.weeks.map(week => <section key={week.from}><strong>С {displayDate(week.from)}</strong><dl>{week.days.map((rule, index) => <div key={index}><dt>{weekdays[index]}</dt><dd>{availabilityRuleLabel(rule)}</dd></div>)}</dl></section>)}
        {event.after.exceptions.map(item => <p key={item.date}>{displayDate(item.date)} · {availabilityRuleLabel(item.rule)}</p>)}
        {!event.after.weeks.length && !event.after.exceptions.length && <p>Без ограничений.</p>}
      </details>
    </article>)}
    {hasMore && <button className="app-secondary" disabled={load.isPending} onClick={() => load.mutate()}>Показать ещё</button>}
    {load.isError && <RequestErrorMessage error={load.error} />}
  </div>
}
