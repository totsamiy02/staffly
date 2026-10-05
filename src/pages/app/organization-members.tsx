import './members.scss'
import MemberInvitations from './member-invitations.tsx'
import { locationTone } from '../../app/organizations/format.ts'
import DocumentActionsMenu from './documents/document-actions-menu.tsx'
import DocumentDialog from './documents/document-dialog.tsx'
import { Link, useSearchParams } from 'react-router-dom'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import { useSchedulePlanning } from '../../app/schedule/planning.ts'
import RoleBadge from '../../component/ui/role-badge/role-badge.tsx'
import Select from '../../component/ui/select/select.tsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useOrganizationMembers, useLocations } from '../../app/organizations/queries.ts'
import type { OrganizationMember, OrganizationRole, OrganizationSummary } from '../../app/organizations/types.ts'
import { formatRussianPhone } from '../../app/profile/phone.ts'
import Avatar from '../../component/ui/avatar/avatar.tsx'


function lastSeenLabel(member: OrganizationMember) {
  if (member.online) return 'Сейчас онлайн'
  if (!member.lastSeenAt) return 'Недавно не появлялся'
  return `Был в сети ${new Date(member.lastSeenAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`
}

function memberCountLabel(count: number) {
  const form = new Intl.PluralRules('ru-RU').select(count)
  return `${count} ${form === 'one' ? 'сотрудник' : form === 'few' ? 'сотрудника' : 'сотрудников'}`
}

