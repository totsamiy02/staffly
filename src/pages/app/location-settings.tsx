import { locationTone } from '../../app/organizations/format.ts'
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useLocations } from '../../app/organizations/queries.ts'
import type { OrganizationLocation, OrganizationSummary } from '../../app/organizations/types.ts'
import { useToast } from '../../component/ui/toast/toast-context.ts'
import LocationFields, { type LocationFieldsValue } from './location-fields.tsx'
import SensitiveCodeInput from './sensitive-code-input.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import DocumentDialog from './documents/document-dialog.tsx'

export default function LocationSettings({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest } = useAuth(), client = useQueryClient(), toast = useToast()
  const points = useLocations(organization.id), owner = organization.organizationRole === 'OWNER' || organization.role === 'OWNER'
  const [pointDialog, setPointDialog] = useState<{ id: string | null; value: LocationFieldsValue } | null>(null)
  const [closing, setClosing] = useState<OrganizationLocation | null>(null), [code, setCode] = useState(''), [codeSent, setCodeSent] = useState(false)
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
  const lastPoint = (points.data?.locations.filter(point => !point.archivedAt).length ?? 1) <= 1
  return <div className="location-settings">
    {error && !pointDialog && !closing && <p className="app-alert app-alert--error" role="alert">{error}</p>}
    <article className="settings-card settings-card--list"><header><h2>Точки организации</h2><p>Названия, адреса и часовые пояса. Состав точек настраивается в разделе «Сотрудники».</p></header>
      {points.isLoading ? <p>Загружаем точки…</p> : points.isError ? <p role="alert">Не удалось загрузить точки. <button className="app-secondary" onClick={() => void points.refetch()}>Повторить</button></p> : <div className="location-settings-list">{points.data?.locations.map(point => <div className="location-settings-item" data-tone={locationTone(point.id)} key={point.id}><span className="location-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></svg></span><div className="location-settings-item__body"><strong>{point.name}{point.id === organization.locationId && <span className="location-current">Выбрана</span>}{point.archivedAt ? ' · закрыта' : ''}</strong><p>{[point.city, point.address].filter(Boolean).join(', ') || 'Заполните адрес точки'}</p><small>В составе: {point.memberCount} · {point.timezone}</small></div>{owner && !point.archivedAt && <div className="location-actions"><button className="app-secondary" disabled={busy} onClick={() => { setError(''); setPointDialog({ id: point.id, value: point }) }}>Изменить</button>{<button className="app-secondary" disabled={busy || lastPoint} title={lastPoint ? 'Последнюю действующую точку нельзя закрыть' : 'Закрытие с подтверждением по почте'} onClick={() => { setError(''); setCode(''); setCodeSent(false); setClosing(point) }}>Закрыть точку</button>}</div>}</div>)}</div>}
      {owner && <button className="app-primary" onClick={() => { setError(''); setPointDialog({ id: null, value: { name: '', city: '', address: '', timezone: organization.timezone } }) }}>Добавить точку</button>}
    </article>
    {pointDialog && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setPointDialog(null)}>{close => <DocumentDialog className="location-dialog" eyebrow="Точки организации" title={pointDialog.id ? 'Данные точки' : 'Новая точка'} busy={busy} onClose={close}><form onSubmit={savePoint}><LocationFields value={pointDialog.value} disabled={busy} onChange={value => setPointDialog({ ...pointDialog, value })} />{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy}>Сохранить</button></footer></form></DocumentDialog>}</AnimatedOverlay>}
    {closing && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setClosing(null)}>{close => <DocumentDialog className="location-dialog" eyebrow="Точки организации" title={`Закрыть «${closing.name}»?`} busy={busy} onClose={close}><p>История сохранится. Закрытие подтверждает владелец кодом из письма. Будущие смены, открытые заявки и подмены должны быть обработаны заранее.</p>{codeSent ? <form onSubmit={e => { e.preventDefault(); void run(() => apiRequest(`${base}/locations/${closing.id}`, { method: 'DELETE', body: { code } }), 'Точка закрыта.').then(saved => { if (saved) setClosing(null) }) }}><SensitiveCodeInput value={code} onChange={setCode} label="Код закрытия точки из письма" />{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-danger" disabled={busy || code.length !== 6}>Закрыть точку</button></footer></form> : <>{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy} onClick={() => void run(() => apiRequest(`${base}/locations/${closing.id}/close/request`, { method: 'POST', body: {} }), 'Код отправлен на почту владельца.').then(sent => { if (sent) setCodeSent(true) })}>Получить код</button></footer></>}</DocumentDialog>}</AnimatedOverlay>}
  </div>
}
