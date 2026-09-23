import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useOrganizations, usePendingInvitations } from '../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import AppTopbar from './app-topbar.tsx'
import Avatar from '../../component/ui/avatar/avatar.tsx'
import './app.scss'

function OrganizationGrid({ title, organizations }: { title: string; organizations: OrganizationSummary[] }) {
  if (!organizations.length) return null
  return <section className="organizations-section">
    <h2>{title}</h2>
    <div className="organization-grid">
      {organizations.map((organization) => <Link className="organization-card" to={`/app/organizations/${organization.id}`} key={organization.id}>
        <Avatar url={organization.logoUrl} name={organization.name} className="organization-card__avatar" />
        <strong>{organization.name}</strong>
        <span>{organization.memberCount} {organization.memberCount === 1 ? 'участник' : 'участников'}</span>
        <small>{organization.role === 'OWNER' ? 'Владелец' : organization.role === 'ADMIN' ? 'Администратор' : 'Пользователь'}</small>
      </Link>)}
    </div>
  </section>
}

export default function OrganizationsPage() {
  const { apiRequest } = useAuth()
  const queryClient = useQueryClient()
  const organizations = useOrganizations()
  const invitations = usePendingInvitations()
  const refetchInvitations = invitations.refetch
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<{ organization: { id: string; name: string }; expiresAt: string } | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['organizations'] }), queryClient.invalidateQueries({ queryKey: ['invitations'] })]) }
  const actOnInvite = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'accept' | 'reject' }) => apiRequest<{ organizationId?: string }>(`/invitations/${id}/${action}`, { method: 'POST', body: {} }), onSuccess: refresh, onError: (failure) => setError(failure instanceof Error ? failure.message : 'Не удалось обработать приглашение.') })
  const previewCode = useMutation({ mutationFn: () => apiRequest<{ invitation: typeof preview }>('/invitations/code/preview', { method: 'POST', body: { code } }), onSuccess: (result) => { setPreview(result.invitation); setError('') }, onError: (failure) => setError(failure instanceof Error ? failure.message : 'Код не найден.') })
  const acceptCode = useMutation({ mutationFn: () => apiRequest<{ organizationId: string }>('/invitations/code/accept', { method: 'POST', body: { code } }), onSuccess: async () => { setPreview(null); setCode(''); setMessage('Вы присоединились к организации.'); await refresh() }, onError: (failure) => setError(failure instanceof Error ? failure.message : 'Не удалось принять приглашение.') })
  const emailToken = params.get('invite')

  useEffect(() => {
    if (location.hash !== '#join-organization') return
    const frame = window.requestAnimationFrame(() => document.getElementById('join-organization')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    return () => window.cancelAnimationFrame(frame)
  }, [location.hash])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 5_000)
    return () => window.clearTimeout(timer)
  }, [message])

  function updateInviteCode(value: string) {
    const raw = value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 12)
    setCode(raw.match(/.{1,4}/g)?.join('-') ?? '')
    setPreview(null)
  }

  useEffect(() => {
    if (!emailToken) return
    let active = true
    void apiRequest<{ invitation: { id: string; organization: { id: string; name: string }; expiresAt: string } }>('/invitations/email/preview', { method: 'POST', body: { token: emailToken } })
      .then((result) => { if (active) setMessage(`Приглашение в «${result.invitation.organization.name}» доступно ниже.`) })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Приглашение недоступно.') })
      .finally(() => { if (active) { setParams((current) => { const next = new URLSearchParams(current); next.delete('invite'); return next }, { replace: true }); void refetchInvitations() } })
    return () => { active = false }
  }, [apiRequest, emailToken, refetchInvitations, setParams])

  function submitCode(event: FormEvent) { event.preventDefault(); setError(''); setMessage(''); previewCode.mutate() }
  const owned = organizations.data?.organizations.filter((item) => item.role === 'OWNER') ?? []
  const joined = organizations.data?.organizations.filter((item) => item.role !== 'OWNER') ?? []
  const busy = previewCode.isPending || acceptCode.isPending

  return <div className="app-page">
    <AppTopbar />
    <main className="organizations-page">
      <div className="organizations-page__heading"><div><p>Рабочее пространство</p><h1>Ваши организации</h1></div><Link className="app-primary" to="/app/organizations/new"><span>+</span> Создать организацию</Link></div>
      {error && <p className="app-alert app-alert--error" role="alert">{error}</p>}
      {message && <p className="app-alert" role="status">{message}</p>}

      {invitations.data?.invitations.length ? <section className="invitation-panel"><div><p className="app-eyebrow">Новые приглашения</p><h2>Вас ждут в команде</h2></div><div className="invitation-list">{invitations.data.invitations.map((invitation) => <article className="invitation-card" key={invitation.id}><span className="organization-card__avatar">{invitation.organization.name.slice(0, 1).toUpperCase()}</span><div><strong>{invitation.organization.name}</strong><p>Приглашение от {invitation.invitedBy}</p></div><div className="invitation-card__actions"><button className="app-primary app-primary--small" disabled={actOnInvite.isPending} onClick={() => actOnInvite.mutate({ id: invitation.id, action: 'accept' })}>Принять</button><button className="app-secondary" disabled={actOnInvite.isPending} onClick={() => actOnInvite.mutate({ id: invitation.id, action: 'reject' })}>Отклонить</button></div></article>)}</div></section> : null}

      {organizations.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем организации…</div> : organizations.isError ? <div className="app-state"><p>Не удалось загрузить организации.</p><button className="app-secondary" onClick={() => void organizations.refetch()}>Повторить</button></div> : <>
        {!owned.length && !joined.length && <div className="organizations-empty"><span className="organizations-empty__mark">S</span><h2>Создайте первое рабочее пространство</h2><p>Здесь появятся ваши организации и команды, к которым вас пригласили.</p></div>}
        <OrganizationGrid title="Созданные вами" organizations={owned} />
        <OrganizationGrid title="Организации, где вы состоите" organizations={joined} />
      </>}

      <section className="join-card" id="join-organization"><div><p className="app-eyebrow">Есть код приглашения?</p><h2>Присоединиться к организации</h2><p>Введите одноразовый код, который вам передал администратор.</p></div><form onSubmit={submitCode}><input value={code} onChange={(event) => updateInviteCode(event.target.value)} placeholder="XXXX-XXXX-XXXX" maxLength={14} pattern="[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}" autoComplete="off" required /><button className="app-primary" disabled={busy || code.length !== 14}>Проверить код</button></form>{preview && <div className="invite-preview"><span className="organization-card__avatar">{preview.organization.name.slice(0, 1).toUpperCase()}</span><div><strong>{preview.organization.name}</strong><p>Вас приглашают присоединиться к организации.</p></div><button className="app-primary" disabled={busy} onClick={() => acceptCode.mutate()}>Присоединиться</button><button className="app-secondary" onClick={() => setPreview(null)}>Отмена</button></div>}</section>
    </main>
  </div>
}
