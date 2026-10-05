import DocumentDialog from './documents/document-dialog.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import { useToastFeedback } from '../../component/ui/toast/toast-context.ts'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useActiveOrganizationInvitations, useLocations } from '../../app/organizations/queries.ts'



import Select from '../../component/ui/select/select.tsx'
export default function MemberInvitations({ organization, onClose }: { organization: OrganizationSummary; onClose: () => void }) {
  const { apiRequest: scopedRequest } = useAuth()
  const locations = useLocations(organization.id)
  const owner = (organization.organizationRole ?? organization.role) === 'OWNER'
  const manageable = useMemo(() => locations.data?.locations.filter(point => !point.archivedAt && (owner || point.role === 'ADMIN')) ?? [], [locations.data, owner])
  const [pointId, setPointId] = useState(() => manageable.find(point => point.id === organization.locationId)?.id ?? manageable[0]?.id ?? '')
  useEffect(() => { if (!manageable.some(point => point.id === pointId) && manageable.length) setPointId(manageable[0].id) }, [pointId, manageable])
  const apiRequest: typeof scopedRequest = (path, options) => scopedRequest(`${path}${path.includes('?') ? '&' : '?'}locationId=${pointId}`, options)
  const [method, setMethod] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [inviteMessage, setInviteMessage] = useState('')
  const [code, setCode] = useState('')
  const [codeInvitationId, setCodeInvitationId] = useState('')
  const [codeExpiry, setCodeExpiry] = useState('')
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState('')
  const [busy, setBusy] = useState(false)
  const canInvite = Boolean(pointId)
  const activeInvitations = useActiveOrganizationInvitations(organization.id, canInvite, pointId)

  useToastFeedback(inviteMessage, error)
  useEffect(() => {
    const active = activeInvitations.data?.invitations.find(item => item.type === 'CODE' && item.code)
    setCode(active?.code ?? ''); setCodeInvitationId(active?.id ?? ''); setCodeExpiry(active?.expiresAt ?? '')
  }, [activeInvitations.data])

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
      setRemoving(invitationId)
      await new Promise(resolve => window.setTimeout(resolve, 180))
      if (invitationId === codeInvitationId) { setCode(''); setCodeInvitationId(''); setCodeExpiry('') }
      setInviteMessage('Приглашение отозвано.')
      await activeInvitations.refetch()
      setRemoving('')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отозвать приглашение.') }
    finally { setBusy(false) }
  }

  return <AnimatedOverlay variant="modal" dismissible={!busy} onClose={onClose}>{close => <DocumentDialog className="members-dialog members-invite-dialog" title="Пригласить сотрудника" eyebrow="Сотрудники" busy={busy} onClose={close}><div className="member-invitations-content"><p className="invite-intro">Добавьте человека в команду — отправьте письмо или передайте ему код приглашения.</p><div className="invite-methods" role="tablist" aria-label="Способ приглашения"><button type="button" role="tab" aria-selected={method === 'email'} onClick={() => setMethod('email')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/></svg>По почте</button><button type="button" role="tab" aria-selected={method === 'code'} onClick={() => setMethod('code')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/></svg>По коду</button></div><label><span>Точка приглашения</span><Select value={pointId} disabled={busy || !canInvite} onChange={event => { setPointId(event.target.value); setError(''); setInviteMessage('') }}>{manageable.map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label><p className="member-dialog-hint">Сотрудник присоединится к выбранной точке. Роль и должности можно настроить позже.</p><div className="invite-panel" role="tabpanel" aria-label={method === 'email' ? 'Приглашение по почте' : 'Приглашение по коду'}>{method === 'email' ? <form onSubmit={invite}><label><span>Электронная почта</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="employee@example.com" required /></label><button className="app-primary" disabled={busy || !canInvite}>Отправить приглашение</button></form> : <div className="code-generator"><strong>Личное приглашение</strong><p className="member-dialog-hint">Передайте код сотруднику. Он введёт его при присоединении к организации.</p>{code ? <><button className="generated-code" type="button" title="Скопировать" onClick={() => void navigator.clipboard.writeText(code).then(() => setInviteMessage('Код скопирован.')).catch(() => setError('Не удалось скопировать код. Выделите и скопируйте его вручную.'))}>{code}</button><small>Действует до {new Date(codeExpiry).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} и используется один раз.</small><button className="app-secondary" type="button" disabled={busy || !canInvite} onClick={() => void revokeInvitation(codeInvitationId)}>Отозвать код</button></> : <button className="app-secondary" type="button" disabled={busy || !canInvite} onClick={() => void createCode()}>Создать код</button>}</div>}</div>{error && <p className="app-alert app-alert--error">{error}</p>}
      {activeInvitations.isLoading ? <p className="active-invitations__state">Загружаем активные приглашения…</p> : activeInvitations.data?.invitations.length ? <div className="active-invitations"><h3>Активные приглашения</h3>{activeInvitations.data.invitations.map((invitation) => <div className={`active-invitation${removing === invitation.id ? ' is-removing' : ''}`} key={invitation.id}><div><strong>{invitation.type === 'EMAIL' ? invitation.invitedEmail : invitation.code ?? 'Одноразовый код (создан ранее)'}</strong><span>до {new Date(invitation.expiresAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span></div><button type="button" disabled={busy || !canInvite} onClick={() => void revokeInvitation(invitation.id)}>Отозвать</button></div>)}</div> : activeInvitations.isError ? <p role="alert">Не удалось загрузить приглашения. <button onClick={() => void activeInvitations.refetch()}>Повторить</button></p> : null}
    </div></DocumentDialog>}</AnimatedOverlay>
}
