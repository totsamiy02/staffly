import { Link } from 'react-router-dom'
import Avatar from '../../component/ui/avatar/avatar.tsx'
import { useQuery } from '@tanstack/react-query'
import type { OrganizationLocation } from '../../app/organizations/types.ts'
import DocumentDialog from './documents/document-dialog.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import { formatTime } from '../../app/schedule/date-utils.ts'
import RequiredDocuments from './documents/required-documents.tsx'
import { useToastFeedback } from '../../component/ui/toast/toast-context.ts'
import { participantLabel, locationTone } from '../../app/organizations/format.ts'
import { useEffect, useState, type FormEvent } from 'react'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import { formatRussianPhone } from '../../app/profile/phone.ts'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useActiveOrganizationInvitations } from '../../app/organizations/queries.ts'

const roleNames = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Пользователь' } as const

export default function OrganizationDashboard({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest } = useAuth()
  type Point = OrganizationLocation & { today: string; todayMemberCount: number; shifts: Array<{ id: string; memberId: string; name: string; avatarUrl: string | null; startAt: string; endAt: string; position: string | null }> }
  const overview = useQuery({ queryKey: ['locations-overview', organization.id], queryFn: () => apiRequest<{ locations: Point[] }>(`/organizations/${organization.id}/locations/overview`), refetchInterval: 30000 })
  const [todayPointId, setTodayPointId] = useState<string | null>(null)
  const todayPoint = overview.data?.locations.find(point => point.id === todayPointId)
  const [email, setEmail] = useState('')
  const [inviteMessage, setInviteMessage] = useState('')
  const [code, setCode] = useState('')
  const [codeInvitationId, setCodeInvitationId] = useState('')
  const [codeExpiry, setCodeExpiry] = useState('')
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState('')
  const [busy, setBusy] = useState(false)
  const canInvite = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const activeInvitations = useActiveOrganizationInvitations(organization.id, canInvite)

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

  return <div className="workspace-dashboard"><header><h1>{organization.name}</h1><p>{organization.description || 'Рабочее пространство организации готово к настройке.'}</p></header>
    <div className="workspace-overview"><article><strong>{organization.memberCount ?? 0}</strong><span>{participantLabel(organization.memberCount ?? 0)}</span></article><article><strong>{organization.timezone}</strong><span>часовой пояс</span></article><article><strong>{roleNames[organization.role]}</strong><span>ваша роль</span></article></div><RequiredDocuments organizationId={organization.id} />
    <section className="location-overview"><h2>Сегодня по точкам</h2>{overview.isLoading ? <p>Загружаем смены…</p> : overview.isError ? <p role="alert">Не удалось загрузить смены. <button className="app-secondary" onClick={() => void overview.refetch()}>Повторить</button></p> : <div className="location-overview__grid">{overview.data?.locations.map(point => {
      const people = point.shifts.filter((shift, index, shifts) => shifts.findIndex(item => item.memberId === shift.memberId) === index)
      return <button type="button" className="location-today-card" data-tone={locationTone(point.id)} key={point.id} onClick={() => setTodayPointId(point.id)} aria-label={`${point.name}: сегодня на смене ${point.todayMemberCount}. Посмотреть сотрудников`}>
        <span className="location-today-card__heading"><span className="location-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></svg></span><strong>{point.name}</strong><svg className="location-today-card__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></span>
        <span className="location-today-card__address">{[point.city, point.address].filter(Boolean).join(', ') || 'Адрес не указан'}</span>
        <span className="location-today-card__metric"><strong>{point.todayMemberCount}</strong><span>на смене сегодня<small>{point.memberCount} в составе точки</small></span></span>
        <span className="location-today-card__footer"><span className="location-today-card__avatars">{people.slice(0, 4).map(person => <Avatar key={person.memberId} url={person.avatarUrl} name={person.name} className="app-avatar" />)}{people.length > 4 && <span>+{people.length - 4}</span>}</span><span>{point.shifts.length ? `Смены: ${point.shifts.length} · ${formatTime(point.shifts.reduce((first, shift) => shift.startAt < first ? shift.startAt : first, point.shifts[0].startAt), point.timezone)} — ${formatTime(point.shifts.reduce((last, shift) => shift.endAt > last ? shift.endAt : last, point.shifts[0].endAt), point.timezone)}` : 'Смены не назначены'}</span></span>
      </button>
    })}</div>}</section>
    {todayPoint && <AnimatedOverlay variant="modal" onClose={() => setTodayPointId(null)}>{close => <DocumentDialog eyebrow={todayPoint.name} title="Сегодня на смене" onClose={close}><div className="location-today-list">{todayPoint.shifts.length ? todayPoint.shifts.map(shift => <article key={shift.id}><Avatar url={shift.avatarUrl} name={shift.name} className="app-avatar" /><div><strong>{shift.name}</strong><small>{formatTime(shift.startAt, todayPoint.timezone)}–{formatTime(shift.endAt, todayPoint.timezone)}{shift.position ? ` · ${shift.position}` : ''}</small></div></article>) : <p>На сегодня смены не назначены.</p>}</div><footer><button className="app-secondary" onClick={close}>Закрыть</button><Link className="app-primary" to={`/app/organizations/${organization.id}/schedule?location=${todayPoint.id}&month=${todayPoint.today.slice(0, 7)}&day=${todayPoint.today}`}>Открыть день в расписании</Link></footer></DocumentDialog>}</AnimatedOverlay>}
    {(organization.contactEmail || organization.phone || organization.website || organization.address) && <section className="organization-public-card"><div><p className="app-eyebrow">Контакты</p><h2>Профиль организации</h2></div><dl>{organization.contactEmail && <div><dt>Почта</dt><dd><a href={`mailto:${organization.contactEmail}`}>{organization.contactEmail}</a></dd></div>}{organization.phone && <div><dt>Телефон</dt><dd><a href={`tel:${organization.phone}`}>{formatRussianPhone(organization.phone)}</a></dd></div>}{organization.website && <div><dt>Сайт</dt><dd><a href={organization.website} target="_blank" rel="noreferrer">{organization.website.replace(/^https?:\/\//, '')}</a></dd></div>}{organization.address && <div><dt>Адрес</dt><dd>{organization.address}</dd></div>}</dl></section>}
    {canInvite && <section className="admin-card"><div><p className="app-eyebrow">Управление командой</p><h2>Пригласить сотрудника</h2><p>Новый участник присоединится с ролью пользователя.</p></div><div className="admin-card__columns"><form onSubmit={invite}><label><span>Электронная почта</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="employee@example.com" required /></label><button className="app-primary" disabled={busy}>Отправить приглашение</button></form><div className="code-generator"><span>Одноразовый код</span>{code ? <><button className="generated-code" type="button" title="Скопировать" onClick={() => void navigator.clipboard.writeText(code)}>{code}</button><small>Действует до {new Date(codeExpiry).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} и используется один раз.</small><button className="app-secondary" type="button" disabled={busy} onClick={() => void revokeInvitation(codeInvitationId)}>Отозвать код</button></> : <button className="app-secondary" type="button" disabled={busy} onClick={() => void createCode()}>Создать код</button>}</div></div>{error && <p className="app-alert app-alert--error">{error}</p>}
      {activeInvitations.isLoading ? <p className="active-invitations__state">Загружаем активные приглашения…</p> : activeInvitations.data?.invitations.length ? <div className="active-invitations"><h3>Активные приглашения</h3>{activeInvitations.data.invitations.map((invitation) => <div className={`active-invitation${removing === invitation.id ? ' is-removing' : ''}`} key={invitation.id}><div><strong>{invitation.type === 'EMAIL' ? invitation.invitedEmail : invitation.code ?? 'Одноразовый код (создан ранее)'}</strong><span>до {new Date(invitation.expiresAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span></div><button type="button" disabled={busy} onClick={() => void revokeInvitation(invitation.id)}>Отозвать</button></div>)}</div> : activeInvitations.isError ? <p role="alert">Не удалось загрузить приглашения. <button onClick={() => void activeInvitations.refetch()}>Повторить</button></p> : null}
    </section>}
  </div>
}
