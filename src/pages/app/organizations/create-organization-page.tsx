import { isPlanId } from '../../../app/subscriptions/plans.ts'
import LocationFields, { type LocationFieldsValue } from './location-fields.tsx'
import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import AppTopbar from '../topbar/app-topbar.tsx'
import '../app.scss'
import { russianTimezoneOrMoscow } from '../../../app/organizations/russian-timezones.ts'

export default function CreateOrganizationPage() {
  const { apiRequest } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const selectedPlan = new URLSearchParams(window.location.search).get('plan')
  const detectedTimezone = russianTimezoneOrMoscow(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [locations, setLocations] = useState<LocationFieldsValue[]>([{ name: 'Основная точка', city: '', address: '', timezone: detectedTimezone }])
  const [error, setError] = useState('')
  const create = useMutation({
    mutationFn: () => apiRequest<{ organization: OrganizationSummary }>('/organizations', { method: 'POST', body: { initialPlan: 'FREE', name, description, timezone: locations[0].timezone, firstLocation: locations[0], locations: locations.slice(1) } }),
    onSuccess: async (result) => { await queryClient.invalidateQueries({ queryKey: ['organizations'] }); navigate(`/app/organizations/${result.organization.id}/settings?${isPlanId(selectedPlan) && selectedPlan !== 'FREE' ? `section=subscription&plan=${selectedPlan}` : `section=locations&location=${result.organization.locationId}`}`, { replace: true }) },
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
    <div className="organization-form-page__intro"><p className="app-eyebrow">Новое рабочее пространство</p><h1>Создание организации</h1><p>Укажите название предприятия и основную точку. Организация начнёт работу на бесплатном тарифе.</p></div>
    <form className="organization-form" onSubmit={submit}>
      <label><span>Название *</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={120} placeholder="Например, Coffee House" autoFocus required /></label>
      <label><span>Описание</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={4} placeholder="Коротко расскажите о компании" /><small>{description.length}/1000</small></label>
      {locations.map((point, index) => <fieldset className="organization-location-create" key={index}><legend>{index === 0 ? 'Основная точка' : `Точка ${index + 1}`}</legend><LocationFields value={point} disabled={create.isPending} onChange={value => setLocations(previous => previous.map((item, i) => i === index ? value : item))} />{index > 0 && <button type="button" className="app-secondary" disabled={create.isPending} onClick={() => setLocations(previous => previous.filter((_, i) => i !== index))}>Убрать точку</button>}</fieldset>)}
      <p className="form-footnote">Другие точки можно добавить после выбора тарифа или ручного включения пробного Бизнеса в настройках организации.</p>
      {error && <p className="app-alert app-alert--error" role="alert">{error}</p>}
      <div className="organization-form__actions"><Link className="app-secondary" to="/app">Отмена</Link><button className="app-primary" disabled={create.isPending}>{create.isPending ? 'Создаём…' : 'Создать организацию'}</button></div>
    </form>
  </main></div>
}
