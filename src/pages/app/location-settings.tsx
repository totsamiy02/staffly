import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useLocations, useLocationTeams, useOrganizationMembers } from '../../app/organizations/queries.ts'
import type { LocationTeam, OrganizationLocation, OrganizationSummary } from '../../app/organizations/types.ts'
import Select from '../../component/ui/select/select.tsx'
import DatePicker, { TimeInput } from '../../component/ui/date-picker/date-picker.tsx'
import { useToast } from '../../component/ui/toast/toast-context.ts'
import EmployeePicker from './schedule/employee-picker.tsx'
import LocationFields, { type LocationFieldsValue } from './location-fields.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import DocumentDialog from './documents/document-dialog.tsx'

type DirectoryMember = { id: string; displayName: string; locations: Array<{ locationId: string; role: 'ADMIN' | 'MEMBER' }> }
type Transfer = { id: string; temporary: boolean; startAt: string; endAt: string | null; member: { user: { firstName: string | null; lastName: string | null; email: string } }; fromLocation: { name: string }; toLocation: { name: string } }
export default function LocationSettings({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest, locationId } = useAuth()
  const client = useQueryClient(), toast = useToast()
  const points = useLocations(organization.id), teams = useLocationTeams(organization.id), members = useOrganizationMembers(organization.id)
  const manager = organization.role !== 'MEMBER', owner = organization.role === 'OWNER'
  const directory = useQuery({ queryKey: ['location-directory', organization.id, locationId], queryFn: () => apiRequest<{ members: DirectoryMember[] }>(`/organizations/${organization.id}/all-members`), enabled: manager })
  const transfers = useQuery({ queryKey: ['location-transfers', organization.id, locationId], queryFn: () => apiRequest<{ transfers: Transfer[] }>(`/organizations/${organization.id}/transfers`), enabled: manager })
  const [pointDialog, setPointDialog] = useState<{ id: string | null; value: LocationFieldsValue } | null>(null)
  const [archive, setArchive] = useState<OrganizationLocation | null>(null)
  const [teamDialog, setTeamDialog] = useState<{ id: string | null; name: string; memberIds: string[] } | null>(null)
  const [deleteTeam, setDeleteTeam] = useState<LocationTeam | null>(null)
  const [assignId, setAssignId] = useState(''), [assignRole, setAssignRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER')
  const [transferId, setTransferId] = useState(''), [destination, setDestination] = useState(''), [temporary, setTemporary] = useState(true)
  const [startDate, setStartDate] = useState(''), [endDate, setEndDate] = useState(''), [startTime, setStartTime] = useState('09:00'), [endTime, setEndTime] = useState('18:00')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const base = `/organizations/${organization.id}`
  async function refresh() { await Promise.all(['locations', 'organization', 'organizations', 'organization-members', 'location-teams', 'location-directory', 'location-transfers', 'schedule-planning', 'documents', 'schedule', 'requests', 'work-time-statistics'].map(key => client.invalidateQueries({ queryKey: [key] }))) }
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
  async function saveTeam(e: FormEvent) {
    e.preventDefault(); if (!teamDialog) return
    if (await run(() => apiRequest(`${base}/teams${teamDialog.id ? '/' + teamDialog.id : ''}`, { method: teamDialog.id ? 'PATCH' : 'POST', body: { name: teamDialog.name, memberIds: teamDialog.memberIds } }), 'Команда сохранена.')) setTeamDialog(null)
  }
  async function move(e: FormEvent) {
    e.preventDefault()
    if (await run(() => apiRequest(`${base}/transfers`, { method: 'POST', body: { memberId: transferId, fromLocationId: organization.locationId, toLocationId: destination, temporary, ...(temporary ? { startDate, endDate, startTime, endTime } : {}) } }), temporary ? 'Подмена назначена.' : 'Сотрудник переведён.')) { setTransferId(''); setDestination('') }
  }
  const permanent = members.data?.members.filter(member => member.locations?.some(point => point.locationId === organization.locationId)) ?? []
  return <div className="location-settings">
    {error && !pointDialog && !teamDialog && !archive && !deleteTeam && <p className="app-alert app-alert--error" role="alert">{error}</p>}
    <article className="settings-card settings-card--list"><header><h2>Точки организации</h2><p>Для каждой точки — своё расписание, состав сотрудников и права управления.</p></header>
      {points.isLoading ? <p>Загружаем точки…</p> : points.isError ? <p role="alert">Не удалось загрузить точки. <button className="app-secondary" onClick={() => void points.refetch()}>Повторить</button></p> : <div className="location-settings-list">{points.data?.locations.map(point => <div key={point.id}><div><strong>{point.name}{point.id === organization.locationId ? ' · текущая' : ''}{point.archivedAt ? ' · закрыта' : ''}</strong><p>{[point.city, point.address].filter(Boolean).join(', ') || 'Заполните адрес точки'}</p><small>{point.memberCount} сотрудников · {point.role === 'OWNER' ? 'Владелец' : point.role === 'ADMIN' ? 'Администратор' : 'Сотрудник'}</small></div>{owner && !point.archivedAt && <div className="location-actions"><button className="app-secondary" disabled={busy} onClick={() => { setError(''); setPointDialog({ id: point.id, value: point }) }}>Изменить</button><button className="app-secondary" disabled={busy} onClick={() => { setError(''); setArchive(point) }}>Закрыть точку</button></div>}</div>)}</div>}
      {owner && <button className="app-primary" onClick={() => { setError(''); setPointDialog({ id: null, value: { name: '', city: '', address: '', timezone: organization.timezone } }) }}>Добавить точку</button>}
    </article>
    <article className="settings-card settings-card--list"><header><h2>Команды · {organization.location?.name}</h2><p>Именованные группы сотрудников этой точки. Состав можно настроить до планирования смен.</p></header>
      {teams.isLoading ? <p>Загружаем команды…</p> : teams.isError ? <p role="alert">Не удалось загрузить команды. <button className="app-secondary" onClick={() => void teams.refetch()}>Повторить</button></p> : teams.data?.teams.length ? <div className="location-settings-list">{teams.data.teams.map(team => <div key={team.id}><div><strong>{team.name}</strong><p>{team.members.map(item => members.data?.members.find(member => member.id === item.memberId)?.displayName).filter(Boolean).join(', ') || 'Сотрудники пока не назначены'}</p></div>{manager && <div className="location-actions"><button className="app-secondary" onClick={() => { setError(''); setTeamDialog({ id: team.id, name: team.name, memberIds: team.members.map(m => m.memberId) }) }}>Настроить</button><button className="app-secondary" onClick={() => { setError(''); setDeleteTeam(team) }}>Удалить команду</button></div>}</div>)}</div> : <p>Команд пока нет.</p>}
      {manager && <button className="app-primary" onClick={() => { setError(''); setTeamDialog({ id: null, name: '', memberIds: [] }) }}>Создать команду</button>}
    </article>
    {manager && <article className="settings-card"><header><h2>Назначить сотрудника в точку</h2><p>Можно добавить существующего участника организации. Для нового сотрудника используйте приглашение на главной странице точки.</p></header><form className="location-settings-form" onSubmit={e => { e.preventDefault(); void run(() => apiRequest(`${base}/locations/${organization.locationId}/members`, { method: 'POST', body: { memberId: assignId, role: assignRole } }), 'Сотрудник назначен в точку.').then(saved => { if (saved) setAssignId('') }) }}>
      <label><span>Сотрудник</span><Select required searchable disabled={directory.isLoading || directory.isError || busy} value={assignId} onChange={e => setAssignId(e.target.value)}><option value="">Выберите участника</option>{directory.data?.members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</Select></label>
      {owner && <label><span>Роль в этой точке</span><Select value={assignRole} onChange={e => setAssignRole(e.target.value as 'ADMIN' | 'MEMBER')}><option value="MEMBER">Сотрудник</option><option value="ADMIN">Администратор</option></Select></label>}
      {directory.isError && <p role="alert">Не удалось загрузить сотрудников. <button className="app-secondary" type="button" onClick={() => void directory.refetch()}>Повторить</button></p>}
      <button className="app-primary" disabled={busy || !assignId}>Назначить</button></form></article>}
    {manager && <article className="settings-card"><header><h2>Перевод и подмена</h2><p>Владелец или администратор обеих точек может оформить перемещение. Уже назначенные смены и история сохраняются в исходных точках.</p></header><form className="location-settings-form" onSubmit={move}>
      <EmployeePicker members={permanent} value={transferId} onChange={setTransferId} disabled={busy} />
      <label><span>Другая точка</span><Select required value={destination} disabled={busy} onChange={e => setDestination(e.target.value)}><option value="">Выберите точку</option>{points.data?.locations.filter(point => point.id !== organization.locationId && !point.archivedAt && (owner || point.role === 'ADMIN')).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label>
      <label><span>Действие</span><Select value={temporary ? 'temporary' : 'permanent'} onChange={e => setTemporary(e.target.value === 'temporary')}><option value="temporary">Временная подмена</option><option value="permanent">Постоянный перевод</option></Select></label>
      {temporary && <><p>Время по часовому поясу исходной точки. Для подмены на одну смену укажите её начало и окончание.</p><div className="planning-time"><label><span>Дата начала</span><DatePicker required value={startDate} onChange={e => setStartDate(e.target.value)} /></label><label><span>Время начала</span><TimeInput required value={startTime} onChange={e => setStartTime(e.target.value)} /></label><label><span>Дата окончания</span><DatePicker required min={startDate} value={endDate} onChange={e => setEndDate(e.target.value)} /></label><label><span>Время окончания</span><TimeInput required value={endTime} onChange={e => setEndTime(e.target.value)} /></label></div></>}
      <button className="app-primary" disabled={busy || !transferId || !destination}>{temporary ? 'Назначить подмену' : 'Перевести сотрудника'}</button></form>
      {transfers.isError ? <p role="alert">Не удалось загрузить историю переводов. <button className="app-secondary" onClick={() => void transfers.refetch()}>Повторить</button></p> : <div className="location-settings-list">{transfers.data?.transfers.map(item => <div key={item.id}><div><strong>{[item.member.user.lastName, item.member.user.firstName].filter(Boolean).join(' ') || item.member.user.email}</strong><p>{item.fromLocation.name} → {item.toLocation.name} · {item.temporary ? 'Подмена' : 'Перевод'}</p><small>{new Date(item.startAt).toLocaleString('ru-RU', { timeZone: organization.timezone })}{item.endAt ? ' — ' + new Date(item.endAt).toLocaleString('ru-RU', { timeZone: organization.timezone }) : ''}</small></div></div>)}</div>}
    </article>}
    {pointDialog && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setPointDialog(null)}>{close => <DocumentDialog className="location-dialog" eyebrow="Точки и команды" title={pointDialog.id ? 'Данные точки' : 'Новая точка'} busy={busy} onClose={close}><form onSubmit={savePoint}><LocationFields value={pointDialog.value} disabled={busy} onChange={value => setPointDialog({ ...pointDialog, value })} />{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy}>Сохранить</button></footer></form></DocumentDialog>}</AnimatedOverlay>}
    {teamDialog && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setTeamDialog(null)}>{close => <DocumentDialog className="location-dialog" eyebrow="Точки и команды" title="Настройка команды" busy={busy} onClose={close}><form onSubmit={saveTeam}><div className="organization-profile-fields"><label className="profile-field--wide"><span>Название команды</span><input required minLength={2} maxLength={120} value={teamDialog.name} disabled={busy} onChange={e => setTeamDialog({ ...teamDialog, name: e.target.value })} placeholder="Например, Утренняя команда" /></label></div><fieldset><legend>Сотрудники точки</legend>{members.isLoading ? <p>Загружаем сотрудников…</p> : members.isError ? <p role="alert">Не удалось загрузить сотрудников.</p> : permanent.map(member => <label className="document-checkbox" key={member.id}><input type="checkbox" checked={teamDialog.memberIds.includes(member.id)} disabled={busy} onChange={() => setTeamDialog({ ...teamDialog, memberIds: teamDialog.memberIds.includes(member.id) ? teamDialog.memberIds.filter(id => id !== member.id) : [...teamDialog.memberIds, member.id] })} /><span>{member.displayName}</span></label>)}</fieldset>{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy || members.isError}>Сохранить команду</button></footer></form></DocumentDialog>}</AnimatedOverlay>}
    {(archive || deleteTeam) && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => { setArchive(null); setDeleteTeam(null) }}>{close => <DocumentDialog className="location-dialog" eyebrow="Точки и команды" title={archive ? 'Закрыть точку?' : 'Удалить команду?'} busy={busy} onClose={close}><p>{archive ? `«${archive.name}» будет закрыта. История сохранится; точку с будущими сменами, подменами или необработанными заявками закрыть нельзя.` : `Команда «${deleteTeam?.name}» будет удалена. Сотрудники и смены сохранятся.`}</p>{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy} onClick={() => void run(() => apiRequest(archive ? `${base}/locations/${archive.id}` : `${base}/teams/${deleteTeam!.id}`, { method: 'DELETE' }), archive ? 'Точка закрыта.' : 'Команда удалена.').then(saved => { if (saved) { setArchive(null); setDeleteTeam(null) } })}>Подтвердить</button></footer></DocumentDialog>}</AnimatedOverlay>}
  </div>
}
