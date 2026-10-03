import { locationTone } from '../../app/organizations/format.ts'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useLocations, useOrganizationDirectory } from '../../app/organizations/queries.ts'
import type { OrganizationLocation, OrganizationSummary } from '../../app/organizations/types.ts'
import Select from '../../component/ui/select/select.tsx'
import { useToast } from '../../component/ui/toast/toast-context.ts'
import EmployeePicker from './schedule/employee-picker.tsx'
import LocationFields, { type LocationFieldsValue } from './location-fields.tsx'
import SensitiveCodeInput from './sensitive-code-input.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import DocumentDialog from './documents/document-dialog.tsx'

export default function LocationSettings({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest } = useAuth(), client = useQueryClient(), toast = useToast()
  const points = useLocations(organization.id), owner = organization.organizationRole === 'OWNER' || organization.role === 'OWNER'
  const manageable = points.data?.locations.filter(point => !point.archivedAt && (owner || point.role === 'ADMIN')) ?? []
  const directory = useOrganizationDirectory(organization.id, manageable.length > 0)
  const [pointDialog, setPointDialog] = useState<{ id: string | null; value: LocationFieldsValue } | null>(null)
  const [closing, setClosing] = useState<OrganizationLocation | null>(null), [code, setCode] = useState(''), [codeSent, setCodeSent] = useState(false)
  const [memberId, setMemberId] = useState(''), [destination, setDestination] = useState(organization.locationId ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const base = `/organizations/${organization.id}`
  async function refresh() { await Promise.all(['locations-overview', 'locations', 'organization', 'organizations', 'organization-members', 'location-directory', 'schedule-planning', 'documents', 'schedule', 'requests', 'work-time-statistics'].map(key => client.invalidateQueries({ queryKey: [key] }))) }
  async function run(action: () => Promise<unknown>, message: string) {
    if (busy) return false
    setBusy(true); setError('')
    try { await action(); await refresh(); toast(message); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить.'); return false }
    finally { setBusy(false) }
  }
  async function savePoint(e: FormEvent) {
    e.preventDefault(); if (!pointDialog) return
    if (await run(() => apiRequest(`${base}/locations${pointDialog.id ? '/' + pointDialog.id : ''}`, { method: pointDialog.id ? 'PATCH' : 'POST', body: pointDialog.value }), 'Точка сохранена.')) setPointDialog(null)
  }
  const availableMembers = directory.data?.members.filter(member => !member.locations.some(point => point.locationId === destination) && (owner || member.role === 'MEMBER')) ?? []
  const lastPoint = (points.data?.locations.filter(point => !point.archivedAt).length ?? 1) <= 1
  return <div className="location-settings">
    {error && !pointDialog && !closing && <p className="app-alert app-alert--error" role="alert">{error}</p>}
    <article className="settings-card settings-card--list"><header><h2>Точки организации</h2><p>Адреса, часовые пояса и состав сотрудников. Переключайте рабочую точку в меню слева.</p></header>
      {points.isLoading ? <p>Загружаем точки…</p> : points.isError ? <p role="alert">Не удалось загрузить точки. <button className="app-secondary" onClick={() => void points.refetch()}>Повторить</button></p> : <div className="location-settings-list">{points.data?.locations.map(point => <div className="location-settings-item" data-tone={locationTone(point.id)} key={point.id}><span className="location-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></svg></span><div className="location-settings-item__body"><strong>{point.name}{point.id === organization.locationId && <span className="location-current">Выбрана</span>}{point.archivedAt ? ' · закрыта' : ''}</strong><p>{[point.city, point.address].filter(Boolean).join(', ') || 'Заполните адрес точки'}</p><small>В составе: {point.memberCount} · {point.timezone}</small></div>{owner && !point.archivedAt && <div className="location-actions"><button className="app-secondary" disabled={busy} onClick={() => { setError(''); setPointDialog({ id: point.id, value: point }) }}>Изменить</button>{<button className="app-secondary" disabled={busy || lastPoint} title={lastPoint ? 'Последнюю действующую точку нельзя закрыть' : 'Закрытие с подтверждением по почте'} onClick={() => { setError(''); setCode(''); setCodeSent(false); setClosing(point) }}>Закрыть точку</button>}</div>}</div>)}</div>}
      {owner && <button className="app-primary" onClick={() => { setError(''); setPointDialog({ id: null, value: { name: '', city: '', address: '', timezone: organization.timezone } }) }}>Добавить точку</button>}
    </article>
    {manageable.length > 0 && <article className="settings-card"><header><h2>Распределение сотрудников</h2><p>Выберите точку и сотрудника организации. Он сохранит свою общую роль и назначения в остальных точках. Администратор управляет только точками, в которые назначен.</p><Link className="app-secondary" to={`/app/organizations/${organization.id}/employees?location=${organization.locationId}`}>Открыть сотрудников</Link></header><form className="location-settings-form" onSubmit={e => { e.preventDefault(); void run(() => apiRequest(`${base}/locations/${destination}/members`, { method: 'POST', body: { memberId } }), 'Сотрудник назначен в точку.').then(saved => { if (saved) setMemberId('') }) }}>
      <label><span>Точка назначения</span><Select required value={destination} disabled={busy} onChange={e => { setDestination(e.target.value); setMemberId('') }}>{manageable.map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label>
      <EmployeePicker members={availableMembers} value={memberId} onChange={setMemberId} disabled={directory.isLoading || directory.isError || busy} emptyLabel="Найти сотрудника организации" />
      {directory.isError && <p role="alert">Не удалось загрузить сотрудников. <button className="app-secondary" type="button" onClick={() => void directory.refetch()}>Повторить</button></p>}
      {!directory.isLoading && !directory.isError && !availableMembers.length && <p>Все доступные сотрудники уже назначены в эту точку.</p>}
      <button className="app-primary" disabled={busy || !memberId || !destination}>Назначить в точку</button></form></article>}
    {<article className="settings-card"><header><h2>Подмены между точками</h2><p>Если на смену не хватает сотрудника, создайте заявку. После отклика и подтверждения сотрудник получит смену и временное назначение.</p></header><Link className="app-secondary" to={`/app/organizations/${organization.id}/requests?location=${organization.locationId}&tab=staffing`}>Открыть заявки на подмену</Link></article>}
    {pointDialog && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setPointDialog(null)}>{close => <DocumentDialog className="location-dialog" eyebrow="Точки организации" title={pointDialog.id ? 'Данные точки' : 'Новая точка'} busy={busy} onClose={close}><form onSubmit={savePoint}><LocationFields value={pointDialog.value} disabled={busy} onChange={value => setPointDialog({ ...pointDialog, value })} />{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy}>Сохранить</button></footer></form></DocumentDialog>}</AnimatedOverlay>}
    {closing && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setClosing(null)}>{close => <DocumentDialog className="location-dialog" eyebrow="Точки организации" title={`Закрыть «${closing.name}»?`} busy={busy} onClose={close}><p>История сохранится. Закрытие подтверждает владелец кодом из письма. Будущие смены, открытые заявки и подмены должны быть обработаны заранее.</p>{codeSent ? <form onSubmit={e => { e.preventDefault(); void run(() => apiRequest(`${base}/locations/${closing.id}`, { method: 'DELETE', body: { code } }), 'Точка закрыта.').then(saved => { if (saved) setClosing(null) }) }}><SensitiveCodeInput value={code} onChange={setCode} label="Код закрытия точки из письма" />{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-danger" disabled={busy || code.length !== 6}>Закрыть точку</button></footer></form> : <>{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy} onClick={() => void run(() => apiRequest(`${base}/locations/${closing.id}/close/request`, { method: 'POST', body: {} }), 'Код отправлен на почту владельца.').then(sent => { if (sent) setCodeSent(true) })}>Получить код</button></footer></>}</DocumentDialog>}</AnimatedOverlay>}
  </div>
}
