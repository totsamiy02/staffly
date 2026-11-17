import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { liveQueryOptions } from '../../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import { shiftTimeRange } from '../../../../app/schedule/date-utils.ts'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import Avatar from '../../../../component/ui/avatar/avatar.tsx'
import RequestErrorMessage, { RequestErrorState } from '../../../../component/ui/request-error-message.tsx'
import { AvailabilityFooter, AvailabilityIcon } from './availability-elements.tsx'

type Candidate = { id: string; name: string; avatarUrl: string | null; reason: string | null; workloadWarning: string | null }
type Result = {
  shift: { id: string; updatedAt: string; memberName: string; start: string; end: string; timezone: string; locationName: string; positionName: string | null }
  candidates: Candidate[]
  pagination: { page: number; pages: number; total: number; available: number }
}

export default function ReplacementDialog({ organization, shiftId, onClose, onSaved }: {
  organization: OrganizationSummary
  shiftId: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { apiRequest } = useAuth()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [memberId, setMemberId] = useState('')
  const [acknowledgeWorkload, setAcknowledgeWorkload] = useState(false)
  const [showUnavailable, setShowUnavailable] = useState(false)
  const query = useQuery({
    ...liveQueryOptions,
    queryKey: ['availability-candidates', organization.id, shiftId, organization.locationId, search, page],
    queryFn: () => apiRequest<Result>(`/organizations/${organization.id}/availability-shifts/${shiftId}/candidates?${new URLSearchParams({ search, page: String(page) })}`),
  })
  const data = query.isSuccess ? query.data : undefined
  const selected = data?.candidates.find(person => person.id === memberId && !person.reason)
  const save = useMutation({
    mutationFn: () => apiRequest(`/organizations/${organization.id}/availability-shifts/${shiftId}`, {
      method: 'POST', body: { memberId, updatedAt: data?.shift.updatedAt, acknowledgeWorkload },
    }),
    onSuccess: onSaved,
  })
  const workloadWarning = selected?.workloadWarning || (save.error as { code?: string } | null)?.code === 'WORKLOAD_WARNING'
  function select(id: string) {
    setMemberId(id)
    setAcknowledgeWorkload(false)
    save.reset()
  }
  function changePage(next: number) {
    setPage(next)
    select('')
  }
  function people(candidates: Candidate[], unavailable = false) {
    return <div className={`availability-candidates${unavailable ? ' is-unavailable' : ''}`}>
      {candidates.map(person => <label key={person.id} className={person.id === memberId ? 'is-selected' : ''}>
        <input type="radio" name="availability-replacement" checked={person.id === memberId} disabled={!!person.reason || save.isPending} onChange={() => select(person.id)} />
        <Avatar url={person.avatarUrl} name={person.name} className="app-avatar" eager />
        <span><strong>{person.name}</strong><small>{person.reason ?? person.workloadWarning ?? 'Доступен в это время'}</small>{!person.reason && !person.workloadWarning && <em>Подходит для смены</em>}</span>
      </label>)}
    </div>
  }
  return <AnimatedOverlay variant="modal" dismissible={!save.isPending} onClose={onClose}>{close =>
    <DocumentDialog title="Подобрать замену" eyebrow="Расписание" className="availability-replacement-dialog" scrollBody busy={save.isPending} onClose={close}
      footer={<AvailabilityFooter onClose={close} busy={save.isPending} action="Назначить замену" disabled={!selected || !query.isSuccess || !!workloadWarning && !acknowledgeWorkload} onSave={() => save.mutate()} />}
    >
      {data && <div className="replacement-shift">
        <AvailabilityIcon />
        <div>
          <strong>
            {new Date(data.shift.start).toLocaleDateString('ru-RU', { timeZone: data.shift.timezone, day: 'numeric', month: 'long' })}
            {' · '}{shiftTimeRange(data.shift.start, data.shift.end, data.shift.timezone)}
          </strong>
          <p>{data.shift.positionName ?? 'Рабочая смена'} · {data.shift.locationName}</p>
          <small>Вместо: {data.shift.memberName}</small>
        </div>
      </div>}
      <label className="availability-field replacement-search">
        <span>Поиск сотрудника</span>
        <input type="search" placeholder="Фамилия или имя" value={search} disabled={save.isPending} onChange={event => {
          setSearch(event.target.value)
          changePage(1)
        }} />
      </label>
      {query.isPending && <p className="app-state" role="status">Проверяем сотрудников…</p>}
      {query.isError && <RequestErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {data && <>
        <div className="replacement-group-heading"><h3>Подходят · {data.pagination.available}</h3><small>Сначала доступные для этой смены</small></div>
        {people(data.candidates.filter(person => !person.reason))}
        {!data.candidates.some(person => !person.reason) && <p className="availability-note">На этой странице подходящих сотрудников нет.</p>}
        {data.candidates.some(person => !!person.reason) && <>
          <button className="app-secondary unavailable-toggle" aria-expanded={showUnavailable} onClick={() => setShowUnavailable(value => !value)}>{showUnavailable ? 'Скрыть недоступных' : 'Показать недоступных'}</button>
          {showUnavailable && people(data.candidates.filter(person => !!person.reason), true)}
        </>}
        {data.pagination.pages > 1 && <div className="availability-pages">
          <button className="app-secondary" disabled={page <= 1 || save.isPending} onClick={() => changePage(page - 1)}>Назад</button>
          <span>{page} / {data.pagination.pages}</span>
          <button className="app-secondary" disabled={page >= data.pagination.pages || save.isPending} onClick={() => changePage(page + 1)}>Далее</button>
        </div>}
        {workloadWarning && <label className="planning-checkbox availability-note">
          <input type="checkbox" checked={acknowledgeWorkload} onChange={event => setAcknowledgeWorkload(event.target.checked)} />
          <span>Подтверждаю назначение с превышением месячной нормы</span>
        </label>}
      </>}
      {save.isError && <div className="availability-stale"><RequestErrorMessage error={save.error} /><button className="app-secondary" onClick={() => { select(''); void query.refetch() }}>Обновить кандидатов</button></div>}
      <p className="availability-note">Проверяются доступность, отсутствия, пересечения и должность. Перед назначением условия проверяются повторно.</p>
    </DocumentDialog>
  }</AnimatedOverlay>
}
