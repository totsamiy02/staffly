import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { invalidateOrganizationWork, liveQueryOptions } from '../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import type { ExitCandidate, SelfExitWork } from '../../../shared/self-exit.ts'
import { displayDate, shiftTimeRange } from '../../../app/schedule/date-utils.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import RequestErrorMessage, { RequestErrorState } from '../../../component/ui/request-error-message.tsx'
import './self-exit.scss'
import './self-exit-work.scss'

type Selection = { id: string; kind: 'shift' | 'task'; updatedAt: string }

export default function SelfExitWorkspace({ organization }: { organization: OrganizationSummary }) {
  const [params, setParams] = useSearchParams()
  const exitId = params.get('selfExit')
  if (!exitId || !/^[0-9a-f-]{36}$/i.test(exitId)) return null
  return <ExitWorkDialog
    key={exitId}
    organization={organization}
    exitId={exitId}
    onClose={() => {
      setParams(previous => { const next = new URLSearchParams(previous); next.delete('selfExit'); return next }, { replace: true })
    }}
  />
}

function ExitWorkDialog({ organization, exitId, onClose }: { organization: OrganizationSummary; exitId: string; onClose: () => void }) {
  const { apiRequest, locationId } = useAuth()
  const client = useQueryClient()
  const [tab, setTab] = useState<'shifts' | 'tasks'>('shifts')
  const [selection, setSelection] = useState<Selection | null>(null)
  const query = useQuery({
    ...liveQueryOptions,
    queryKey: ['self-exit-work', organization.id, exitId, locationId],
    queryFn: () => apiRequest<SelfExitWork>(`/organizations/${organization.id}/self-exits/${exitId}`),
  })
  const data = query.isSuccess ? query.data : undefined
  const refresh = () => invalidateOrganizationWork(client, organization.id)
  const cancel = useMutation({
    mutationFn: (shift: SelfExitWork['shifts'][number]) => apiRequest(`/organizations/${organization.id}/self-exits/${exitId}/shifts/${shift.id}`, {
      method: 'POST',
      body: { updatedAt: shift.updatedAt, reason: 'Сотрудник покинул организацию. Смена больше не требуется.' },
    }),
    onSuccess: refresh,
  })
  const chosen = selection && data ? selection.kind === 'shift'
    ? data.shifts.find(shift => shift.id === selection.id && shift.canAssign)
    : data.tasks.find(task => task.id === selection.id && task.kind === 'TASK' && task.canAssign) : null
  useEffect(() => {
    if (selection && (query.isError || data && !chosen)) setSelection(null)
  }, [selection, query.isError, data, chosen])
  return <AnimatedOverlay variant="modal" dismissible={!cancel.isPending && !chosen} onClose={onClose}>
    {close => <>
      <DocumentDialog
        title="После выхода сотрудника"
        eyebrow="Требует внимания"
        className="left-shifts-dialog"
        scrollBody
        busy={cancel.isPending}
        onClose={close}
        footer={<footer className="self-leave-footer">
          <button className="app-secondary" disabled={cancel.isPending} onClick={close}>Закрыть</button>
        </footer>}
      >
        {query.isPending && <p className="self-exit-loading" role="status">Загружаем рабочие назначения…</p>}
        {query.isError && <RequestErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {data && <>
          <div className="leave-identity">
            <Avatar url={data.memberAvatarUrl} name={data.memberName} className="app-avatar" eager />
            <div>
              <strong>
                {data.memberName}
              </strong>
              <p>Покинул организацию · {new Date(data.createdAt).toLocaleString('ru-RU', { timeZone: organization.timezone })}</p>
            </div>
          </div>
          <p className="leave-intro">Передайте оставшиеся назначения действующим сотрудникам.</p>
          {!data.shifts.length && !data.tasks.length ? <p className="self-exit-empty" role="status">Все доступные рабочие назначения обработаны.</p> : <>
            <SegmentedNav className="remaining-tabs" label="Рабочие назначения">
              <button aria-pressed={tab === 'shifts'} onClick={() => setTab('shifts')}>Смены · {data.shifts.length}</button>
              <button aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>Задачи · {data.tasks.length}</button>
            </SegmentedNav>
            {tab === 'shifts' ? <div className="left-shifts-list">
              {!data.shifts.length && <p className="self-exit-empty">Смен, требующих замены, нет.</p>}
              {data.shifts.map(shift => <article key={shift.id}>
                <header>
                  <strong>
                    {new Date(shift.startAt).toLocaleDateString('ru-RU', { timeZone: shift.timezone, day: 'numeric', month: 'long', weekday: 'long' })}
                  </strong>
                  <span className="needs-replacement">Нужна замена</span>
                </header>
                <div className="remaining-shift-info">
                  <strong>
                    {shiftTimeRange(shift.startAt, shift.endAt, shift.timezone)}
                  </strong>
                  <small>{shift.positionName ?? 'Рабочая смена'} · {shift.locationName}</small>
                </div>
                <footer>
                  {shift.canAssign && <button
                    className="app-primary"
                    disabled={cancel.isPending}
                    onClick={() => setSelection({ kind: 'shift', id: shift.id, updatedAt: shift.updatedAt })}
                  >Подобрать замену</button>}
                  {shift.canCancel && <button className="app-secondary" disabled={cancel.isPending} onClick={() => cancel.mutate(shift)}>Отменить смену</button>}
                </footer>
              </article>)}
            </div> : <div className="left-shifts-list remaining-task-list">
              {!data.tasks.length && <p className="self-exit-empty">Назначений без исполнителя нет.</p>}
              {data.tasks.map(task => <article key={task.id}>
                <header>
                  <strong>
                    {task.title}
                  </strong>
                  <span className="needs-replacement">
                    {task.kind === 'REVIEW' ? 'Без согласующего' : 'Без исполнителя'}
                  </span>
                </header>
                <p>{task.kind === 'REVIEW' ? 'Согласование заявки' : 'Задача по заявке'} · {task.locationName}</p>
                <p>
                  {task.deadline ? `Срок: ${displayDate(task.deadline)}` : 'Без срока'}
                </p>
                <footer>
                  {task.canAssign && task.kind === 'TASK' && <button
                    className="app-primary"
                    disabled={cancel.isPending}
                    onClick={() => setSelection({ kind: 'task', id: task.id, updatedAt: task.updatedAt })}
                  >Назначить исполнителя</button>}
                  <Link
                    className="app-secondary"
                    to={`/app/organizations/${organization.id}/requests?tab=mine&request=${task.id}&location=${task.locationId}`}
                  >Открыть заявку</Link>
                </footer>
              </article>)}
            </div>}
          </>}
        </>}
        {cancel.isError && <div className="self-exit-error" role="alert">
          <RequestErrorMessage error={cancel.error} />
          <button className="app-secondary" onClick={() => void refresh()}>Обновить список</button>
        </div>}
      </DocumentDialog>
      {selection && chosen && <ExitAssigneePicker
        organizationId={organization.id}
        exitId={exitId}
        selection={selection}
        locationName={chosen.locationName}
        onClose={() => setSelection(null)}
        onSaved={async () => { setSelection(null); await refresh() }}
      />}
    </>}
  </AnimatedOverlay>
}

function ExitAssigneePicker({ organizationId, exitId, selection, locationName, onClose, onSaved }: {
  organizationId: string; exitId: string; selection: Selection; locationName: string
  onClose: () => void; onSaved: () => Promise<void>
}) {
  const { apiRequest } = useAuth()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [memberId, setMemberId] = useState('')
  const [acknowledgeWorkload, setAcknowledgeWorkload] = useState(false)
  const base = `/organizations/${organizationId}/self-exits/${exitId}`
  const query = useQuery({
    ...liveQueryOptions,
    queryKey: ['self-exit-candidates', organizationId, exitId, selection.kind, selection.id, search, page],
    queryFn: () => apiRequest<{ candidates: ExitCandidate[]; hasMore: boolean }>(`${base}/${selection.id}/candidates?${new URLSearchParams({ kind: selection.kind, search, page: String(page) })}`),
  })
  const mutation = useMutation({
    mutationFn: () => apiRequest(`${base}/${selection.kind === 'shift' ? 'shifts' : 'tasks'}/${selection.id}`, {
      method: 'POST',
      body: { memberId, updatedAt: selection.updatedAt, ...(selection.kind === 'shift' ? { acknowledgeWorkload } : {}) },
    }),
    onSuccess: onSaved,
  })
  const warning = (mutation.error as { code?: string } | null)?.code === 'WORKLOAD_WARNING'
  const selected = query.isSuccess ? query.data.candidates.find(person => person.id === memberId) : undefined
  const title = selection.kind === 'shift' ? 'Подобрать замену' : 'Назначить исполнителя'
  return <AnimatedOverlay variant="modal" dismissible={!mutation.isPending} onClose={onClose}>
    {close =>
      <DocumentDialog
        title={title}
        eyebrow={locationName}
        className="self-exit-assignee"
        scrollBody
        busy={mutation.isPending}
        onClose={close}
        footer={<footer className="self-leave-footer">
          <button className="app-secondary" disabled={mutation.isPending} onClick={close}>Отмена</button>
          <button
            className="app-primary"
            disabled={!selected || !!selected.reason || !query.isSuccess || mutation.isPending || warning && !acknowledgeWorkload}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Сохраняем…' : 'Назначить'}
          </button>
        </footer>}
      >
        <label className="self-exit-search">
          <span>Поиск сотрудника</span>
          <input
            type="search"
            value={search}
            onChange={event => { setSearch(event.target.value); setPage(1); setMemberId(''); mutation.reset() }}
            placeholder="Фамилия или имя"
          />
        </label>
        {query.isPending && <p className="self-exit-loading" role="status">Загружаем сотрудников…</p>}
        {query.isError && <RequestErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {query.isSuccess && <>
          <div className="self-exit-candidates">
            {!query.data.candidates.length && <p className="self-exit-empty">Сотрудники не найдены.</p>}
            {query.data.candidates.map(person => <label key={person.id} className={person.id === memberId ? 'is-selected' : ''}>
              <input
                type="radio"
                name="exit-assignee"
                checked={person.id === memberId}
                disabled={!!person.reason || mutation.isPending}
                onChange={() => { setMemberId(person.id); setAcknowledgeWorkload(false); mutation.reset() }}
              />
              <Avatar url={person.avatarUrl} name={person.name} className="app-avatar" />
              <span>
                <strong>
                  {person.name}
                </strong>
                <small>
                  {person.reason ?? 'Доступен для назначения'}
                </small>
              </span>
            </label>)}
          </div>
          {(page > 1 || query.data.hasMore) && <nav className="self-exit-pagination" aria-label="Страницы сотрудников">
            <button
              className="app-secondary"
              disabled={page === 1 || mutation.isPending}
              onClick={() => { setPage(p => p - 1); setMemberId(''); mutation.reset() }}
            >Назад</button>
            <span>Страница {page}</span>
            <button
              className="app-secondary"
              disabled={!query.data.hasMore || mutation.isPending}
              onClick={() => { setPage(p => p + 1); setMemberId(''); mutation.reset() }}
            >Далее</button>
          </nav>}
        </>}
        {mutation.isError && <div className="self-exit-error" role="alert">
          <RequestErrorMessage error={mutation.error} />
        </div>}
        {warning && <label className="self-exit-workload"><input
          type="checkbox"
          checked={acknowledgeWorkload}
          onChange={event => setAcknowledgeWorkload(event.target.checked)}
        />Подтверждаю превышение нормы нагрузки</label>}
      </DocumentDialog>
    }
  </AnimatedOverlay>
}
