import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useOrganizationMembers } from '../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import SensitiveCodeInput from './sensitive-code-input.tsx'

export default function OrganizationSettings({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest, user } = useAuth()
  const members = useOrganizationMembers(organization.id)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [targetMemberId, setTargetMemberId] = useState('')
  const [transferCode, setTransferCode] = useState('')
  const [deleteCode, setDeleteCode] = useState('')
  const [transferRequested, setTransferRequested] = useState(false)
  const [deleteRequested, setDeleteRequested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось выполнить действие.') }
    finally { setBusy(false) }
  }

  function requestTransfer(event: FormEvent) {
    event.preventDefault()
    void run(async () => { await apiRequest(`/organizations/${organization.id}/ownership-transfer/request`, { method: 'POST', body: { targetMemberId } }); setTransferRequested(true); setMessage('Код отправлен на почту владельца.') })
  }

  function confirmTransfer(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      await apiRequest(`/organizations/${organization.id}/ownership-transfer/confirm`, { method: 'POST', body: { code: transferCode } })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['organization', organization.id] }), queryClient.invalidateQueries({ queryKey: ['organization-members', organization.id] }), queryClient.invalidateQueries({ queryKey: ['organizations'] })])
      setTransferRequested(false); setMessage('Владение организацией передано.')
    })
  }

  function requestDeletion() {
    void run(async () => { await apiRequest(`/organizations/${organization.id}/delete/request`, { method: 'POST', body: {} }); setDeleteRequested(true); setMessage('Код удаления отправлен на вашу почту.') })
  }

  function confirmDeletion(event: FormEvent) {
    event.preventDefault()
    void run(async () => { await apiRequest(`/organizations/${organization.id}/delete/confirm`, { method: 'POST', body: { code: deleteCode } }); await queryClient.invalidateQueries({ queryKey: ['organizations'] }); navigate('/app', { replace: true }) })
  }

  if (organization.role !== 'OWNER') return <section className="settings-page"><header><p className="app-eyebrow">Организация</p><h1>Настройки</h1><p>Критические настройки доступны владельцу организации.</p></header></section>
  const candidates = members.data?.members.filter((member) => member.userId !== user?.id && member.role !== 'OWNER') ?? []

  return <section className="settings-page"><header><p className="app-eyebrow">Организация</p><h1>Настройки</h1><p>Критические действия подтверждаются одноразовым кодом из письма.</p></header>
    {error && <p className="app-alert app-alert--error">{error}</p>}{message && <p className="app-alert">{message}</p>}
    <article className="settings-card"><div><h2>Передать владение</h2><p>Вы станете администратором, а выбранный участник — новым владельцем.</p></div>{transferRequested ? <form onSubmit={confirmTransfer} className="sensitive-form"><SensitiveCodeInput value={transferCode} onChange={setTransferCode} label="Код подтверждения передачи владения" /><button className="app-primary" disabled={busy || transferCode.length !== 6}>Подтвердить передачу</button><button className="app-secondary" type="button" onClick={() => setTransferRequested(false)}>Отмена</button></form> : <form onSubmit={requestTransfer} className="sensitive-form"><select value={targetMemberId} onChange={(event) => setTargetMemberId(event.target.value)} required><option value="">Выберите участника</option>{candidates.map((member) => <option value={member.id} key={member.id}>{member.email} — {member.role}</option>)}</select><button className="app-primary" disabled={busy || !targetMemberId}>Получить код</button></form>}</article>
    <article className="settings-card settings-card--danger"><div><h2>Удалить организацию</h2><p>Организация исчезнет у всех участников, а активные приглашения будут отозваны.</p></div>{deleteRequested ? <form onSubmit={confirmDeletion} className="sensitive-form"><SensitiveCodeInput value={deleteCode} onChange={setDeleteCode} label="Код подтверждения удаления организации" /><button className="app-danger" disabled={busy || deleteCode.length !== 6}>Удалить организацию</button><button className="app-secondary" type="button" onClick={() => setDeleteRequested(false)}>Отмена</button></form> : <button className="app-danger" disabled={busy} onClick={requestDeletion}>Получить код удаления</button>}</article>
  </section>
}
