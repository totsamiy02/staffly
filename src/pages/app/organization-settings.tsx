import { useEffect, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useOrganizationMembers } from '../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import { formatRussianPhone, isCompleteRussianPhone } from '../../app/profile/phone.ts'
import SensitiveCodeInput from './sensitive-code-input.tsx'
import ImageUpload from '../../component/ui/image-upload/image-upload.tsx'
import { RUSSIAN_TIMEZONES } from '../../app/organizations/russian-timezones.ts'

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
  const [name, setName] = useState(organization.name)
  const [description, setDescription] = useState(organization.description ?? '')
  const [timezone, setTimezone] = useState(organization.timezone)
  const [contactEmail, setContactEmail] = useState(organization.contactEmail ?? '')
  const [phone, setPhone] = useState(formatRussianPhone(organization.phone ?? ''))
  const [website, setWebsite] = useState(organization.website ?? '')
  const [address, setAddress] = useState(organization.address ?? '')
  const canEditProfile = organization.role === 'OWNER' || organization.role === 'ADMIN'

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 5_000)
    return () => window.clearTimeout(timer)
  }, [message])

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

  function saveOrganization(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      if (name.trim().length < 2) throw new Error('Название должно содержать не менее двух символов.')
      if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new Error('Укажите корректную рабочую почту.')
      if (!isCompleteRussianPhone(phone)) throw new Error('Введите российский номер полностью: +7 (999) 123-45-67.')
      if (website && !/^https?:\/\/[^\s]+$/i.test(website)) throw new Error('Адрес сайта должен начинаться с http:// или https://.')
      await apiRequest(`/organizations/${organization.id}`, { method: 'PATCH', body: { name, description, timezone, contactEmail, phone, website, address } })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['organization', organization.id] }), queryClient.invalidateQueries({ queryKey: ['organizations'] })])
      setMessage('Профиль организации сохранён.')
    })
  }

  const candidates = members.data?.members.filter((member) => member.userId !== user?.id && member.role !== 'OWNER') ?? []

  return <section className="settings-page"><header><p className="app-eyebrow">Организация</p><h1>Настройки</h1><p>Критические действия подтверждаются одноразовым кодом из письма.</p></header>
    {error && <p className="app-alert app-alert--error">{error}</p>}{message && <p className="app-alert">{message}</p>}
    <article className="organization-profile-editor"><div><p className="app-eyebrow">Публичная информация</p><h2>Профиль организации</h2><p>Эти данные доступны всем участникам организации.</p></div>{canEditProfile ? <form onSubmit={saveOrganization}><div className="organization-logo-editor"><ImageUpload endpoint={`/organizations/${organization.id}/logo`} imageUrl={organization.logoUrl} name={organization.name} avatarClassName="organization-logo-editor__preview" onChange={async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['organization', organization.id] }), queryClient.invalidateQueries({ queryKey: ['organizations'] })]) }} onMessage={setMessage} onError={setError} /></div><div className="organization-profile-fields"><label><span>Название</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={120} required /></label><label><span>Часовой пояс</span><select value={timezone} onChange={(event) => setTimezone(event.target.value)}>{RUSSIAN_TIMEZONES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><label><span>Рабочая почта</span><input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} maxLength={254} placeholder="hello@company.ru" /></label><label><span>Телефон</span><input type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(formatRussianPhone(event.target.value))} maxLength={18} placeholder="+7 (999) 123-45-67 или 8 (999) 123-45-67" /></label><label className="profile-field--wide"><span>Сайт</span><input type="url" value={website} onChange={(event) => setWebsite(event.target.value)} maxLength={2048} placeholder="https://company.ru" /></label><label className="profile-field--wide"><span>Адрес</span><input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={300} placeholder="Город, улица, дом" /></label><label className="profile-field--wide"><span>Описание</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={4} /><small>{description.length}/1000</small></label></div><button className="app-primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить данные'}</button></form> : <><div className="organization-logo-editor"><ImageUpload endpoint={`/organizations/${organization.id}/logo`} imageUrl={organization.logoUrl} name={organization.name} avatarClassName="organization-logo-editor__preview" disabled onChange={() => undefined} onMessage={setMessage} onError={setError} /></div><p className="organization-profile-editor__readonly">Изменять профиль могут владелец и администраторы.</p></>}</article>
    {organization.role === 'OWNER' && <><article className="settings-card"><div><h2>Передать владение</h2><p>Вы станете администратором, а выбранный участник — новым владельцем.</p></div>{transferRequested ? <form onSubmit={confirmTransfer} className="sensitive-form"><SensitiveCodeInput value={transferCode} onChange={setTransferCode} label="Код подтверждения передачи владения" /><button className="app-primary" disabled={busy || transferCode.length !== 6}>Подтвердить передачу</button><button className="app-secondary" type="button" onClick={() => setTransferRequested(false)}>Отмена</button></form> : <form onSubmit={requestTransfer} className="sensitive-form"><select value={targetMemberId} onChange={(event) => setTargetMemberId(event.target.value)} required><option value="">Выберите участника</option>{candidates.map((member) => <option value={member.id} key={member.id}>{member.email} — {member.role === 'ADMIN' ? 'Администратор' : 'Пользователь'}</option>)}</select><button className="app-primary" disabled={busy || !targetMemberId}>Получить код</button></form>}</article>
    <article className="settings-card settings-card--danger"><div><h2>Удалить организацию</h2><p>Организация исчезнет у всех участников, а активные приглашения будут отозваны.</p></div>{deleteRequested ? <form onSubmit={confirmDeletion} className="sensitive-form"><SensitiveCodeInput value={deleteCode} onChange={setDeleteCode} label="Код подтверждения удаления организации" /><button className="app-danger" disabled={busy || deleteCode.length !== 6}>Удалить организацию</button><button className="app-secondary" type="button" onClick={() => setDeleteRequested(false)}>Отмена</button></form> : <button className="app-danger" disabled={busy} onClick={requestDeletion}>Получить код удаления</button>}</article></>}
  </section>
}
