import { useState, type FormEvent } from 'react'
import { useLocations } from '../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { useEventActions, useEventMembers } from '../../../app/events/queries.ts'
import type { EventFormInput, StaffEvent } from '../../../app/events/types.ts'
import { zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { locationTone } from '../../../app/organizations/format.ts'
import DatePicker, { TimeInput } from '../../../component/ui/date-picker/date-picker.tsx'
import Select from '../../../component/ui/select/select.tsx'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import DocumentDialog from '../documents/document-dialog.tsx'
import AnimatedOverlay from '../schedule/animated-overlay.tsx'
import { EventIcon } from './event-elements.tsx'
import { eventTimezoneLabel } from '../../../app/events/format.ts'
function initial(organization: OrganizationSummary, event?: StaffEvent): EventFormInput {
  const start = zonedDateAndTime(event?.startAt ?? new Date(Date.now() + 3600000).toISOString(), event?.timezone ?? organization.timezone)
  const end = event?.endAt ? zonedDateAndTime(event.endAt, event.timezone) : null
  return { title: event?.title ?? '', description: event?.description ?? '', typeLabel: event?.typeLabel ?? '', startDate: start.date, startTime: start.time, endDate: end?.date ?? null, endTime: end?.time ?? null, place: event?.place ?? '', meetingUrl: event?.meetingUrl ?? '', shared: event?.shared ?? false, locationIds: event?.locations.map(point => point.id) ?? (organization.role !== 'MEMBER' && organization.locationId ? [organization.locationId] : []), audienceMode: event?.audienceMode ?? 'ALL', audienceRoles: event?.audienceRoles ?? [], memberIds: event?.recipients.map(member => member.id) ?? [], refreshRecipients: false, ...(event ? { revision: event.revision } : {}) }
}
export default function EventForm({ organization, event, onClose, onSaved }: { organization: OrganizationSummary; event?: StaffEvent; onClose: () => void; onSaved: (event: StaffEvent) => void }) {
  const [form, setForm] = useState(() => initial(organization, event))
  const [withEnd, setWithEnd] = useState(Boolean(event?.endAt)), [memberSearch, setMemberSearch] = useState(''), [error, setError] = useState('')
  const locations = useLocations(organization.id), actions = useEventActions(organization.id), toast = useToast()
  const owner = (organization.organizationRole ?? organization.role) === 'OWNER'
  const points = (locations.data?.locations ?? []).filter(point => !point.archivedAt && (owner || point.role === 'ADMIN'))
  const members = useEventMembers(organization.id, form.shared, form.locationIds)
  const timezone = members.data?.timezone ?? (form.shared || form.locationIds.length !== 1 ? organization.organizationTimezone ?? organization.timezone : points.find(point => point.id === form.locationIds[0])?.timezone ?? event?.timezone ?? organization.timezone)
  const candidates = members.data?.members ?? []
  const preview = form.audienceMode === 'SELECTED' ? candidates.filter(member => form.memberIds.includes(member.id)) : form.audienceMode === 'ROLES' ? candidates.filter(member => member.locationRoles.some(role => form.audienceRoles.includes(role))) : candidates
  const sameSet = (left: string[], right: string[]) => [...left].sort().join() === [...right].sort().join()
  const keepsSnapshot = event && !form.refreshRecipients && form.shared === event.shared && sameSet(form.locationIds, event.locations.map(point => point.id)) && form.audienceMode === event.audienceMode && sameSet(form.audienceRoles, event.audienceRoles) && (form.audienceMode !== 'SELECTED' || sameSet(form.memberIds, event.recipients.map(member => member.id)))
  function field<K extends keyof EventFormInput>(key: K, value: EventFormInput[K]) { setForm(previous => ({ ...previous, [key]: value })); setError('') }
  function togglePoint(id: string) { setForm(previous => ({ ...previous, locationIds: previous.locationIds.includes(id) ? previous.locationIds.filter(point => point !== id) : [...previous.locationIds, id], memberIds: [], refreshRecipients: true })); setError('') }
  function changeScope(shared: boolean) {
    setForm(previous => ({ ...previous, shared, locationIds: shared ? [] : points.filter(point => point.id === organization.locationId).map(point => point.id), memberIds: [], refreshRecipients: true }))
    setError('')
  }
  async function submit(action: FormEvent) {
    action.preventDefault(); setError('')
    if (!form.shared && !form.locationIds.length) { setError('Выберите хотя бы одну точку.'); return }
    if (form.audienceMode === 'ROLES' && !form.audienceRoles.length) { setError('Выберите роль получателей.'); return }
    if (form.audienceMode === 'SELECTED' && !form.memberIds.length) { setError('Выберите сотрудников.'); return }
    try { const result = await actions.save.mutateAsync({ eventId: event?.id, input: { ...form, endDate: withEnd ? form.endDate : null, endTime: withEnd ? form.endTime : null } }); toast(event ? 'Событие обновлено' : 'Событие опубликовано', 'success'); onSaved(result.event) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить событие.') }
  }
  return <AnimatedOverlay variant="modal" onClose={onClose} dismissible={!actions.save.isPending}>{close => <DocumentDialog title={event ? 'Редактировать событие' : 'Новое событие'} eyebrow="События" onClose={close} busy={actions.save.isPending} className="event-form-dialog">
    <form className="event-form" onSubmit={action => void submit(action)}>
      <label><span>Название <small>*</small></span><input autoFocus required maxLength={160} value={form.title} onChange={action => field('title', action.target.value)} placeholder="Например, месячная планёрка" /></label>
      <fieldset className="event-form-scope"><legend>Для кого событие</legend>{owner && <SegmentedNav label="Область события"><button type="button" aria-pressed={!form.shared} onClick={() => { if (form.shared) changeScope(false) }}>Выбранные точки</button><button type="button" aria-pressed={form.shared} onClick={() => { if (!form.shared) changeScope(true) }}>Вся организация</button></SegmentedNav>}
        {!form.shared && <div className="event-point-picker">{points.map(point => <label className="event-point-option" data-selected={form.locationIds.includes(point.id)} data-tone={locationTone(point.id)} key={point.id}><EventIcon kind="place" /><span>{point.name}</span><input type="checkbox" checked={form.locationIds.includes(point.id)} onChange={() => togglePoint(point.id)} /></label>)}</div>}
        {locations.isLoading && <p className="event-muted">Загружаем точки…</p>}{locations.isError && <p className="form-inline-error">Не удалось загрузить точки. <button type="button" onClick={() => void locations.refetch()}>Повторить</button></p>}
        {!owner && <p className="event-muted">Доступны только точки, которыми вы управляете.</p>}
      </fieldset>
      <section className="event-form-dates" aria-label="Дата и время события"><div className="event-form-section-heading"><h3>Дата и время</h3><label className="event-check"><input type="checkbox" checked={withEnd} onChange={action => { setWithEnd(action.target.checked); if (action.target.checked && !form.endDate) setForm(previous => ({ ...previous, endDate: previous.startDate, endTime: '' })) }} /><span>Указать окончание</span></label></div>
      <div className="event-form-grid"><label><span>Дата начала <small>*</small></span><DatePicker required value={form.startDate} onChange={action => field('startDate', action.target.value)} /></label><label><span>Время начала <small>*</small></span><TimeInput required value={form.startTime} onChange={action => field('startTime', action.target.value)} /></label></div>
      <p className="event-timezone"><EventIcon kind="clock" />Часовой пояс: <strong>{eventTimezoneLabel(timezone)}</strong></p>
      {withEnd && <div className="event-form-grid"><label><span>Дата окончания <small>*</small></span><DatePicker required min={form.startDate} value={form.endDate ?? ''} onChange={action => field('endDate', action.target.value)} /></label><label><span>Время окончания <small>*</small></span><TimeInput required value={form.endTime ?? ''} onChange={action => field('endTime', action.target.value)} /></label></div>}
      </section>
      <div className="event-form-grid"><label><span>Тип события</span><input maxLength={80} value={form.typeLabel} onChange={action => field('typeLabel', action.target.value)} placeholder="Планёрка, проверка, обучение…" /></label><label><span>Место</span><input maxLength={300} value={form.place} onChange={action => field('place', action.target.value)} placeholder="Например, переговорная" /></label></div>
      <label><span>Ссылка на встречу</span><input type="url" maxLength={2048} value={form.meetingUrl} onChange={action => field('meetingUrl', action.target.value)} placeholder="https://…" /></label>
      <label><span>Описание и повестка</span><textarea rows={4} maxLength={4000} value={form.description} onChange={action => field('description', action.target.value)} placeholder="Что запланировано и как подготовиться" /></label>
      <fieldset className="event-form-audience"><legend>Получатели</legend><Select aria-label="Выбор получателей" value={form.audienceMode} onChange={action => field('audienceMode', action.target.value as EventFormInput['audienceMode'])}><option value="ALL">Все сотрудники выбранной области</option><option value="ROLES">По роли в точке</option><option value="SELECTED">Конкретные сотрудники</option></Select>
        {form.audienceMode === 'ROLES' && <div className="event-role-picker">{(['ADMIN', 'MEMBER'] as const).map(role => <label className="event-check" key={role}><input type="checkbox" checked={form.audienceRoles.includes(role)} onChange={() => field('audienceRoles', form.audienceRoles.includes(role) ? form.audienceRoles.filter(value => value !== role) : [...form.audienceRoles, role])} /><span>{role === 'ADMIN' ? 'Администраторы точек' : 'Сотрудники точек'}</span></label>)}</div>}
        {form.audienceMode === 'SELECTED' && <><input aria-label="Поиск получателей" placeholder="Найти сотрудника" value={memberSearch} onChange={action => setMemberSearch(action.target.value)} /><div className="event-member-picker">{candidates.filter(member => member.name.toLocaleLowerCase().includes(memberSearch.toLocaleLowerCase())).map(member => <label className="event-check" key={member.id}><input type="checkbox" checked={form.memberIds.includes(member.id)} onChange={() => field('memberIds', form.memberIds.includes(member.id) ? form.memberIds.filter(id => id !== member.id) : [...form.memberIds, member.id])} /><Avatar className="app-avatar" name={member.name} url={member.avatarUrl} /><span>{member.name}</span></label>)}</div></>}
        {members.isFetching ? <p className="event-muted">Загружаем получателей…</p> : members.isError ? <p className="form-inline-error">Не удалось загрузить получателей. <button type="button" onClick={() => void members.refetch()}>Повторить</button></p> : <p className="event-muted">{keepsSnapshot ? `Сохранённый состав: ${event.recipientCount}` : `В выбранном составе: ${preview.length}`}</p>}
        {event && <label className="event-check"><input type="checkbox" checked={form.refreshRecipients} onChange={action => field('refreshRecipients', action.target.checked)} /><span>Обновить состав по текущим назначениям</span></label>}
        <p className="event-muted">Состав фиксируется при публикации. Новые сотрудники автоматически не добавляются.</p>
      </fieldset>
      {error && <p className="form-inline-error" role="alert">{error}</p>}
      <footer><button type="button" className="app-secondary" disabled={actions.save.isPending} onClick={close}>Закрыть</button><button type="submit" className="app-primary" disabled={actions.save.isPending || members.isFetching || members.isError || locations.isError}>{actions.save.isPending ? 'Сохраняем…' : event ? 'Сохранить изменения' : 'Опубликовать событие'}</button></footer>
    </form>
  </DocumentDialog>}</AnimatedOverlay>
}
