import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useOrganizationMembers } from '../../app/organizations/queries.ts'
import type { OrganizationMember, OrganizationSummary } from '../../app/organizations/types.ts'
import { formatRussianPhone } from '../../app/profile/phone.ts'
import Avatar from '../../component/ui/avatar/avatar.tsx'

const roleNames = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Пользователь' } as const

function lastSeenLabel(member: OrganizationMember) {
  if (member.online) return 'Сейчас онлайн'
  if (!member.lastSeenAt) return 'Недавно не появлялся'
  return `Был в сети ${new Date(member.lastSeenAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`
}

export default function OrganizationMembers({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const members = useOrganizationMembers(organization.id)
  const canManage = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const [pendingRemoval, setPendingRemoval] = useState<OrganizationMember | null>(null)
  const [profileMemberId, setProfileMemberId] = useState<string | null>(null)
  const [actionsMemberId, setActionsMemberId] = useState<string | null>(null)
  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.member-row')) { setProfileMemberId(null); setActionsMemberId(null) }
    }
    function closeEscape(event: KeyboardEvent) { if (event.key === 'Escape') { setProfileMemberId(null); setActionsMemberId(null) } }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [])
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['organization-members', organization.id] }),
    queryClient.invalidateQueries({ queryKey: ['organizations'] }),
  ])
  const roleMutation = useMutation({
    mutationFn: ({ member, role }: { member: OrganizationMember; role: 'ADMIN' | 'MEMBER' }) => apiRequest(`/organizations/${organization.id}/members/${member.id}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: async () => { setActionsMemberId(null); await refresh() },
  })
  const removeMutation = useMutation({
    mutationFn: (member: OrganizationMember) => apiRequest(`/organizations/${organization.id}/members/${member.id}`, { method: 'DELETE' }),
    onSuccess: async () => { setPendingRemoval(null); setActionsMemberId(null); await refresh() },
  })
  const error = roleMutation.error || removeMutation.error

  return <section className="members-page"><header><p className="app-eyebrow">Команда</p><h1>Сотрудники</h1><p>Откройте профиль сотрудника или используйте меню действий для управления.</p></header>
    {error && <p className="app-alert app-alert--error">{error instanceof Error ? error.message : 'Не удалось изменить участника.'}</p>}
    {members.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем участников…</div> : members.isError ? <div className="app-state">Не удалось загрузить участников.</div> : <div className="members-table">{members.data?.members.map((member) => {
      const isOwner = member.role === 'OWNER'
      const canRemove = canManage && !isOwner && (organization.role === 'OWNER' || member.role === 'MEMBER')
      const profileOpen = profileMemberId === member.id
      const actionsOpen = actionsMemberId === member.id
      return <article className={`member-row${profileOpen || actionsOpen ? ' member-row--open' : ''}`} onMouseLeave={() => { if (profileOpen) setProfileMemberId(null) }} key={member.id}>
        <button type="button" className="member-profile-trigger" aria-expanded={profileOpen} onClick={() => { setProfileMemberId(profileOpen ? null : member.id); setActionsMemberId(null) }}>
          <span className="member-avatar"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><i className={member.online ? 'member-presence member-presence--online' : 'member-presence'} /></span>
          <span className="member-row__identity"><strong>{member.displayName}{member.userId === user?.id ? ' (вы)' : ''}</strong><span>{member.email}</span></span>
        </button>
        <span className="role-badge">{roleNames[member.role]}</span>
        {canManage && !isOwner && <div className="member-actions-host"><button type="button" className="member-more" aria-label={`Действия с сотрудником ${member.displayName}`} aria-expanded={actionsOpen} onClick={() => { setActionsMemberId(actionsOpen ? null : member.id); setProfileMemberId(null) }}><span /><span /><span /></button>{actionsOpen && <div className="member-actions-menu"><strong>Действия</strong><label><span>Роль сотрудника</span><select aria-label={`Роль ${member.displayName}`} value={member.role} disabled={roleMutation.isPending} onChange={(event) => roleMutation.mutate({ member, role: event.target.value as 'ADMIN' | 'MEMBER' })}><option value="MEMBER">Пользователь</option><option value="ADMIN">Администратор</option></select></label>{canRemove && <button className="member-actions-menu__danger" disabled={removeMutation.isPending} onClick={() => { setPendingRemoval(member); setActionsMemberId(null) }}>Удалить из организации</button>}</div>}</div>}
        {profileOpen && <aside className="member-profile-popover"><div className="member-profile-popover__heading"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><div><strong>{member.displayName}</strong><span className={member.online ? 'online-text' : ''}>{lastSeenLabel(member)}</span></div></div><dl><div><dt>Роль</dt><dd>{roleNames[member.role]}</dd></div><div><dt>Почта</dt><dd>{member.email}</dd></div>{member.phone && <div><dt>Телефон</dt><dd>{formatRussianPhone(member.phone)}</dd></div>}<div><dt>В команде</dt><dd>{new Date(member.joinedAt).toLocaleDateString('ru-RU')}</dd></div></dl>{member.bio && <p>{member.bio}</p>}</aside>}
      </article>
    })}</div>}
    {pendingRemoval && <div className="app-modal" role="dialog" aria-modal="true" aria-labelledby="remove-member-title"><div className="app-modal__card"><p className="app-eyebrow">Подтверждение</p><h2 id="remove-member-title">Удалить участника?</h2><p>{pendingRemoval.email} потеряет доступ к организации.</p><div><button className="app-secondary" onClick={() => setPendingRemoval(null)}>Отмена</button><button className="app-danger" disabled={removeMutation.isPending} onClick={() => removeMutation.mutate(pendingRemoval)}>Удалить</button></div></div></div>}
  </section>
}
