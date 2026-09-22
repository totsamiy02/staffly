import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useOrganizationMembers } from '../../app/organizations/queries.ts'
import type { OrganizationMember, OrganizationSummary } from '../../app/organizations/types.ts'

export default function OrganizationMembers({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const members = useOrganizationMembers(organization.id)
  const canManage = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const [pendingRemoval, setPendingRemoval] = useState<OrganizationMember | null>(null)
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['organization-members', organization.id] }),
    queryClient.invalidateQueries({ queryKey: ['organizations'] }),
  ])
  const roleMutation = useMutation({
    mutationFn: ({ member, role }: { member: OrganizationMember; role: 'ADMIN' | 'MEMBER' }) => apiRequest(`/organizations/${organization.id}/members/${member.id}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: refresh,
  })
  const removeMutation = useMutation({
    mutationFn: (member: OrganizationMember) => apiRequest(`/organizations/${organization.id}/members/${member.id}`, { method: 'DELETE' }),
    onSuccess: async () => { setPendingRemoval(null); await refresh() },
  })
  const error = roleMutation.error || removeMutation.error

  return <section className="members-page"><header><p className="app-eyebrow">Команда</p><h1>Сотрудники</h1><p>Участники организации и их уровень доступа.</p></header>
    {error && <p className="app-alert app-alert--error">{error instanceof Error ? error.message : 'Не удалось изменить участника.'}</p>}
    {members.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем участников…</div> : members.isError ? <div className="app-state">Не удалось загрузить участников.</div> : <div className="members-table">{members.data?.members.map((member) => {
      const isOwner = member.role === 'OWNER'
      const canRemove = canManage && !isOwner && (organization.role === 'OWNER' || member.role === 'MEMBER')
      return <article className="member-row" key={member.id}><span className="app-avatar">{member.displayName.slice(0, 1).toUpperCase()}</span><div className="member-row__identity"><strong>{member.displayName}{member.userId === user?.id ? ' (вы)' : ''}</strong><span>{member.email}</span></div><div className="member-row__controls">{canManage && !isOwner ? <select aria-label={`Роль ${member.displayName}`} value={member.role} disabled={roleMutation.isPending} onChange={(event) => roleMutation.mutate({ member, role: event.target.value as 'ADMIN' | 'MEMBER' })}><option value="MEMBER">Участник</option><option value="ADMIN">Администратор</option></select> : <span className="role-badge">{isOwner ? 'Владелец' : member.role === 'ADMIN' ? 'Администратор' : 'Участник'}</span>}{canRemove && <button className="member-remove" disabled={removeMutation.isPending} onClick={() => setPendingRemoval(member)}>Удалить</button>}</div></article>
    })}</div>}
    {pendingRemoval && <div className="app-modal" role="dialog" aria-modal="true" aria-labelledby="remove-member-title"><div className="app-modal__card"><p className="app-eyebrow">Подтверждение</p><h2 id="remove-member-title">Удалить участника?</h2><p>{pendingRemoval.email} потеряет доступ к организации.</p><div><button className="app-secondary" onClick={() => setPendingRemoval(null)}>Отмена</button><button className="app-danger" disabled={removeMutation.isPending} onClick={() => removeMutation.mutate(pendingRemoval)}>Удалить</button></div></div></div>}
  </section>
}
