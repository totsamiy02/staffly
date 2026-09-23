import { useEffect, useState, type FormEvent } from 'react'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import { formatRussianPhone } from '../../app/profile/phone.ts'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useActiveOrganizationInvitations } from '../../app/organizations/queries.ts'

const roleNames = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Пользователь' } as const

export default function OrganizationDashboard({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest } = useAuth()
  const [email, setEmail] = useState('')
  const [inviteMessage, setInviteMessage] = useState('')
  const [code, setCode] = useState('')
  const [codeInvitationId, setCodeInvitationId] = useState('')
  const [codeExpiry, setCodeExpiry] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const canInvite = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const activeInvitations = useActiveOrganizationInvitations(organization.id, canInvite)

  useEffect(() => {
    if (!inviteMessage) return
    const timer = window.setTimeout(() => setInviteMessage(''), 4_000)
    return () => window.clearTimeout(timer)
  }, [inviteMessage])

  async function invite(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setInviteMessage('')
    try {
      const result = await apiRequest<{ emailDelivered: boolean }>(`/organizations/${organization.id}/invitations/email`, { method: 'POST', body: { email } })
      setInviteMessage(result.emailDelivered ? 'Приглашение отправлено.' : 'Приглашение создано, но письмо отправить не удалось.')
      setEmail('')
      await activeInvitations.refetch()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отправить приглашение.') }
    finally { setBusy(false) }
  }

  async function createCode() {
    setBusy(true); setError('')
    try {
      const result = await apiRequest<{ invitationId: string; code: string; expiresAt: string }>(`/organizations/${organization.id}/invitations/code`, { method: 'POST', body: {} })
      setCode(result.code); setCodeInvitationId(result.invitationId); setCodeExpiry(result.expiresAt)
      await activeInvitations.refetch()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось создать код.') }
    finally { setBusy(false) }
  }

  async function revokeInvitation(invitationId: string) {
    setBusy(true); setError(''); setInviteMessage('')
    try {
      await apiRequest(`/organizations/${organization.id}/invitations/${invitationId}`, { method: 'DELETE' })
      if (invitationId === codeInvitationId) { setCode(''); setCodeInvitationId(''); setCodeExpiry('') }
      setInviteMessage('Приглашение отозвано.')
      await activeInvitations.refetch()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отозвать приглашение.') }
    finally { setBusy(false) }
  }

  return <div className="workspace-dashboard"><header><p className="app-eyebrow">Обзор</p><h1>{organization.name}</h1><p>{organization.description || 'Рабочее пространство организации готово к настройке.'}</p></header>
    <div className="workspace-overview"><article><strong>{organization.memberCount ?? 0}</strong><span>участников</span></article><article><strong>{organization.timezone}</strong><span>часовой пояс</span></article><article><strong>{roleNames[organization.role]}</strong><span>ваша роль</span></article></div>
    {(organization.contactEmail || organization.phone || organization.website || organization.address) && <section className="organization-public-card"><div><p className="app-eyebrow">Контакты</p><h2>Профиль организации</h2></div><dl>{organization.contactEmail && <div><dt>Почта</dt><dd><a href={`mailto:${organization.contactEmail}`}>{organization.contactEmail}</a></dd></div>}{organization.phone && <div><dt>Телефон</dt><dd><a href={`tel:${organization.phone}`}>{formatRussianPhone(organization.phone)}</a></dd></div>}{organization.website && <div><dt>Сайт</dt><dd><a href={organization.website} target="_blank" rel="noreferrer">{organization.website.replace(/^https?:\/\//, '')}</a></dd></div>}{organization.address && <div><dt>Адрес</dt><dd>{organization.address}</dd></div>}</dl></section>}
    {canInvite && <section className="admin-card"><div><p className="app-eyebrow">Управление командой</p><h2>Пригласить сотрудника</h2><p>Новый участник присоединится с ролью пользователя.</p></div><div className="admin-card__columns"><form onSubmit={invite}><label><span>Электронная почта</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="employee@example.com" required /></label><button className="app-primary" disabled={busy}>Отправить приглашение</button></form><div className="code-generator"><span>Одноразовый код</span>{code ? <><button className="generated-code" type="button" title="Скопировать" onClick={() => void navigator.clipboard.writeText(code)}>{code}</button><small>Действует до {new Date(codeExpiry).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} и используется один раз.</small><button className="app-secondary" type="button" disabled={busy} onClick={() => void revokeInvitation(codeInvitationId)}>Отозвать код</button></> : <button className="app-secondary" type="button" disabled={busy} onClick={() => void createCode()}>Создать код</button>}</div></div>{error && <p className="app-alert app-alert--error">{error}</p>}{inviteMessage && <p className="app-alert">{inviteMessage}</p>}
      {activeInvitations.isLoading ? <p className="active-invitations__state">Загружаем активные приглашения…</p> : activeInvitations.data?.invitations.length ? <div className="active-invitations"><h3>Активные приглашения</h3>{activeInvitations.data.invitations.map((invitation) => <div className="active-invitation" key={invitation.id}><div><strong>{invitation.type === 'EMAIL' ? invitation.invitedEmail : 'Одноразовый код'}</strong><span>до {new Date(invitation.expiresAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span></div><button type="button" disabled={busy} onClick={() => void revokeInvitation(invitation.id)}>Отозвать</button></div>)}</div> : null}
    </section>}
  </div>
}