export default function OrganizationMembers({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [role, setRole] = useState<OrganizationRole | ''>('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [inviting, setInviting] = useState(false)
  const [positionId, setPositionId] = useState('')
  const [params] = useSearchParams()
  const [pointId, setPointId] = useState(params.get('pointId') === 'all' ? '' : params.get('pointId') ?? '')
  const points = useLocations(organization.id)
  const owner = organization.organizationRole === 'OWNER' || organization.role === 'OWNER'
  const manageable = points.data?.locations.filter(point => !point.archivedAt && (owner || point.role === 'ADMIN')) ?? []
  const [assignMember, setAssignMember] = useState<OrganizationMember | null>(null)
  const [assignmentPointId, setAssignmentPointId] = useState(organization.locationId ?? '')
  const planning = useSchedulePlanning(organization.id)
  const positions = planning.data?.positions.filter(item => item.isActive) ?? []
  useEffect(() => {
    if (planning.data && positionId && positionId !== 'unassigned' && !planning.data.positions.some(item => item.id === positionId && item.isActive)) { setPositionId(''); setPage(1) }
    if (planning.data && !planning.data.positions.some(item => item.isActive) && positionId) { setPositionId(''); setPage(1) }
  }, [planning.data, positionId])
  const members = useOrganizationMembers(organization.id, { page, pageSize, search: debouncedSearch || undefined, role: role || undefined, positionId: positionId || undefined, directory: true, pointId: pointId || undefined })
  const canManage = owner || manageable.length > 0
  const [roleMember, setRoleMember] = useState<OrganizationMember | null>(null)
  const [nextRole, setNextRole] = useState<'ADMIN' | 'MEMBER'>('MEMBER')
  const [positionMember, setPositionMember] = useState<OrganizationMember | null>(null)
  const [savedMessage, setSavedMessage] = useState('')
  useEffect(() => { if (!savedMessage) return; const timer = window.setTimeout(() => setSavedMessage(''), 4500); return () => window.clearTimeout(timer) }, [savedMessage])
  const [removeEntireOrganization, setRemoveEntireOrganization] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<OrganizationMember | null>(null)
  const [profileMemberId, setProfileMemberId] = useState<string | null>(null)
  const [actionsMemberId, setActionsMemberId] = useState<string | null>(null)
  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.member-row--open')) { setActionsMemberId(null) }
    }
    function closeEscape(event: KeyboardEvent) { if (event.key === 'Escape') { setActionsMemberId(null) } }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1) }, 300)
    return () => window.clearTimeout(timer)
  }, [search])
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['organization-members', organization.id] }),
    queryClient.invalidateQueries({ queryKey: ['organizations'] }),
  ])
  const roleMutation = useMutation({
    mutationFn: ({ member, role }: { member: OrganizationMember; role: 'ADMIN' | 'MEMBER' }) => apiRequest(`/organizations/${organization.id}/members/${member.id}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: async () => { setActionsMemberId(null); setRoleMember(null); setSavedMessage('Роль сотрудника изменена'); await refresh() },
  })
  const removeMutation = useMutation({
    mutationFn: (member: OrganizationMember) => apiRequest(`/organizations/${organization.id}/members/${member.id}${removeEntireOrganization ? '/organization' : ''}`, { method: 'DELETE' }),
    onSuccess: async () => { setPendingRemoval(null); setActionsMemberId(null); await refresh() },
  })
  const error = (!roleMember && roleMutation.error) || removeMutation.error

  const assignment = useMutation({ mutationFn: () => apiRequest(`/organizations/${organization.id}/locations/${assignmentPointId}/members`, { method: 'POST', body: { memberId: assignMember!.id } }), onSuccess: async () => { setAssignMember(null); setSavedMessage('Сотрудник назначен в точку'); await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['locations', organization.id] })]) } })
  const pagination = members.data?.pagination
  return <section className="members-page"><header className="members-heading"><div><h1>Сотрудники</h1><p>Управление командой, ролями и доступами</p></div>{canManage && <button className="app-primary" onClick={() => setInviting(true)}><span aria-hidden="true">+</span> Пригласить сотрудника</button>}</header>
    {savedMessage && <p className="app-alert" role="status">{savedMessage}</p>}
    {error && <p className="app-alert app-alert--error">{error instanceof Error ? error.message : 'Не удалось изменить участника.'}</p>}
    <div className="members-toolbar"><label><span>Поиск сотрудника</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ФИО или электронная почта" /></label><label><span>Роль</span><Select value={role} onChange={(event) => { setRole(event.target.value as OrganizationRole | ''); setPage(1) }}><option value="">Все роли</option><option value="OWNER">Владелец</option><option value="ADMIN">Администратор</option><option value="MEMBER">Сотрудник</option></Select></label>{positions.length > 0 && <label><span>Должность</span><Select value={positionId} onChange={event => { setPositionId(event.target.value); setPage(1) }}><option value="">Все должности</option><option value="unassigned">Без должности</option>{positions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>}<label><span>Точка</span><Select value={pointId} onChange={event => { setPointId(event.target.value); setPage(1) }}><option value="">Все точки</option>{points.data?.locations.filter(point => !point.archivedAt).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label></div><p className="members-count">{pagination ? memberCountLabel(pagination.total) : 'Сотрудники организации'}</p>
    {members.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем участников…</div> : members.isError ? <div className="app-state">Не удалось загрузить участников.</div> : !members.data?.members.length ? <div className="app-state">По выбранным условиям сотрудники не найдены.</div> : <><div className="members-table" role="table" aria-label="Сотрудники организации"><div className="members-table-head" role="row"><span role="columnheader">Сотрудник</span><span role="columnheader">Должности</span><span role="columnheader">Точки</span><span role="columnheader">Роль</span><span role="columnheader" aria-label="Действия" /></div>{members.data.members.map((member) => {
      const isOwner = member.role === 'OWNER'
      const inCurrentPoint = member.locations?.some(point => point.locationId === organization.locationId)
      const canEditCurrent = owner || organization.role === 'ADMIN' && Boolean(inCurrentPoint)
      const canRemove = canEditCurrent && inCurrentPoint && !isOwner && (owner || member.role === 'MEMBER')
      const profileOpen = profileMemberId === member.id
      const actionsOpen = actionsMemberId === member.id
      return <article className={`member-row${profileOpen || actionsOpen ? ' member-row--open' : ''}`} key={member.id} role="row">
        <div className="member-summary" role="cell">
        <button type="button" className="member-profile-trigger" aria-expanded={profileOpen} onClick={() => { setProfileMemberId(profileOpen ? null : member.id); setActionsMemberId(null) }}>
          <span className="member-avatar"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><i className={member.online ? 'member-presence member-presence--online' : 'member-presence'} /></span>
          <span className="member-row__identity"><strong>{member.displayName}{member.userId === user?.id ? ' (вы)' : ''}</strong><span>{member.email}</span></span>
        </button>
        </div>
        <div className="member-tags member-positions-cell" role="cell" data-label="Должности">{!member.positions?.length && <span className="member-empty">Не назначены</span>}
          <MemberLabels labels={(member.positions ?? []).map(position => ({ id: position.id, name: position.name }))} limit={3} label="Должности" />
        </div><div className="member-tags member-locations-cell" role="cell" data-label="Точки">{isOwner ? <span className="member-empty">Все точки</span> : !member.locations?.length ? <span className="member-empty">Не назначены</span> : <MemberLabels labels={(member.locations ?? []).flatMap(point => { const location = points.data?.locations.find(item => item.id === point.locationId); return location && !location.archivedAt ? [{ id: location.id, name: location.name, tone: locationTone(location.id) }] : [] })} limit={2} label="Точки" />}
        </div>
        <div role="cell" data-label="Роль" className="member-role-cell"><RoleBadge role={member.role} /></div>

        {canManage && <div className="member-actions-host"><button type="button" className="member-more" id={`member-actions-${member.id}`} aria-label={`Действия с сотрудником ${member.displayName}`} aria-expanded={actionsOpen} onClick={() => { setActionsMemberId(actionsOpen ? null : member.id); setProfileMemberId(null) }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="5" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="19" r="1.5" fill="currentColor" /></svg></button>{actionsOpen && <div className="member-actions-menu" aria-label={`Действия с сотрудником ${member.displayName}`}>
          <button disabled={!canEditCurrent} type="button" className="member-action-item" onClick={() => { setPositionMember(member); setActionsMemberId(null) }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="16" height="13" rx="2" /><path d="M9 7V4h6v3M4 12h16M10 12v3h4v-3" /></svg><span>Назначить должности</span><span className="member-action-arrow" aria-hidden="true">›</span></button>
          {!isOwner && owner && <button type="button" className="member-action-item" onClick={() => { roleMutation.reset(); setRoleMember(member); setNextRole(member.role as 'ADMIN' | 'MEMBER'); setActionsMemberId(null) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM9 12l2 2 4-4" /></svg><span>Изменить роль</span><span className="member-action-arrow" aria-hidden="true">›</span></button>}
          {(owner || member.role === 'MEMBER') && <button type="button" className="member-action-item" onClick={() => { assignment.reset(); setAssignmentPointId(manageable.find(point => !member.locations?.some(item => item.locationId === point.id))?.id ?? ''); setAssignMember(member); setActionsMemberId(null) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 12c-2 4-6 8-6 8S3 13 3 8a7 7 0 0 1 14 0" /><circle cx="10" cy="8" r="2" /><path d="M19 12v8M15 16h8" /></svg><span>Назначить в точку</span></button>}
          {owner && !isOwner && <button type="button" className="member-action-item member-action-item--danger" onClick={() => { setRemoveEntireOrganization(true); setPendingRemoval(member); setActionsMemberId(null) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4v16h6M9 12h12m-4-4 4 4-4 4" /></svg><span>Удалить из организации</span></button>}
          {canRemove && <button type="button" className="member-action-item member-action-item--danger" disabled={removeMutation.isPending} onClick={() => { setRemoveEntireOrganization(false); setPendingRemoval(member); setActionsMemberId(null) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></svg><span>Убрать из точки</span></button>}
        </div>}</div>}
        {profileOpen && <AnimatedOverlay variant="modal" onClose={() => setProfileMemberId(null)}>{close => <DocumentDialog className="members-dialog member-profile-dialog" title="Профиль сотрудника" eyebrow="Сотрудники" onClose={close}><div className="member-profile-popover__heading"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><div><strong>{member.displayName}</strong><span className={member.online ? 'online-text' : ''}>{lastSeenLabel(member)}</span></div></div><dl><div><dt>Роль</dt><dd><RoleBadge role={member.role} /></dd></div><div><dt>Точки</dt><dd>{isOwner ? "Все точки" : member.locations?.map(point => points.data?.locations.find(item => item.id === point.locationId)?.name).filter(Boolean).join(", ") || "Не назначены"}</dd></div><div><dt>Должности</dt><dd>{member.positions?.map(item => item.name).join(", ") || "Не назначены"}</dd></div><div><dt>Почта</dt><dd>{member.email}</dd></div>{member.phone && <div><dt>Телефон</dt><dd>{formatRussianPhone(member.phone)}</dd></div>}<div><dt>В команде</dt><dd>{new Date(member.joinedAt).toLocaleDateString('ru-RU')}</dd></div></dl>{member.bio && <p>{member.bio}</p>}{canManage && <Link className="app-secondary" to={`/app/organizations/${organization.id}/documents?member=${member.id}${organization.locationId ? `&location=${organization.locationId}` : ''}`}>Документы сотрудника <span aria-hidden="true">›</span></Link>}</DocumentDialog>}</AnimatedOverlay>}
      </article>
    })}</div>{pagination && <nav className="members-pagination" aria-label="Страницы сотрудников"><button className="app-secondary" disabled={page <= 1 || members.isFetching} onClick={() => setPage((value) => Math.max(1, value - 1))}>Назад</button><span>Страница {pagination.page} из {pagination.pages}</span><button className="app-secondary" disabled={page >= pagination.pages || members.isFetching} onClick={() => setPage((value) => value + 1)}>Далее</button><label className="members-page-size"><span>Показывать по:</span><Select value={String(pageSize)} onChange={event => { setPageSize(Number(event.target.value)); setPage(1) }}>{[10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}</Select></label></nav>}</>}
    {inviting && <MemberInvitations organization={organization} onClose={() => setInviting(false)} />}
    {assignMember && <AnimatedOverlay variant="modal" dismissible={!assignment.isPending} onClose={() => setAssignMember(null)}>{close => <DocumentDialog className="members-dialog" title="Назначить сотрудника в точку" eyebrow="Сотрудники" busy={assignment.isPending} onClose={close}><form onSubmit={event => { event.preventDefault(); assignment.mutate() }}><div className="member-positions-person"><Avatar url={assignMember.avatarUrl} name={assignMember.displayName} className="app-avatar" /><strong>{assignMember.displayName}</strong><RoleBadge role={assignMember.role} /></div><label><span>Точка</span><Select required value={assignmentPointId} onChange={event => setAssignmentPointId(event.target.value)}><option value="">Выберите точку</option>{manageable.filter(point => !assignMember.locations?.some(item => item.locationId === point.id)).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label><p>Роль общая для организации. Назначение добавляет точку, сохраняя остальные.</p>{assignment.error && <p className="form-inline-error" role="alert">{assignment.error.message}</p>}<footer><button type="button" className="app-secondary" disabled={assignment.isPending} onClick={close}>Отмена</button><button className="app-primary" disabled={assignment.isPending || !assignmentPointId}>Назначить</button></footer></form></DocumentDialog>}</AnimatedOverlay>}
    {roleMember && <AnimatedOverlay variant="modal" dismissible={!roleMutation.isPending} onClose={() => setRoleMember(null)}>{close => <DocumentDialog className="members-dialog member-role-dialog" title="Изменить роль" eyebrow="Права доступа" busy={roleMutation.isPending} onClose={close}><div className="member-positions-person"><Avatar url={roleMember.avatarUrl} name={roleMember.displayName} className="app-avatar" /><div><strong>{roleMember.displayName}</strong><span>{roleMember.email}</span></div></div><section><label htmlFor="member-new-role">Роль в организации</label><Select id="member-new-role" value={nextRole} disabled={roleMutation.isPending} onChange={event => setNextRole(event.target.value as 'ADMIN' | 'MEMBER')}><option value="MEMBER">Сотрудник</option><option value="ADMIN">Администратор</option></Select><p className="member-role-description">{nextRole === 'ADMIN' ? 'Управляет сотрудниками, расписанием и заявками только назначенных ему точек. Остальные точки доступны для просмотра.' : 'Просматривает расписание и подаёт свои заявки.'}</p></section>{roleMutation.error && <p role="alert" className="form-inline-error">{roleMutation.error.message}</p>}<footer><div><button type="button" className="app-secondary" disabled={roleMutation.isPending} onClick={close}>Отмена</button><button type="button" className="app-primary" disabled={roleMutation.isPending || nextRole === roleMember.role} onClick={() => roleMutation.mutate({ member: roleMember, role: nextRole })}>{roleMutation.isPending ? 'Сохраняем…' : 'Сохранить'}</button></div></footer></DocumentDialog>}</AnimatedOverlay>}
    {positionMember && <MemberPositions organization={organization} member={positionMember} onClose={() => setPositionMember(null)} onSaved={() => { setSavedMessage('Должности сотрудника сохранены'); setPositionMember(null) }} />}
    {pendingRemoval && <AnimatedOverlay variant="modal" dismissible={!removeMutation.isPending} onClose={() => setPendingRemoval(null)}>{close => <DocumentDialog className="members-dialog" title="Удалить сотрудника?" eyebrow="Подтверждение" busy={removeMutation.isPending} onClose={close}><p className="member-dialog-hint">{pendingRemoval.email} {removeEntireOrganization ? 'потеряет доступ ко всей организации; будущие смены будут отменены.' : 'будет убран из состава этой точки. Членство в организации и назначенные смены сохранятся.'}</p>{removeMutation.error && <p role="alert" className="form-inline-error">{removeMutation.error.message}</p>}<footer><button className="app-secondary" disabled={removeMutation.isPending} onClick={close}>Отмена</button><button className="app-danger" disabled={removeMutation.isPending} onClick={() => removeMutation.mutate(pendingRemoval)}>Удалить</button></footer></DocumentDialog>}</AnimatedOverlay>}

  </section>
}

function MemberPositions({ organization, member, onClose, onSaved }: { organization: OrganizationSummary; member: OrganizationMember; onClose: () => void; onSaved: () => void }) {
  const planning = useSchedulePlanning(organization.id)
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { const previous = document.activeElement; return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); else document.getElementById('member-actions-' + member.id)?.focus() } }, [member.id])
  const [selected, setSelected] = useState(() => member.positions?.map(item => item.id) ?? [])
  const [search, setSearch] = useState('')
  const positions = planning.data?.positions.filter(item => item.isActive) ?? []
  const activeSelected = selected.filter(id => positions.some(item => item.id === id))
  const initial = (member.positions ?? []).map(item => item.id).filter(id => positions.some(item => item.id === id))
  const dirty = [...activeSelected].sort().join(',') !== [...initial].sort().join(',')
  const mutation = useMutation({
    mutationFn: () => apiRequest(`/organizations/${organization.id}/members/${member.id}/positions`, { method: 'PUT', body: { positionIds: activeSelected } }),
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ['organization-members', organization.id] }), client.invalidateQueries({ queryKey: ['schedule-planning', organization.id] })]); onSaved() },
  })
  const available = positions.filter(item => !selected.includes(item.id) && item.name.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU')))
  return <AnimatedOverlay variant="modal" dismissible={!mutation.isPending} onClose={onClose}>{close => <DocumentDialog className="members-dialog member-positions-dialog" title="Должности сотрудника" eyebrow="Рабочие функции" busy={mutation.isPending} onClose={close}><div ref={dialog}>
    <div className="member-positions-person"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><div><strong>{member.displayName}</strong><span>{member.email}</span></div></div>
    {planning.isLoading ? <p className="app-state">Загружаем должности…</p> : planning.isError ? <div className="app-state"><p>Не удалось загрузить должности.</p><button className="app-secondary" onClick={() => void planning.refetch()}>Повторить</button></div> : <>
      <section aria-label="Назначенные должности"><h3>Назначены <span>{activeSelected.length}</span></h3><div className="member-positions-selected">{activeSelected.length ? positions.filter(item => activeSelected.includes(item.id)).map(item => <button type="button" key={item.id} disabled={mutation.isPending} aria-label={`Снять должность ${item.name}`} onClick={() => { setSelected(current => current.filter(id => id !== item.id)); dialog.current?.querySelector('input')?.focus() }}>{item.name}<span aria-hidden="true">×</span></button>) : <p>Должности пока не назначены</p>}</div></section>
      <section><label htmlFor="position-search">Добавить должность</label><input id="position-search" type="search" autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по названию" /><div className="member-positions-options">{available.map(item => <button type="button" key={item.id} disabled={mutation.isPending || activeSelected.length >= 20} aria-label={`Добавить должность ${item.name}`} onClick={() => { setSelected(current => [...current, item.id]); setSearch(''); dialog.current?.querySelector('input')?.focus() }}><span>{item.name}</span><span aria-hidden="true">+</span></button>)}{!available.length && <p>{!positions.length ? 'В организации ещё нет должностей. Создайте их в настройках расписания.' : search ? 'Совпадений нет' : 'Все должности уже выбраны'}</p>}</div></section>
      {activeSelected.length >= 20 && <p className="member-positions-note">Можно назначить до 20 должностей.</p>}
    </>}
    {mutation.error && <p className="form-inline-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'Не удалось сохранить должности.'}</p>}
    <footer><span className="member-positions-note">{dirty ? 'Изменения ещё не сохранены' : 'Должности не меняют права доступа'}</span><div><button type="button" className="app-secondary" disabled={mutation.isPending} onClick={close}>Отмена</button><button type="button" className="app-primary" disabled={!dirty || mutation.isPending || !planning.data || planning.isError} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Сохраняем…' : 'Сохранить'}</button></div></footer>
  </div></DocumentDialog>}</AnimatedOverlay>
}

function MemberLabels({ labels, limit, label }: { labels: { id: string; name: string; tone?: string }[]; limit: number; label: string }) {
  if (!labels.length) return null
  const badge = (item: typeof labels[number]) => <span className={`member-tag${item.tone ? ' location-badge' : ''}`} data-tone={item.tone} key={item.id} title={item.name}>{item.tone && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>}<span>{item.name}</span></span>
  return <div className="member-tags-group" aria-label={label}>{labels.slice(0, limit).map(badge)}{labels.length > limit && <DocumentActionsMenu className="member-tags-more" label={`${label}: ещё ${labels.length - limit}`} trigger={`+${labels.length - limit}`}><strong>{label}</strong>{labels.slice(limit).map(badge)}</DocumentActionsMenu>}</div>
}
