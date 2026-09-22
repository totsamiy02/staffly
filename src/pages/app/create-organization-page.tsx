import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import AppTopbar from './app-topbar.tsx'
import './app.scss'

export default function CreateOrganizationPage() {
  const { apiRequest } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow'
  const timezones = useMemo(() => typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [detectedTimezone], [detectedTimezone])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [timezone, setTimezone] = useState(detectedTimezone)
  const [error, setError] = useState('')
  const create = useMutation({
    mutationFn: () => apiRequest<{ organization: OrganizationSummary }>('/organizations', { method: 'POST', body: { name, description, timezone } }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['organizations'] }); navigate('/app', { replace: true }) },
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
    <div className="organization-form-page__intro"><p className="app-eyebrow">Новое рабочее пространство</p><h1>Создание организации</h1><p>Укажите основные данные. Остальные настройки можно будет заполнить позже.</p></div>
    <form className="organization-form" onSubmit={submit}>
      <label><span>Название *</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={120} placeholder="Например, Coffee House" autoFocus required /></label>
      <label><span>Описание</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={4} placeholder="Коротко расскажите о компании" /><small>{description.length}/1000</small></label>
      <label><span>Часовой пояс *</span><select value={timezone} onChange={(event) => setTimezone(event.target.value)}>{timezones.map((value) => <option value={value} key={value}>{value}</option>)}</select><small>Определён автоматически, при необходимости измените.</small></label>
      {error && <p className="app-alert app-alert--error" role="alert">{error}</p>}
      <div className="organization-form__actions"><Link className="app-secondary" to="/app">Отмена</Link><button className="app-primary" disabled={create.isPending}>{create.isPending ? 'Создаём…' : 'Создать организацию'}</button></div>
    </form>
  </main></div>
}
