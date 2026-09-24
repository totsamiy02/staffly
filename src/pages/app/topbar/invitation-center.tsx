import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useAccountNotifications, usePendingInvitations } from '../../../app/organizations/queries.ts'
import { useShiftNotifications } from '../../../app/schedule/queries.ts'
import { formatTime, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { Link } from 'react-router-dom'

function EnvelopeIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4.5 7 7.5 5.5L19.5 7" /></svg>
}

function expiresIn(expiresAt: string, now: number) {
  const difference = Math.max(0, new Date(expiresAt).getTime() - now)
  const minutes = Math.ceil(difference / 60_000)
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `${hours} ч`
  const days = Math.floor(hours / 24)
  return `${days} д ${hours % 24} ч`
}

type InvitationCenterProps = {
  open: boolean
  onToggle: () => void
  onClose: () => void
}

export default function InvitationCenter({ open, onToggle, onClose }: InvitationCenterProps) {
  const { apiRequest } = useAuth()
  const invitations = usePendingInvitations()
  const shiftNotifications = useShiftNotifications()
  const accountNotifications = useAccountNotifications()
  const queryClient = useQueryClient()
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const items = invitations.data?.invitations ?? []
  const shifts = shiftNotifications.data?.notifications ?? []
  const accountItems = accountNotifications.data?.notifications ?? []
  const total = items.length + shifts.length + accountItems.length

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'accept' | 'reject' }) => apiRequest(`/invitations/${id}/${kind}`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setError('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['invitations'] }),
        queryClient.invalidateQueries({ queryKey: ['organizations'] }),
      ])
    },
    onError: (failure) => setError(failure instanceof Error ? failure.message : 'Не удалось обработать приглашение.'),
  })
  const readShift = useMutation({
    mutationFn: (id: string) => apiRequest(`/shift-notifications/${id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shift-notifications'] }),
  })
  const readAccount = useMutation({
    mutationFn: (id: string) => apiRequest(`/account-notifications/${id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account-notifications'] }),
  })

  return <div className="topbar-popover-host">
    <button className={`topbar-icon-button${open ? ' topbar-icon-button--active' : ''}`} type="button" aria-label="Уведомления" aria-expanded={open} onClick={onToggle}>
      <EnvelopeIcon />
      {total > 0 && <span className="topbar-notification-badge">{total > 9 ? '9+' : total}</span>}
    </button>
    {open && <section className="topbar-popover topbar-popover--notifications" aria-label="Уведомления">
      <header><div><p className="app-eyebrow">Центр уведомлений</p><h2>Уведомления</h2></div><button type="button" aria-label="Закрыть уведомления" onClick={onClose}>×</button></header>
      {error && <p className="topbar-popover__error" role="alert">{error}</p>}
      {invitations.isLoading || shiftNotifications.isLoading || accountNotifications.isLoading ? <div className="topbar-popover__state"><span className="app-spinner" />Загружаем…</div> : invitations.isError || shiftNotifications.isError || accountNotifications.isError ? <div className="topbar-popover__state"><span>Не удалось получить уведомления.</span><button type="button" onClick={() => { void invitations.refetch(); void shiftNotifications.refetch(); void accountNotifications.refetch() }}>Повторить</button></div> : total === 0 ? <div className="topbar-popover__empty"><span><EnvelopeIcon /></span><strong>Новых уведомлений нет</strong><p>Приглашения, заявки, роли и назначенные смены появятся здесь.</p></div> : <div className="topbar-invitations">{accountItems.map((notification) => <Link className="topbar-invitation topbar-shift-notification" to={notification.requestId ? `/app/organizations/${notification.organization.id}/requests?tab=${notification.type === 'REQUEST_CREATED' ? 'incoming' : 'mine'}&request=${notification.requestId}` : `/app/organizations/${notification.organization.id}`} onClick={() => { readAccount.mutate(notification.id); onClose() }} key={notification.id}><span className="topbar-invitation__avatar">{notification.organization.name.slice(0, 1).toUpperCase()}</span><div className="topbar-invitation__body"><strong>{notification.title}</strong><p>{notification.message}</p><small>{new Date(notification.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</small></div></Link>)}{shifts.map((shift) => { const date = zonedDateAndTime(shift.scheduledStartAt, shift.organization.timezone).date; const month = date.slice(0, 7); return <Link className="topbar-invitation topbar-shift-notification" to={`/app/organizations/${shift.organization.id}/schedule?view=mine&month=${month}&shift=${shift.id}`} onClick={() => { readShift.mutate(shift.id); onClose() }} key={shift.id}>
        <span className="topbar-invitation__avatar">{shift.organization.name.slice(0, 1).toUpperCase()}</span>
        <div className="topbar-invitation__body"><strong>Новая смена · {shift.organization.name}</strong><p>{new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(new Date(`${date}T00:00:00Z`))}</p><small>{formatTime(shift.scheduledStartAt, shift.organization.timezone)}–{formatTime(shift.scheduledEndAt, shift.organization.timezone)}</small></div>
      </Link> })}{items.map((invitation) => <article className="topbar-invitation" key={invitation.id}>
        <span className="topbar-invitation__avatar">{invitation.organization.name.slice(0, 1).toUpperCase()}</span>
        <div className="topbar-invitation__body"><strong>{invitation.organization.name}</strong><p>Приглашение от {invitation.invitedBy}</p><small>Активно ещё {expiresIn(invitation.expiresAt, now)}</small><div><button className="app-primary app-primary--small" disabled={action.isPending} onClick={() => action.mutate({ id: invitation.id, kind: 'accept' })}>Принять</button><button className="app-secondary" disabled={action.isPending} onClick={() => action.mutate({ id: invitation.id, kind: 'reject' })}>Отклонить</button></div></div>
      </article>)}</div>}
    </section>}
  </div>
}
