import AnimatedOverlay from './schedule/animated-overlay.tsx'
import { useSchedulePlanning } from '../../app/schedule/planning.ts'
import RoleBadge from '../../component/ui/role-badge/role-badge.tsx'
import Select from '../../component/ui/select/select.tsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useOrganizationMembers } from '../../app/organizations/queries.ts'
import type { OrganizationMember, OrganizationRole, OrganizationSummary } from '../../app/organizations/types.ts'
import { formatRussianPhone } from '../../app/profile/phone.ts'
import Avatar from '../../component/ui/avatar/avatar.tsx'


function lastSeenLabel(member: OrganizationMember) {
  if (member.online) return 'Сейчас онлайн'
  if (!member.lastSeenAt) return 'Недавно не появлялся'
  return `Был в сети ${new Date(member.lastSeenAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`
}

export default function OrganizationMembers({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [role, setRole] = useState<OrganizationRole | ''>('')
  const [page, setPage] = useState(1)
  const [positionId, setPositionId] = useState('')
  const planning = useSchedulePlanning(organization.id)
  const positions = planning.data?.positions.filter(item => item.isActive) ?? []
  useEffect(() => {
    if (planning.data && positionId && positionId !== 'unassigned' && !planning.data.positions.some(item => item.id === positionId && item.isActive)) { setPositionId(''); setPage(1) }
    if (planning.data && !planning.data.positions.some(item => item.isActive) && positionId) { setPositionId(''); setPage(1) }
  }, [planning.data, positionId])
  const members = useOrganizationMembers(organization.id, { page, pageSize: 20, search: debouncedSearch || undefined, role: role || undefined, positionId: positionId || undefined })
  const canManage = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const [roleMember, setRoleMember] = useState<OrganizationMember | null>(null)
  const [nextRole, setNextRole] = useState<'ADMIN' | 'MEMBER'>('MEMBER')
  const [positionMember, setPositionMember] = useState<OrganizationMember | null>(null)
  const [savedMessage, setSavedMessage] = useState('')
  useEffect(() => { if (!savedMessage) return; const timer = window.setTimeout(() => setSavedMessage(''), 4500); return () => window.clearTimeout(timer) }, [savedMessage])
  const [pendingRemoval, setPendingRemoval] = useState<OrganizationMember | null>(null)
  const [profileMemberId, setProfileMemberId] = useState<string | null>(null)
  const [actionsMemberId, setActionsMemberId] = useState<string | null>(null)
  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.member-row--open')) { setProfileMemberId(null); setActionsMemberId(null) }
    }
    function closeEscape(event: KeyboardEvent) { if (event.key === 'Escape') { setProfileMemberId(null); setActionsMemberId(null) } }
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
    mutationFn: (member: OrganizationMember) => apiRequest(`/organizations/${organization.id}/members/${member.id}`, { method: 'DELETE' }),
    onSuccess: async () => { setPendingRemoval(null); setActionsMemberId(null); await refresh() },
  })
  const error = (!roleMember && roleMutation.error) || removeMutation.error

  const pagination = members.data?.pagination
  return <section className="members-page"><header><p className="app-eyebrow">Команда</p><h1>Сотрудники</h1><p>Откройте профиль сотрудника или используйте меню действий для управления.</p></header>
    {savedMessage && <p className="app-alert" role="status">{savedMessage}</p>}
    {error && <p className="app-alert app-alert--error">{error instanceof Error ? error.message : 'Не удалось изменить участника.'}</p>}
    <div className="members-toolbar"><label><span>Поиск сотрудника</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ФИО или электронная почта" /></label><label><span>Роль</span><Select value={role} onChange={(event) => { setRole(event.target.value as OrganizationRole | ''); setPage(1) }}><option value="">Все роли</option><option value="OWNER">Владелец</option><option value="ADMIN">Администратор</option><option value="MEMBER">Сотрудник</option></Select></label>{positions.length > 0 && <label><span>Должность</span><Select value={positionId} onChange={event => { setPositionId(event.target.value); setPage(1) }}><option value="">Все должности</option><option value="unassigned">Без должности</option>{positions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>}<p>{pagination ? `${pagination.total} сотрудников` : 'Сотрудники организации'}</p></div>
    {members.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем участников…</div> : members.isError ? <div className="app-state">Не удалось загрузить участников.</div> : !members.data?.members.length ? <div className="app-state">По выбранным условиям сотрудники не найдены.</div> : <><div className="members-table">{members.data.members.map((member) => {
      const isOwner = member.role === 'OWNER'
      const canRemove = canManage && !isOwner && (organization.role === 'OWNER' || member.role === 'MEMBER')
      const profileOpen = profileMemberId === member.id
      const actionsOpen = actionsMemberId === member.id
      return <article className={`member-row${profileOpen || actionsOpen ? ' member-row--open' : ''}`} key={member.id}>
        <button type="button" className="member-profile-trigger" aria-expanded={profileOpen} onClick={() => { setProfileMemberId(profileOpen ? null : member.id); setActionsMemberId(null) }}>
          <span className="member-avatar"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><i className={member.online ? 'member-presence member-presence--online' : 'member-presence'} /></span>
          <span className="member-row__identity"><strong>{member.displayName}{member.userId === user?.id ? ' (вы)' : ''}</strong><span>{member.email}</span>{!!member.positions?.length && <span className="member-position-labels">{member.positions.map(position => <em key={position.id}>{position.name}</em>)}</span>}</span>
        </button>
        <RoleBadge role={member.role} />
        {canManage && <div className="member-actions-host"><button type="button" className="member-more" id={`member-actions-${member.id}`} aria-label={`Действия с сотрудником ${member.displayName}`} aria-expanded={actionsOpen} onClick={() => { setActionsMemberId(actionsOpen ? null : member.id); setProfileMemberId(null) }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="2" fill="currentColor" stroke="none" /></svg></button>{actionsOpen && <div className="member-actions-menu" aria-label={`Действия с сотрудником ${member.displayName}`}>
          <button type="button" className="member-action-item" onClick={() => { setPositionMember(member); setActionsMemberId(null) }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="16" height="13" rx="2" /><path d="M9 7V4h6v3M4 12h16M10 12v3h4v-3" /></svg><span>Назначить должности</span><span className="member-action-arrow" aria-hidden="true">›</span></button>
          {!isOwner && <button type="button" className="member-action-item" onClick={() => { roleMutation.reset(); setRoleMember(member); setNextRole(member.role as 'ADMIN' | 'MEMBER'); setActionsMemberId(null) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM9 12l2 2 4-4" /></svg><span>Изменить роль</span><span className="member-action-arrow" aria-hidden="true">›</span></button>}
          {canRemove && <button type="button" className="member-action-item member-action-item--danger" disabled={removeMutation.isPending} onClick={() => { setPendingRemoval(member); setActionsMemberId(null) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></svg><span>Удалить из организации</span></button>}
        </div>}</div>}
        {profileOpen && <aside className="member-profile-popover"><div className="member-profile-popover__heading"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><div><strong>{member.displayName}</strong><span className={member.online ? 'online-text' : ''}>{lastSeenLabel(member)}</span></div></div><dl><div><dt>Роль</dt><dd><RoleBadge role={member.role} /></dd></div><div><dt>Должности</dt><dd>{member.positions?.map(item => item.name).join(", ") || "Не назначены"}</dd></div><div><dt>Почта</dt><dd>{member.email}</dd></div>{member.phone && <div><dt>Телефон</dt><dd>{formatRussianPhone(member.phone)}</dd></div>}<div><dt>В команде</dt><dd>{new Date(member.joinedAt).toLocaleDateString('ru-RU')}</dd></div></dl>{member.bio && <p>{member.bio}</p>}</aside>}
      </article>
    })}</div>{pagination && pagination.pages > 1 && <nav className="members-pagination" aria-label="Страницы сотрудников"><button className="app-secondary" disabled={page <= 1 || members.isFetching} onClick={() => setPage((value) => Math.max(1, value - 1))}>Назад</button><span>Страница {pagination.page} из {pagination.pages}</span><button className="app-secondary" disabled={page >= pagination.pages || members.isFetching} onClick={() => setPage((value) => value + 1)}>Далее</button></nav>}</>}
    {roleMember && <AnimatedOverlay variant="modal" dismissible={!roleMutation.isPending} onClose={() => setRoleMember(null)}>{close => <div className="member-positions-dialog member-role-dialog" role="dialog" aria-modal="true" aria-labelledby="member-role-title"><header><div><p className="app-eyebrow">Права доступа</p><h2 id="member-role-title">Изменить роль</h2></div><button type="button" disabled={roleMutation.isPending} aria-label="Закрыть" onClick={close}>×</button></header><div className="member-positions-person"><Avatar url={roleMember.avatarUrl} name={roleMember.displayName} className="app-avatar" /><div><strong>{roleMember.displayName}</strong><span>{roleMember.email}</span></div></div><section><label htmlFor="member-new-role">Роль в организации</label><Select id="member-new-role" value={nextRole} disabled={roleMutation.isPending} onChange={event => setNextRole(event.target.value as 'ADMIN' | 'MEMBER')}><option value="MEMBER">Сотрудник</option><option value="ADMIN">Администратор</option></Select><p className="member-role-description">{nextRole === 'ADMIN' ? 'Управляет сотрудниками, расписанием и рассматривает заявки.' : 'Просматривает расписание и подаёт свои заявки.'}</p></section>{roleMutation.error && <p role="alert" className="form-inline-error">{roleMutation.error.message}</p>}<footer><div><button type="button" className="app-secondary" disabled={roleMutation.isPending} onClick={close}>Отмена</button><button type="button" className="app-primary" disabled={roleMutation.isPending || nextRole === roleMember.role} onClick={() => roleMutation.mutate({ member: roleMember, role: nextRole })}>{roleMutation.isPending ? 'Сохраняем…' : 'Сохранить'}</button></div></footer></div>}</AnimatedOverlay>}
    {positionMember && <MemberPositions organization={organization} member={positionMember} onClose={() => setPositionMember(null)} onSaved={() => { setSavedMessage('Должности сотрудника сохранены'); setPositionMember(null) }} />}
    {pendingRemoval && <div className="app-modal" role="dialog" aria-modal="true" aria-labelledby="remove-member-title"><div className="app-modal__card"><p className="app-eyebrow">Подтверждение</p><h2 id="remove-member-title">Удалить участника?</h2><p>{pendingRemoval.email} потеряет доступ к организации.</p><div><button className="app-secondary" onClick={() => setPendingRemoval(null)}>Отмена</button><button className="app-danger" disabled={removeMutation.isPending} onClick={() => removeMutation.mutate(pendingRemoval)}>Удалить</button></div></div></div>}
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
  return <AnimatedOverlay variant="modal" dismissible={!mutation.isPending} onClose={onClose}>{close => <div ref={dialog} onKeyDown={event => {
      if (event.key !== 'Tab') return
      const elements = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]')
      if (!elements?.length) return
      const first = elements[0], last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }} className="member-positions-dialog" role="dialog" aria-modal="true" aria-labelledby="member-positions-title" aria-busy={mutation.isPending}>
    <header><div><p className="app-eyebrow">Рабочие функции</p><h2 id="member-positions-title">Должности сотрудника</h2></div><button type="button" aria-label="Закрыть" disabled={mutation.isPending} onClick={close}>×</button></header>
    <div className="member-positions-person"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><div><strong>{member.displayName}</strong><span>{member.email}</span></div></div>
    {planning.isLoading ? <p className="app-state">Загружаем должности…</p> : planning.isError ? <div className="app-state"><p>Не удалось загрузить должности.</p><button className="app-secondary" onClick={() => void planning.refetch()}>Повторить</button></div> : <>
      <section aria-label="Назначенные должности"><h3>Назначены <span>{activeSelected.length}</span></h3><div className="member-positions-selected">{activeSelected.length ? positions.filter(item => activeSelected.includes(item.id)).map(item => <button type="button" key={item.id} disabled={mutation.isPending} aria-label={`Снять должность ${item.name}`} onClick={() => { setSelected(current => current.filter(id => id !== item.id)); dialog.current?.querySelector('input')?.focus() }}>{item.name}<span aria-hidden="true">×</span></button>) : <p>Должности пока не назначены</p>}</div></section>
      <section><label htmlFor="position-search">Добавить должность</label><input id="position-search" type="search" autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по названию" /><div className="member-positions-options">{available.map(item => <button type="button" key={item.id} disabled={mutation.isPending || activeSelected.length >= 20} aria-label={`Добавить должность ${item.name}`} onClick={() => { setSelected(current => [...current, item.id]); setSearch(''); dialog.current?.querySelector('input')?.focus() }}><span>{item.name}</span><span aria-hidden="true">+</span></button>)}{!available.length && <p>{!positions.length ? 'В организации ещё нет должностей. Создайте их в настройках расписания.' : search ? 'Совпадений нет' : 'Все должности уже выбраны'}</p>}</div></section>
      {activeSelected.length >= 20 && <p className="member-positions-note">Можно назначить до 20 должностей.</p>}
    </>}
    {mutation.error && <p className="form-inline-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'Не удалось сохранить должности.'}</p>}
    <footer><span className="member-positions-note">{dirty ? 'Изменения ещё не сохранены' : 'Должности не меняют права доступа'}</span><div><button type="button" className="app-secondary" disabled={mutation.isPending} onClick={close}>Отмена</button><button type="button" className="app-primary" disabled={!dirty || mutation.isPending || !planning.data || planning.isError} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Сохраняем…' : 'Сохранить'}</button></div></footer>
  </div>}</AnimatedOverlay>
}
