import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useFormSafety } from '../../../app/forms/use-form-safety.ts'
import type { MemberBulkCandidate, MemberBulkCandidates, MemberBulkInput, MemberBulkResult, MemberBulkTarget } from '../../../shared/member-bulk.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import Select from '../../../component/ui/select/select.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import { AccessIcon } from '../settings/access/access-elements.tsx'
import './member-bulk-dialog.scss'

type Props = {
  organizationId: string
  target: MemberBulkTarget
  onClose: () => void
  onSaved?: () => Promise<unknown>
  onBusy?: (busy: boolean) => void
}
const titles = { POSITION: 'Назначить должность', LOCATION: 'Добавить сотрудников', DOCUMENT: 'Получатели ознакомления' }
const targetLabels = { POSITION: 'Должность', LOCATION: 'Рабочая точка', DOCUMENT: 'Документ' }
const notes = {
  POSITION: 'Остальные должности и права доступа сотрудников сохранятся.',
  LOCATION: 'Сотрудники будут добавлены в состав. Другие точки и назначенные роли сохранятся.',
  DOCUMENT: 'Срок и комментарий применяются только к новым получателям. История ознакомлений сохранится.',
}

export function MemberBulkAction(props: Omit<Props, 'onBusy'>) {
  const [busy, setBusy] = useState(false)
  return <AnimatedOverlay variant="modal" dismissible={!busy} onClose={props.onClose}>
    {close => <MemberBulkDialog {...props} onClose={close} onBusy={setBusy} />}
  </AnimatedOverlay>
}

