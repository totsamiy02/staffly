import LocationFields, { type LocationFieldsValue } from './location-fields.tsx'
import Select from '../../component/ui/select/select.tsx'
import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import AppTopbar from './app-topbar.tsx'
import './app.scss'
import { RUSSIAN_TIMEZONES, russianTimezoneOrMoscow } from '../../app/organizations/russian-timezones.ts'

export default function CreateOrganizationPage() {
  const { apiRequest } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const detectedTimezone = russianTimezoneOrMoscow(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [timezone, setTimezone] = useState(detectedTimezone)
  const [locations, setLocations] = useState<LocationFieldsValue[]>([{ name: '', city: '', address: '', timezone: detectedTimezone, teamNames: [] }])
  const [error, setError] = useState('')
  const create = useMutation({
    mutationFn: () => apiRequest<{ organization: OrganizationSummary }>('/organizations', { method: 'POST', body: { name, description, timezone, firstLocation: locations[0], locations: locations.slice(1) } }),
    onSuccess: async (result) => { await queryClient.invalidateQueries({ queryKey: ['organizations'] }); navigate(`/app/organizations/${result.organization.id}/settings?section=locations&location=${result.organization.locationId}`, { replace: true }) },
    onError: (failure) => setError(failure instanceof Error ? failure.message : 'Не удалось создать организацию.'),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (name.trim().length < 2) { setError('Название должно содержать не менее двух символов.'); return }
    create.mutate()
  }

  return <div className="app-page"><AppTopbar /><main className="organization-form-page">
    <Link className="app-back" to="/app">К организациям</Link>
    <div className="organization-form-page__intro"><p className="app-eyebrow">Новое рабочее пространство</p><h1>Создание организации</h1><p>Укажите данные организации и первой точки. Дополнительные точки и команды можно настроить сейчас или позже.</p></div>
    <form className="organization-form" onSubmit={submit}>
      <label><span>Название *</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={120} placeholder="Например, Coffee House" autoFocus required /></label>
      <label><span>Описание</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={4} placeholder="Коротко расскажите о компании" /><small>{description.length}/1000</small></label>
      <label><span>Часовой пояс *</span><Select value={timezone} onChange={(event) => setTimezone(event.target.value)}>{RUSSIAN_TIMEZONES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</Select><small>Выберите региональное время организации.</small></label>
      {locations.map((point, index) => <fieldset className="organization-location-create" key={index}><legend>{index === 0 ? 'Первая точка' : `Точка ${index + 1}`}</legend><LocationFields value={point} disabled={create.isPending} onChange={value => setLocations(previous => previous.map((item, i) => i === index ? value : item))} /><label><span>Команды этой точки · необязательно</span><textarea rows={2} value={(point.teamNames ?? []).join('\n')} placeholder="Каждая команда с новой строки" onChange={event => { const names = event.target.value.split('\n'); setLocations(previous => previous.map((item, i) => i === index ? { ...item, teamNames: names } : item)) }} /><small>Сотрудников можно назначить после приглашения в организацию.</small></label>{index > 0 && <button type="button" className="app-secondary" disabled={create.isPending} onClick={() => setLocations(previous => previous.filter((_, i) => i !== index))}>Убрать точку</button>}</fieldset>)}
      <button type="button" className="app-secondary" disabled={create.isPending || locations.length >= 50} onClick={() => setLocations(previous => [...previous, { name: '', city: '', address: '', timezone, teamNames: [] }])}>Добавить ещё точку</button>
      {error && <p className="app-alert app-alert--error" role="alert">{error}</p>}
      <div className="organization-form__actions"><Link className="app-secondary" to="/app">Отмена</Link><button className="app-primary" disabled={create.isPending}>{create.isPending ? 'Создаём…' : 'Создать организацию'}</button></div>
    </form>
  </main></div>
}
