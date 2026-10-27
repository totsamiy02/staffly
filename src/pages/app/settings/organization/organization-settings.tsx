import AccessSettings from '../access/access-settings.tsx'
import { canAccess } from '../../../../app/access/catalog.ts'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import { useToastFeedback } from '../../../../component/ui/toast/toast-context.ts'
import PlanningSettings from '../../schedule/planning/planning-settings.tsx'
import EmployeePicker from '../../shared/employee-picker.tsx'
import { ProfileDetails, ProfileEditActions } from '../shared/profile-settings.tsx'
import Select from '../../../../component/ui/select/select.tsx'
import { useEffect, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useOrganizationDirectory } from '../../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import { formatRussianPhone, isCompleteRussianPhone } from '../../../../app/profile/phone.ts'
import SensitiveCodeInput from '../../../../component/ui/sensitive-code-input.tsx'
import ImageUpload from '../../../../component/ui/image-upload/image-upload.tsx'
import { RUSSIAN_TIMEZONES } from '../../../../app/organizations/russian-timezones.ts'
import LocationSettings from './location-settings.tsx'
import RequestTypesSettings from '../../requests/types/request-types-settings.tsx'

export default function OrganizationSettings({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const section =  ['profile', 'locations', 'schedule', 'requests', 'roles', 'access'].includes(params.get('section') ?? '') ? params.get('section')! : 'profile'
  const members = useOrganizationDirectory(organization.id, organization.owner && section === 'access')
  function changeSection(value: string) { setMessage(''); setError(''); setParams(previous => { previous.set('section', value); return previous }, { replace: true }) }
  const [targetMemberId, setTargetMemberId] = useState('')
  const [transferCode, setTransferCode] = useState('')
  const [deleteCode, setDeleteCode] = useState('')
  const [transferRequested, setTransferRequested] = useState(false)
  const [deleteRequested, setDeleteRequested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [profileEditing, setProfileEditing] = useState(false)
  const [imageBusy, setImageBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [name, setName] = useState(organization.name)
  const [description, setDescription] = useState(organization.description ?? '')
  const [timezone, setTimezone] = useState(organization.organizationTimezone ?? organization.timezone)
  const [contactEmail, setContactEmail] = useState(organization.contactEmail ?? '')
  const [phone, setPhone] = useState(formatRussianPhone(organization.phone ?? ''))
  const [website, setWebsite] = useState(organization.website ?? '')
  const [address, setAddress] = useState(organization.address ?? '')
  const planningAllowed = organization.organizationPermissions?.includes('schedule.settings') || ['coverage.manage','schedule.settings','schedule.templates','positions.manage','offers.settings'].some(key=>organization.owner || organization.permissions?.includes(key))
  const canEditProfile = canAccess(organization, 'organization.edit')
  const editing = profileEditing && canEditProfile
  useEffect(() => { setProfileEditing(false) }, [section, organization.id, canEditProfile])

  function editProfile(value: boolean) {
    setName(organization.name); setDescription(organization.description ?? '')
    setTimezone(organization.organizationTimezone ?? organization.timezone)
    setContactEmail(organization.contactEmail ?? ''); setPhone(formatRussianPhone(organization.phone ?? ''))
    setWebsite(organization.website ?? ''); setAddress(organization.address ?? '')
    setError(''); setMessage(''); setProfileEditing(value)
  }

  useToastFeedback(message, error)
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
    if (busy || !candidates.some(member => member.id === targetMemberId)) return
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
    if (!editing || busy || imageBusy) return
    void run(async () => {
      if (name.trim().length < 2) throw new Error('Название должно содержать не менее двух символов.')
      if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new Error('Укажите корректную рабочую почту.')
      if (!isCompleteRussianPhone(phone)) throw new Error('Введите российский номер полностью: +7 (999) 123-45-67.')
      if (website && !/^https?:\/\/[^\s]+$/i.test(website)) throw new Error('Адрес сайта должен начинаться с http:// или https://.')
      await apiRequest(`/organizations/${organization.id}`, { method: 'PATCH', body: { name, description, timezone, contactEmail, phone, website, address } })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['organization', organization.id] }), queryClient.invalidateQueries({ queryKey: ['organizations'] })])
      setMessage('Профиль организации сохранён.')
      setProfileEditing(false)
    })
  }

  const candidates = members.data?.members.filter((member) => member.role !== 'OWNER') ?? []

  return <section className="settings-page"><header><h1>Настройки</h1><p>{canEditProfile ? 'Профиль организации и управление настройками.' : 'Публичная информация вашей организации.'}</p></header>
    <SegmentedNav label="Разделы настроек">{[['profile', 'Профиль организации'], ['locations', 'Точки'], ...(planningAllowed ? [['schedule','Расписание']] : []), ...(canAccess(organization,'requestTypes.manage') ? [['requests','Типы заявок']] : []), ...(organization.owner ? [['roles','Роли и доступ'],['access','Владение']] : [])].map(([key, label]) => <button key={key} type="button" aria-pressed={section === key} onClick={() => changeSection(key)}>{label}</button>)}</SegmentedNav>
    {section !== 'schedule' && error && <p className="app-alert app-alert--error">{error}</p>}
    {section === 'roles' && organization.role === 'OWNER' && <AccessSettings organization={organization} />}
    {section === 'profile' && <article className="organization-profile-editor">
      <div className="profile-settings-heading"><div><p className="app-eyebrow">Публичная информация</p><h2>Профиль организации</h2><p>Эти данные доступны всем участникам организации.</p></div>{canEditProfile && !editing && <ProfileEditActions editing={false} onEdit={() => editProfile(true)} onCancel={() => editProfile(false)} />}</div>
      <div className="organization-logo-editor"><ImageUpload endpoint={`/organizations/${organization.id}/logo`} imageUrl={organization.logoUrl} name={organization.name} avatarClassName="organization-logo-editor__preview" disabled={!editing || busy} onBusyChange={setImageBusy} onChange={async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['organization', organization.id] }), queryClient.invalidateQueries({ queryKey: ['organizations'] })]) }} onMessage={setMessage} onError={setError} /></div>
      {editing ? <form onSubmit={saveOrganization}>
        <fieldset className="profile-edit-fields" disabled={busy || imageBusy}><div className="organization-profile-fields">
          <label><span>Название</span><input autoFocus value={name} onChange={event => setName(event.target.value)} minLength={2} maxLength={120} required /></label>
          <label><span>Часовой пояс</span><Select disabled={busy || imageBusy} value={timezone} onChange={event => setTimezone(event.target.value)}>{RUSSIAN_TIMEZONES.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</Select></label>
          <label><span>Рабочая почта</span><input type="email" value={contactEmail} onChange={event => setContactEmail(event.target.value)} maxLength={254} placeholder="hello@company.ru" /></label>
          <label><span>Телефон</span><input type="tel" inputMode="tel" value={phone} onChange={event => setPhone(formatRussianPhone(event.target.value))} maxLength={18} placeholder="+7 (999) 123-45-67" /></label>
          <label className="profile-field--wide"><span>Сайт</span><input type="url" value={website} onChange={event => setWebsite(event.target.value)} maxLength={2048} placeholder="https://company.ru" /></label>
          <label className="profile-field--wide"><span>Адрес</span><input value={address} onChange={event => setAddress(event.target.value)} maxLength={300} placeholder="Город, улица, дом" /></label>
          <label className="profile-field--wide"><span>Описание</span><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} rows={4} /><small>{description.length}/1000</small></label>
        </div></fieldset>
        <ProfileEditActions editing busy={busy || imageBusy} onEdit={() => editProfile(true)} onCancel={() => editProfile(false)} />
      </form> : <div className="profile-details-groups">
        <ProfileDetails title="Об организации" icon="building" items={[
          { label: 'Название', value: organization.name },
          { label: 'Часовой пояс', value: RUSSIAN_TIMEZONES.find(item => item.value === (organization.organizationTimezone ?? organization.timezone))?.label ?? organization.organizationTimezone ?? organization.timezone },
        ]} />
        <ProfileDetails title="Контакты и адрес" icon="mail" items={[
          { label: 'Рабочая почта', value: organization.contactEmail }, { label: 'Телефон', value: formatRussianPhone(organization.phone ?? '') },
          { label: 'Сайт', value: organization.website }, { label: 'Адрес', value: organization.address },
        ]} />
        <ProfileDetails title="Описание" icon="info" columns={1} prose items={[
          { label: 'Информация для команды', value: organization.description },
        ]} />
      </div>}

    </article>}
    {section === 'schedule' && planningAllowed && <PlanningSettings organization={organization} />}
    {section === 'locations' && <LocationSettings organization={organization} />}
    {section === 'requests' && canAccess(organization,'requestTypes.manage') && <RequestTypesSettings organization={organization} onMessage={setMessage} onError={setError} />}
    {section === 'access' && organization.role === 'OWNER' && <><article className="settings-card"><div><h2>Передать владение</h2><p>Вы станете администратором, а выбранный участник — новым владельцем.</p></div>{transferRequested ? <form onSubmit={confirmTransfer} className="sensitive-form"><SensitiveCodeInput value={transferCode} onChange={setTransferCode} label="Код подтверждения передачи владения" /><button className="app-primary" disabled={busy || transferCode.length !== 6}>Подтвердить передачу</button><button className="app-secondary" type="button" onClick={() => setTransferRequested(false)}>Отмена</button></form> : <form onSubmit={requestTransfer} className="sensitive-form ownership-transfer-form"><EmployeePicker label="Новый владелец" emptyLabel={members.isLoading ? 'Загружаем сотрудников…' : 'Выберите сотрудника'} members={candidates} value={targetMemberId} onChange={setTargetMemberId} disabled={busy || members.isLoading || members.isError || !candidates.length} /><button className="app-primary" disabled={busy || members.isLoading || members.isError || !candidates.some(member => member.id === targetMemberId)}>Получить код</button>{members.isError ? <p className="form-inline-error" role="alert">Не удалось загрузить сотрудников. <button className="app-secondary" type="button" onClick={() => void members.refetch()}>Повторить</button></p> : !members.isLoading && !candidates.length && <p className="profile-settings-note">Для передачи владения нужен другой сотрудник организации.</p>}</form>}</article>
    <article className="settings-card settings-card--danger"><div><h2>Удалить организацию</h2><p>Организация исчезнет у всех участников, а активные приглашения будут отозваны.</p></div>{deleteRequested ? <form onSubmit={confirmDeletion} className="sensitive-form"><SensitiveCodeInput value={deleteCode} onChange={setDeleteCode} label="Код подтверждения удаления организации" /><button className="app-danger" disabled={busy || deleteCode.length !== 6}>Удалить организацию</button><button className="app-secondary" type="button" onClick={() => setDeleteRequested(false)}>Отмена</button></form> : <button className="app-danger" disabled={busy} onClick={requestDeletion}>Получить код удаления</button>}</article></>}
  </section>
}