export default function MemberBulkDialog({ organizationId, target, onClose, onSaved, onBusy }: Props) {
  const { apiRequest, locationId } = useAuth()
  const client = useQueryClient()
  const [snapshot, setSnapshot] = useState<MemberBulkCandidates | null>(null)
  const [added, setAdded] = useState<string[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [serverSearch, setServerSearch] = useState('')
  const [point, setPoint] = useState('')
  const [deadline, setDeadline] = useState('')
  const [comment, setComment] = useState('')
  const [showComment, setShowComment] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<MemberBulkResult | null>(null)
  const pending = useRef<MemberBulkInput | null>(null)
  const submitting = useRef(false)
  const candidates = useQuery({
    queryKey: ['member-bulk-candidates', organizationId, target.kind, target.targetId, locationId, serverSearch],
    queryFn: () => apiRequest<MemberBulkCandidates>(`/organizations/${organizationId}/member-actions/candidates?${new URLSearchParams({ ...target, search: serverSearch })}`),
    refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 0,
  })
  useEffect(() => { if (!snapshot && candidates.data) setSnapshot(candidates.data) }, [snapshot, candidates.data])
  useEffect(() => {
    if (!snapshot?.truncated) return
    const timer = window.setTimeout(() => setServerSearch(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search, snapshot?.truncated])
  useEffect(() => {
    if (!snapshot?.truncated || !candidates.data) return
    const known = new Set(snapshot.members.map(member => member.id))
    const additional = candidates.data.members.filter(member => !known.has(member.id))
    if (additional.length) setSnapshot({ ...snapshot, members: [...snapshot.members, ...additional] })
  }, [candidates.data, snapshot])
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false) }, [busy, onBusy])
  const safety = useFormSafety({
    scope: `member-bulk:${organizationId}:${target.kind}:${target.targetId}`,
    value: { added, removed, deadline, comment }, busy, active: !result,
  })
  const selectionCount = added.length + removed.length
  const members = snapshot?.members ?? []
  const searchParts = search.trim().toLocaleLowerCase('ru-RU').split(/\s+/)
  const visible = members.filter(member => (!point || member.locationIds.includes(point))
    && searchParts.every(part => member.displayName.toLocaleLowerCase('ru-RU').includes(part)))
  const resultMap = new Map(result?.rows.map(row => [row.memberId, row]))
  const changed = () => { pending.current = null; setError(null) }

  function toggle(member: MemberBulkCandidate, checked: boolean) {
    changed()
    if (target.kind === 'DOCUMENT' && member.status === 'ASSIGNED') {
      setRemoved(value => checked ? value.filter(id => id !== member.id) : [...value, member.id])
    } else setAdded(value => checked ? [...value, member.id] : value.filter(id => id !== member.id))
  }
  function selectMembers(selected: MemberBulkCandidate[]) {
    changed()
    const available = selected.filter(member => member.status === 'AVAILABLE').map(member => member.id)
    const restored = new Set(selected.filter(member => member.cancelRevision).map(member => member.id))
    const remainingRemovals = removed.filter(id => !restored.has(id))
    setRemoved(remainingRemovals)
    setAdded(value => [...new Set([...value, ...available])].slice(0, 100 - remainingRemovals.length))
  }
  async function refreshFailed() {
    setBusy(true)
    setError(null)
    try {
      const refreshed = await candidates.refetch()
      if (refreshed.error || !refreshed.data) throw refreshed.error ?? new Error('Не удалось обновить сотрудников.')
      const failed = result?.rows.filter(row => row.status === 'FAILED') ?? []
      setSnapshot(refreshed.data)
      setAdded(failed.filter(row => row.action === 'ADD' && refreshed.data.members.some(member => member.id === row.memberId && member.status === 'AVAILABLE')).map(row => row.memberId))
      setRemoved(failed.filter(row => row.action === 'CANCEL' && refreshed.data.members.some(member => member.id === row.memberId && member.cancelRevision)).map(row => row.memberId))
      setResult(null)
      pending.current = null
    } catch (failure) { setError(failure) }
    finally { setBusy(false) }
  }
  async function submit() {
    if (submitting.current || !snapshot || !selectionCount) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      // Freeze this exact payload until its response is known. Refetching or a
      // lost network response must not silently create a second operation.
      pending.current ??= {
        ...target, requestKey: crypto.randomUUID(), deadline: deadline || null, comment: comment.trim() || null,
        rows: [
          ...added.map(memberId => ({ memberId, action: 'ADD' as const, revision: members.find(member => member.id === memberId)!.revision })),
          ...removed.map(memberId => ({ memberId, action: 'CANCEL' as const, revision: members.find(member => member.id === memberId)!.cancelRevision! })),
        ],
      }
      const saved = await apiRequest<MemberBulkResult>(`/organizations/${organizationId}/member-actions`, { method: 'POST', body: pending.current })
      setResult(saved)
      safety.markSaved()
      const prefixes = ['organization-members', 'schedule-planning', 'locations', 'locations-overview', 'organizations', 'member-profile', 'documents', 'document', 'document-progress', 'personal-documents', 'attention', 'notifications', 'account-notifications', 'access-audit']
      await Promise.all(prefixes.map(prefix => client.invalidateQueries({ queryKey: [prefix] })))
      await onSaved?.()
    } catch (failure) { setError(failure) }
    finally {
      submitting.current = false
      setBusy(false)
    }
  }
  function rowLabel(member: MemberBulkCandidate) {
    const saved = resultMap.get(member.id)
    if (saved) return saved.message
    if (removed.includes(member.id)) return 'Будет отменено'
    if (added.includes(member.id)) return target.kind === 'LOCATION' ? 'Будет добавлен' : 'Будет назначено'
    return member.reason ?? ({ AVAILABLE: '', ASSIGNED: target.kind === 'LOCATION' ? 'Уже в составе' : target.kind === 'DOCUMENT' ? 'Ожидает ознакомления' : 'Уже назначена', ACKNOWLEDGED: 'Ознакомлен', CANCELLED: 'Отменено', BLOCKED: 'Недоступно' }[member.status])
  }
  const failures = result?.rows.filter(row => row.status === 'FAILED').length ?? 0
  const applied = result?.rows.filter(row => row.status === 'APPLIED').length ?? 0
  const countForm = new Intl.PluralRules('ru-RU').select(added.length)
  const primaryLabel = removed.length ? 'Сохранить получателей'
    : target.kind === 'LOCATION'
      ? `Добавить ${added.length} ${countForm === 'one' || countForm === 'few' ? 'сотрудника' : 'сотрудников'}`
      : `Назначить ${added.length} ${countForm === 'one' ? 'сотруднику' : 'сотрудникам'}`

  return <DocumentDialog
    title={titles[target.kind]}
    className="member-bulk-dialog"
    eyebrow=""
    busy={busy}
    onClose={onClose}
  >
    <div ref={safety.ref} className="member-bulk-body">
      {snapshot && <>
        <div className="member-bulk-target">
          <span className="member-bulk-target__icon">
            <AccessIcon name={target.kind === 'POSITION' ? 'briefcase' : target.kind === 'LOCATION' ? 'pin' : 'document'} />
          </span>
          <div>
            <small>{targetLabels[target.kind]}</small>
            <strong>{snapshot.target.name}</strong>
          </div>
          {target.kind === 'DOCUMENT' && snapshot.target.locationName && <span>{snapshot.target.locationName}</span>}
        </div>
        <div className="member-bulk-filters">
          <label className="member-bulk-search">
            <span className="member-bulk-sr">Поиск сотрудника</span>
            <AccessIcon name="search" />
            <input type="search" placeholder="Поиск сотрудника" value={search} onChange={event => setSearch(event.target.value)} />
          </label>
          {target.kind === 'DOCUMENT' && snapshot.roles.length > 0 ? <label>
            <span className="member-bulk-sr">Добавить по роли</span>
            <Select value="" disabled={busy || !!result} onChange={event => selectMembers(visible.filter(member => member.roleIds.includes(event.target.value)))}>
              <option value="">Добавить по роли</option>
              {snapshot.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
            </Select>
          </label> : snapshot.locations.length > 1 && <label>
            <span className="member-bulk-sr">Точка сотрудника</span>
            <Select value={point} onChange={event => setPoint(event.target.value)}>
              <option value="">Все доступные точки</option>
              {snapshot.locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
            </Select>
          </label>}
        </div>
        <div className="member-bulk-list-heading">
          <span>Сотрудники <b>{visible.length}</b></span>
          {!result && <button type="button" disabled={busy || selectionCount >= 100} onClick={() => selectMembers(visible)}>Выбрать доступных</button>}
        </div>
        {snapshot.truncated && <p className="member-bulk-note">Список большой. Поиск по имени проверяет всех доступных сотрудников.</p>}
        <div className="member-bulk-list" role="group" aria-label="Выбор сотрудников">
          {visible.map(member => {
            const assigned = member.status === 'ASSIGNED' || member.status === 'ACKNOWLEDGED'
            const checked = assigned && !removed.includes(member.id) || added.includes(member.id)
            const createsChange = member.status === 'ASSIGNED' ? !removed.includes(member.id) : !added.includes(member.id)
            const disabled = busy || !!result || member.status !== 'AVAILABLE' && !(target.kind === 'DOCUMENT' && member.cancelRevision)
              || createsChange && selectionCount >= 100
            const changedMember = added.includes(member.id) || removed.includes(member.id)
            const outcome = resultMap.get(member.id)
            const rowClass = changedMember && !result ? ' is-selected' : ''
            const stateClass = outcome?.status === 'APPLIED' ? ' is-success'
              : member.status === 'BLOCKED' || outcome?.status === 'FAILED' ? ' is-warning' : ''
            return <label key={member.id} className={`member-bulk-person${rowClass}${outcome?.status === 'FAILED' ? ' has-error' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={event => toggle(member, event.target.checked)}
                aria-label={`Выбрать: ${member.displayName}`}
              />
              <Avatar url={member.avatarUrl} name={member.displayName} className="member-bulk-avatar" />
              <span className="member-bulk-person__name">
                <strong>{member.displayName}</strong>
                {member.secondary && <small>{member.secondary}</small>}
              </span>
              <span className={`member-bulk-person__state${stateClass}`}>
                {outcome?.status === 'APPLIED' && <AccessIcon name="check" />}
                {rowLabel(member)}
              </span>
            </label>
          })}
          {!visible.length && <p className="member-bulk-empty">Сотрудники не найдены. Измените поиск или точку.</p>}
        </div>
        {target.kind === 'DOCUMENT' && !result && <div className="member-bulk-document-fields">
          <label>
            <span>Срок для новых получателей</span>
            <input type="date" value={deadline} disabled={busy || !added.length} onChange={event => { changed(); setDeadline(event.target.value) }} />
          </label>
          {!showComment
            ? <button type="button" disabled={busy} onClick={() => setShowComment(true)}>Добавить комментарий</button>
            : <label className="member-bulk-comment">
              <span>Комментарий для новых получателей</span>
              <textarea rows={2} maxLength={1000} value={comment} disabled={busy} onChange={event => { changed(); setComment(event.target.value) }} />
            </label>}
        </div>}
        <div className="member-bulk-summary" aria-live="polite">
          {result ? <>
            <strong>Выполнено: {applied}</strong>
            <span>Без изменений: {result.rows.filter(row => row.status === 'UNCHANGED').length}</span>
            {failures > 0 && <span className="member-bulk-failures">Не выполнено: {failures}</span>}
          </> : <>
            <strong>Новых назначений: {added.length}</strong>
            {removed.length > 0 && <span>Будет отменено: {removed.length}</span>}
            {selectionCount > 0 && <button type="button" disabled={busy} onClick={() => { changed(); setAdded([]); setRemoved([]) }}>Снять выбор</button>}
          </>}
        </div>
        <p className="member-bulk-note">
          {result
            ? failures ? 'Проверьте причины у сотрудников. Повтор затронет только невыполненные изменения.' : 'Назначения сохранены. Автор и время записаны в истории.'
            : selectionCount >= 100 ? 'За один раз можно изменить до 100 назначений.' : notes[target.kind]}
        </p>
      </>}
      {!snapshot && candidates.isPending && <div className="member-bulk-empty" role="status">
        <span className="app-spinner" />Загружаем сотрудников…
      </div>}
      {!snapshot && candidates.isError && <div className="member-bulk-load-error">
        <RequestErrorMessage error={candidates.error} />
        <button type="button" className="app-secondary" onClick={() => void candidates.refetch()}>Повторить</button>
      </div>}
      {snapshot?.truncated && candidates.isError && <div className="member-bulk-load-error" role="alert">
        <RequestErrorMessage error={candidates.error} />
        <button type="button" className="app-secondary" onClick={() => void candidates.refetch()}>Повторить поиск</button>
      </div>}
      {!!error && <div className="form-inline-error" role="alert"><RequestErrorMessage error={error} /></div>}
    </div>
    <footer className="member-bulk-footer">
      {result ? <>
        {failures > 0 && <button className="app-secondary" type="button" disabled={busy} onClick={() => void refreshFailed()}>Проверить невыполненные</button>}
        <button className="app-primary" type="button" disabled={busy} onClick={onClose}>Готово</button>
      </> : <>
        <button className="app-secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button>
        <button className="app-primary" type="button" disabled={busy || !selectionCount || !snapshot} onClick={() => void submit()}>
          {busy ? 'Сохраняем…' : primaryLabel}
        </button>
      </>}
    </footer>
  </DocumentDialog>
}
