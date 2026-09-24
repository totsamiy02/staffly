import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationRole, OrganizationSummary } from '../../../app/organizations/types.ts'
import { useMyUpcomingShifts } from '../../../app/schedule/queries.ts'
import { displayDate, formatTime, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { useRequestDetail, useRequests, useRequestTypes } from '../../../app/requests/queries.ts'
import type { RequestStatus, RequestType, StaffRequest } from '../../../app/requests/types.ts'
import AnimatedOverlay from '../schedule/animated-overlay.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import './requests.scss'

const statusLabels: Record<RequestStatus, string> = { PENDING: 'Ожидает решения', APPROVED: 'Одобрена', REJECTED: 'Отклонена', CANCELLED: 'Отменена' }
const roleLabels: Record<OrganizationRole, string> = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Сотрудник' }
const eventLabels = { CREATED: 'Заявка отправлена', EDITED: 'Заявка изменена', APPROVED: 'Заявка одобрена', REJECTED: 'Заявка отклонена', CANCELLED: 'Заявка отменена' } as const
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} КБ` : `${(size / 1024 / 1024).toFixed(1)} МБ`
const shiftWindow = (start: string, end: string, timezone: string) => `${displayDate(zonedDateAndTime(start, timezone).date)} ${formatTime(start, timezone)} — ${displayDate(zonedDateAndTime(end, timezone).date)} ${formatTime(end, timezone)}`
const periodLabel = (request: Pick<StaffRequest, 'startDate' | 'endDate'>) => request.startDate ? request.endDate && request.endDate !== request.startDate ? `${displayDate(request.startDate)} — ${displayDate(request.endDate)}` : displayDate(request.startDate) : 'Без даты'

function RequestCard({ request, incoming, onOpen }: { request: StaffRequest; incoming: boolean; onOpen: () => void }) {
  const unread = incoming && request.status === 'PENDING' && !request.readByViewer
  return <button type="button" className={`request-card${unread ? ' request-card--unread' : ''}`} onClick={onOpen}>{unread && <i aria-label="Не прочитана" />}<div><span>{request.typeNameSnapshot}</span><strong>{incoming ? request.creatorName : periodLabel(request)}</strong><small>{incoming ? `${roleLabels[request.creatorRole]} · ${periodLabel(request)}` : new Date(request.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</small></div><span className={`request-status request-status--${request.status.toLowerCase()}`}>{statusLabels[request.status]}</span><time>{new Date(request.createdAt).toLocaleDateString('ru-RU')}</time></button>
}

function RequestForm({ organization, types, request, onClose }: { organization: OrganizationSummary; types: RequestType[]; request?: StaffRequest | null; onClose: () => void }) {
  const { apiRequest, uploadFile } = useAuth()
  const queryClient = useQueryClient()
  const shifts = useMyUpcomingShifts(organization.id)
  const [typeId, setTypeId] = useState(request ? (types.some((type) => type.id === request.requestTypeId) ? request.requestTypeId : '') : types[0]?.id ?? '')
  const [startDate, setStartDate] = useState(request?.startDate ?? '')
  const [endDate, setEndDate] = useState(request?.endDate ?? '')
  const [comment, setComment] = useState(request?.comment ?? '')
  const [shiftId, setShiftId] = useState(request?.relatedShiftId ?? '')
  const [proposedStartDate, setProposedStartDate] = useState(request?.proposedStartAt ? zonedDateAndTime(request.proposedStartAt, organization.timezone).date : '')
  const [proposedStartTime, setProposedStartTime] = useState(request?.proposedStartAt ? zonedDateAndTime(request.proposedStartAt, organization.timezone).time : '')
  const [proposedEndDate, setProposedEndDate] = useState(request?.proposedEndAt ? zonedDateAndTime(request.proposedEndAt, organization.timezone).date : '')
  const [proposedEndTime, setProposedEndTime] = useState(request?.proposedEndAt ? zonedDateAndTime(request.proposedEndAt, organization.timezone).time : '')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const type = types.find((item) => item.id === typeId)
  const selectedShift = shifts.data?.shifts.find((item) => item.id === shiftId)
  function chooseShift(id: string) {
    setShiftId(id)
    const shift = shifts.data?.shifts.find((item) => item.id === id)
    const start = shift ? zonedDateAndTime(shift.scheduledStartAt, organization.timezone) : null
    const end = shift ? zonedDateAndTime(shift.scheduledEndAt, organization.timezone) : null
    setProposedStartDate(start?.date ?? ''); setProposedStartTime(start?.time ?? '')
    setProposedEndDate(end?.date ?? ''); setProposedEndTime(end?.time ?? '')
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!type) return; setBusy(true); setError('')
    try {
      if (type.systemCode === 'SHIFT_CHANGE' && Date.parse(`${proposedEndDate}T${proposedEndTime}:00Z`) <= Date.parse(`${proposedStartDate}T${proposedStartTime}:00Z`)) throw new Error('Окончание смены должно быть позже начала.')
      if (files.length + (request?.attachments.length ?? 0) > 5) throw new Error('К заявке можно добавить не больше пяти файлов.')
      if (files.some((file) => file.size > 10 * 1024 * 1024)) throw new Error('Каждый файл должен весить не больше 10 МБ.')
      const result = await apiRequest<{ request: { id: string } }>(`/organizations/${organization.id}/requests${request ? `/${request.id}` : ''}`, { method: request ? 'PATCH' : 'POST', body: { requestTypeId: typeId, startDate: startDate || null, endDate: endDate || null, comment: comment || null, relatedShiftId: shiftId || null, proposedStartDate: type.systemCode === 'SHIFT_CHANGE' ? proposedStartDate : null, proposedStartTime: type.systemCode === 'SHIFT_CHANGE' ? proposedStartTime : null, proposedEndDate: type.systemCode === 'SHIFT_CHANGE' ? proposedEndDate : null, proposedEndTime: type.systemCode === 'SHIFT_CHANGE' ? proposedEndTime : null } })
      for (const file of files) await uploadFile(`/organizations/${organization.id}/requests/${result.request.id}/attachments`, file)
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['requests', organization.id] }), queryClient.invalidateQueries({ queryKey: ['account-notifications'] }), ...(request ? [queryClient.invalidateQueries({ queryKey: ['request', organization.id, request.id] })] : [])])
      onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отправить заявку.') }
    finally { setBusy(false) }
  }
  return <div className="request-modal"><header><div><p className="app-eyebrow">{request ? 'Моя заявка' : 'Новое обращение'}</p><h2>{request ? 'Изменить заявку' : 'Создать заявку'}</h2></div><button type="button" aria-label="Закрыть" onClick={onClose}>×</button></header><form onSubmit={submit}><label><span>Тип заявки</span><select value={typeId} required onChange={(event) => { setTypeId(event.target.value); setStartDate(''); setEndDate(''); chooseShift('') }}>{request && !typeId && <option value="">Выберите доступный тип</option>}{types.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>{type?.description && <small>{type.description}</small>}</label>{type?.dateMode !== 'NONE' && <div className="request-date-fields"><label><span>{type?.dateMode === 'SINGLE' ? 'Дата заявки' : 'Первый день'}</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label>{type?.dateMode === 'RANGE' && <label><span>Последний день</span><input type="date" min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>}</div>}{type?.systemCode === 'SHIFT_CHANGE' && <label><span>Текущая смена</span><select value={shiftId} onChange={(event) => chooseShift(event.target.value)} required><option value="">Выберите свою смену</option>{shifts.data?.shifts.filter((shift) => new Date(shift.scheduledStartAt).getTime() > Date.now()).map((shift) => <option value={shift.id} key={shift.id}>{displayDate(zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date)} · {formatTime(shift.scheduledStartAt, organization.timezone)}–{formatTime(shift.scheduledEndAt, organization.timezone)}</option>)}</select></label>}{type?.systemCode === 'SHIFT_CHANGE' && selectedShift && <div className="request-shift-proposal"><p>Предложите новое время для выбранной смены. После одобрения она переместится в расписании.</p><div><fieldset><legend>Новое начало</legend><label><span>Дата</span><input type="date" value={proposedStartDate} onChange={(event) => setProposedStartDate(event.target.value)} required /></label><label><span>Время</span><input type="time" value={proposedStartTime} onChange={(event) => setProposedStartTime(event.target.value)} required /></label></fieldset><fieldset><legend>Новое окончание</legend><label><span>Дата</span><input type="date" min={proposedStartDate} value={proposedEndDate} onChange={(event) => setProposedEndDate(event.target.value)} required /></label><label><span>Время</span><input type="time" value={proposedEndTime} onChange={(event) => setProposedEndTime(event.target.value)} required /></label></fieldset></div></div>}<label><span>Комментарий{type?.requiresComment ? ' *' : ''}</span><textarea rows={4} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} required={type?.requiresComment} placeholder="Опишите детали заявки" /></label>{type?.allowsAttachments && <label className="request-file-field"><span>Вложения</span><input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, Math.max(0, 5 - (request?.attachments.length ?? 0))))} /><small>До 5 файлов на заявку, каждый не больше 10 МБ. PDF, JPEG, PNG или WebP.</small>{files.length > 0 && <ul>{files.map((file) => <li key={`${file.name}-${file.size}`}>{file.name} · {sizeLabel(file.size)}</li>)}</ul>}</label>}{request && request.attachments.length > 0 && <p className="request-form-note">Вложений сейчас: {request.attachments.length}. Удалить существующие можно в карточке заявки.</p>}{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy}>{busy ? 'Сохраняем…' : request ? 'Сохранить изменения' : 'Отправить заявку'}</button></footer></form></div>
}

function RequestAttachments({ attachments, canRemove, organizationId, requestId }: { attachments: StaffRequest['attachments']; canRemove: boolean; organizationId: string; requestId: string }) {
  const { apiRequest, downloadFile, previewFile } = useAuth()
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<{ id: string; url: string; mimeType: string } | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])
  async function open(attachment: StaffRequest['attachments'][number]) {
    setLoadingId(attachment.id); setError('')
    try {
      const blob = await previewFile(attachment.downloadUrl.replace('/api', ''))
      setPreview({ id: attachment.id, url: URL.createObjectURL(blob), mimeType: attachment.mimeType })
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось открыть файл.') }
    finally { setLoadingId(null) }
  }
  async function remove(attachment: StaffRequest['attachments'][number]) {
    if (confirmId !== attachment.id) { setConfirmId(attachment.id); return }
    setRemovingId(attachment.id); setError('')
    try {
      await apiRequest(attachment.downloadUrl.replace('/api', ''), { method: 'DELETE' })
      if (preview?.id === attachment.id) setPreview(null)
      await queryClient.invalidateQueries({ queryKey: ['request', organizationId, requestId] })
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось удалить вложение.') }
    finally { setRemovingId(null); setConfirmId(null) }
  }
  return <section className="request-detail-block"><h3>Вложения</h3><div className="request-attachments">{attachments.map((attachment) => <div className="request-attachment" key={attachment.id}><div><strong>{attachment.fileName}</strong><small>{sizeLabel(attachment.size)}</small></div><button type="button" disabled={loadingId === attachment.id} onClick={() => void open(attachment)}>{loadingId === attachment.id ? 'Открываем…' : 'Посмотреть'}</button><button type="button" onClick={() => void downloadFile(attachment.downloadUrl.replace('/api', ''), attachment.fileName)}>Скачать</button>{canRemove && <button type="button" disabled={removingId === attachment.id} onClick={() => void remove(attachment)}>{removingId === attachment.id ? 'Удаляем…' : confirmId === attachment.id ? 'Подтвердить' : 'Удалить'}</button>}</div>)}</div>{error && <p className="form-inline-error" role="alert">{error}</p>}{preview && <div className="request-preview"><div><strong>{attachments.find((item) => item.id === preview.id)?.fileName}</strong><button type="button" onClick={() => setPreview(null)} aria-label="Закрыть просмотр">×</button></div>{preview.mimeType === 'application/pdf' ? <iframe title="Просмотр PDF" src={preview.url} /> : <img src={preview.url} alt="Предпросмотр вложения" />}</div>}</section>
}

function RequestDrawer({ organization, requestId, scope, onEdit, onClose }: { organization: OrganizationSummary; requestId: string; scope: 'mine' | 'incoming' | 'history'; onEdit: (request: StaffRequest) => void; onClose: () => void }) {
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const detail = useRequestDetail(organization.id, requestId)
  const [comment, setComment] = useState('')
  const [confirmConflicts, setConfirmConflicts] = useState(false)
  const [error, setError] = useState('')
  const request = detail.data?.request
  const conflicts = detail.data?.conflicts ?? []
  const reviewer = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const own = request?.creatorEmail === user?.email
  useEffect(() => { if (detail.data && reviewer && scope === 'incoming') void queryClient.invalidateQueries({ queryKey: ['requests', organization.id] }) }, [detail.data, organization.id, queryClient, reviewer, scope])
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['requests', organization.id] }), queryClient.invalidateQueries({ queryKey: ['request', organization.id, requestId] }), queryClient.invalidateQueries({ queryKey: ['account-notifications'] }), queryClient.invalidateQueries({ queryKey: ['schedule', organization.id] })]) }
  const decision = useMutation({ mutationFn: (kind: 'approve' | 'reject') => apiRequest(`/organizations/${organization.id}/requests/${requestId}/${kind}`, { method: 'POST', body: kind === 'approve' ? { comment: comment || null, cancelConflictingShifts: confirmConflicts } : { comment } }), onSuccess: refresh, onError: (failure) => setError(failure instanceof Error ? failure.message : 'Не удалось обработать заявку.') })
  const cancel = useMutation({ mutationFn: () => apiRequest(`/organizations/${organization.id}/requests/${requestId}/cancel`, { method: 'POST', body: {} }), onSuccess: refresh, onError: (failure) => setError(failure instanceof Error ? failure.message : 'Не удалось отменить заявку.') })
  return <aside className="request-drawer">{detail.isLoading ? <div className="app-state"><span className="app-spinner" /></div> : detail.isError || !request ? <div className="app-state"><p>Не удалось открыть заявку.</p><button className="app-secondary" onClick={() => void detail.refetch()}>Повторить</button></div> : <><header><div><p className="app-eyebrow">Заявка</p><h2>{request.typeNameSnapshot}</h2><span className={`request-status request-status--${request.status.toLowerCase()}`}>{statusLabels[request.status]}</span></div><button aria-label="Закрыть" onClick={onClose}>×</button></header><section className="request-detail-person"><Avatar url={request.creatorAvatarUrl} name={request.creatorName} className="app-avatar" /><div><strong>{request.creatorName}</strong><span>{roleLabels[request.creatorRole]} · {request.creatorEmail}</span></div></section><dl className="request-detail-grid"><div><dt>Период</dt><dd>{periodLabel(request)}</dd></div><div><dt>Отправлена</dt><dd>{new Date(request.createdAt).toLocaleString('ru-RU')}</dd></div><div><dt>Просмотрена</dt><dd>{request.firstReadAt ? new Date(request.firstReadAt).toLocaleString('ru-RU') : 'Ещё не просмотрена'}</dd></div>{request.resolvedByName && <div><dt>Решение принял</dt><dd>{request.resolvedByName}</dd></div>}</dl>{request.comment && <section className="request-detail-block"><h3>Комментарий</h3><p>{request.comment}</p></section>}{request.relatedShiftId && <section className="request-detail-block"><h3>Изменение смены</h3>{request.originalStartAt && request.originalEndAt && <p>Сейчас: {shiftWindow(request.originalStartAt, request.originalEndAt, organization.timezone)}</p>}{request.proposedStartAt && request.proposedEndAt ? <p>Предложено: {shiftWindow(request.proposedStartAt, request.proposedEndAt, organization.timezone)}</p> : <p>В этой заявке не указано новое время. Для переноса подайте новую заявку.</p>}<Link className="request-related-shift" to={`/app/organizations/${organization.id}/schedule?month=${zonedDateAndTime((request.status === 'APPROVED' ? request.proposedStartAt : request.originalStartAt) ?? request.createdAt, organization.timezone).date.slice(0, 7)}&shift=${request.relatedShiftId}`}>Открыть смену в календаре</Link></section>}{request.attachments.length > 0 && <RequestAttachments attachments={request.attachments} canRemove={Boolean(own && scope === 'mine' && request.status === 'PENDING')} organizationId={organization.id} requestId={requestId} />}{conflicts.length > 0 && <section className="request-conflicts"><h3>Смены в период отсутствия</h3><p>Найдено смен: {conflicts.length}</p>{conflicts.map((shift) => <div key={shift.id}><strong>{displayDate(zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date)}</strong><span>{formatTime(shift.scheduledStartAt, organization.timezone)}–{formatTime(shift.scheduledEndAt, organization.timezone)}</span></div>)}</section>}{request.resolutionComment && <section className="request-detail-block"><h3>{request.status === 'REJECTED' ? 'Причина отклонения' : 'Комментарий к решению'}</h3><p>{request.resolutionComment}</p></section>}<section className="request-timeline"><h3>Ход заявки</h3>{request.events.map((event) => <div key={event.id}><i /><p><strong>{eventLabels[event.type]}</strong><span>{event.actorName} · {new Date(event.createdAt).toLocaleString('ru-RU')}</span>{event.comment && <small>{event.comment}</small>}</p></div>)}</section>{error && <p className="form-inline-error">{error}</p>}{request.status === 'PENDING' && reviewer && scope === 'incoming' && <section className="request-review"><label><span>Комментарий к решению</span><textarea rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Для отклонения причина обязательна" /></label>{conflicts.length > 0 && <label className="request-review__confirm"><input type="checkbox" checked={confirmConflicts} onChange={(event) => setConfirmConflicts(event.target.checked)} /><span>Отменить пересекающиеся будущие смены при одобрении</span></label>}<div><button className="app-secondary" disabled={decision.isPending || comment.trim().length < 3} onClick={() => decision.mutate('reject')}>Отклонить</button><button className="app-primary" disabled={decision.isPending || (request.systemCodeSnapshot === 'SHIFT_CHANGE' && !request.proposedStartAt) || (conflicts.length > 0 && !confirmConflicts)} onClick={() => decision.mutate('approve')}>Одобрить</button></div></section>}{request.status === 'PENDING' && own && reviewer && scope === 'mine' && <Link className="request-related-shift" to={`?tab=incoming&request=${request.id}`}>Открыть во вкладке «На рассмотрении»</Link>}{request.status === 'PENDING' && own && scope === 'mine' && <div className="request-own-actions"><button className="app-secondary" onClick={() => onEdit(request)}>Изменить заявку</button><button className="request-cancel" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Отменить заявку</button></div>}</>}</aside>
}

export default function RequestsPage({ organization }: { organization: OrganizationSummary }) {
  const reviewer = organization.role === 'OWNER' || organization.role === 'ADMIN'
  const types = useRequestTypes(organization.id)
  const [params, setParams] = useSearchParams()
  const initialScope = params.get('tab')
  const [scope, setScope] = useState<'mine' | 'incoming' | 'history'>(reviewer && (initialScope === 'incoming' || initialScope === 'history') ? initialScope : 'mine')
  const [page, setPage] = useState(1)
  const [typeId, setTypeId] = useState('')
  const [role, setRole] = useState<OrganizationRole | ''>('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState<RequestStatus | ''>('')
  const [creating, setCreating] = useState(false)
  const [editingRequest, setEditingRequest] = useState<StaffRequest | null>(null)
  const selectedId = params.get('request')
  useEffect(() => { if (reviewer && (initialScope === 'incoming' || initialScope === 'history')) setScope(initialScope); else setScope('mine') }, [initialScope, reviewer])
  useEffect(() => { const timer = window.setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1) }, 250); return () => window.clearTimeout(timer) }, [search])
  const list = useRequests(organization.id, scope, { page, status: scope === 'incoming' ? undefined : status || undefined, typeId: typeId || undefined, role: scope === 'mine' ? undefined : role || undefined, search: scope === 'mine' ? undefined : debouncedSearch || undefined })
  function changeScope(next: typeof scope) { setScope(next); setPage(1); setParams((current) => { const result = new URLSearchParams(current); result.set('tab', next); result.delete('request'); return result }, { replace: true }) }
  function openRequest(id: string) { setParams((current) => { const result = new URLSearchParams(current); result.set('tab', scope); result.set('request', id); return result }) }
  function closeRequest() { setParams((current) => { const result = new URLSearchParams(current); result.delete('request'); return result }, { replace: true }) }
  return <section className="requests-page"><header className="requests-heading"><div><p className="app-eyebrow">Заявки организации</p><h1>{scope === 'mine' ? 'Мои заявки' : scope === 'incoming' ? 'На рассмотрении' : 'Архив заявок'}</h1><p>{scope === 'mine' ? 'Ваши обращения и их статусы.' : scope === 'incoming' ? 'Заявки, ожидающие решения, включая ваши.' : 'Решённые и отменённые заявки организации.'}</p></div>{scope === 'mine' && <button className="app-primary" onClick={() => setCreating(true)}>Создать заявку</button>}</header><nav className="requests-tabs" aria-label="Разделы заявок"><button className={scope === 'mine' ? 'active' : ''} onClick={() => changeScope('mine')}><strong>Мои заявки</strong></button>{reviewer && <><button className={scope === 'incoming' ? 'active' : ''} onClick={() => changeScope('incoming')}><strong>На рассмотрении</strong></button><button className={scope === 'history' ? 'active' : ''} onClick={() => changeScope('history')}><strong>Архив заявок</strong></button></>}</nav><div className="requests-filters" aria-label="Фильтры заявок"><label><span>Тип заявки</span><select value={typeId} onChange={(event) => { setTypeId(event.target.value); setPage(1) }}><option value="">Все типы</option>{types.data?.types.map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</select></label>{scope !== 'incoming' && <label><span>Статус</span><select value={status} onChange={(event) => { setStatus(event.target.value as RequestStatus | ''); setPage(1) }}><option value="">Все статусы</option>{Object.entries(statusLabels).filter(([value]) => scope === 'mine' || value !== 'PENDING').map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}{reviewer && scope !== 'mine' && <><label><span>Роль автора</span><select value={role} onChange={(event) => { setRole(event.target.value as OrganizationRole | ''); setPage(1) }}><option value="">Все роли</option><option value="OWNER">Владелец</option><option value="ADMIN">Администратор</option><option value="MEMBER">Сотрудник</option></select></label><label className="requests-search"><span>Поиск заявки</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Имя, фамилия или почта" autoComplete="off" /></label></>}</div>{list.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем заявки…</div> : list.isError ? <div className="app-state"><p>Не удалось загрузить заявки.</p><button className="app-secondary" onClick={() => void list.refetch()}>Повторить</button></div> : !list.data?.requests.length ? <div className="requests-empty"><h2>{scope === 'mine' ? 'У вас пока нет заявок' : scope === 'incoming' ? 'Нет заявок для рассмотрения' : 'В архиве пока пусто'}</h2><p>{scope === 'mine' ? 'Создайте заявку, когда потребуется отпуск, отгул или изменение смены.' : scope === 'incoming' ? 'Новые заявки участников организации появятся здесь, в том числе ваши.' : 'Здесь появятся решённые и отменённые заявки организации.'}</p></div> : <div className="requests-list">{list.data.requests.map((request) => <RequestCard key={request.id} request={request} incoming={scope !== 'mine'} onOpen={() => openRequest(request.id)} />)}</div>}{list.data && list.data.pagination.pages > 1 && <nav className="members-pagination"><button className="app-secondary" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>Назад</button><span>Страница {page} из {list.data.pagination.pages}</span><button className="app-secondary" disabled={page >= list.data.pagination.pages} onClick={() => setPage((value) => value + 1)}>Далее</button></nav>}{creating && <AnimatedOverlay variant="modal" onClose={() => setCreating(false)}>{(close) => <RequestForm organization={organization} types={types.data?.types ?? []} onClose={close} />}</AnimatedOverlay>}{editingRequest && <AnimatedOverlay variant="modal" onClose={() => setEditingRequest(null)}>{(close) => <RequestForm organization={organization} types={types.data?.types ?? []} request={editingRequest} onClose={close} />}</AnimatedOverlay>}{selectedId && <AnimatedOverlay variant="drawer" onClose={closeRequest}>{() => <RequestDrawer organization={organization} requestId={selectedId} scope={scope} onEdit={(item) => { closeRequest(); setEditingRequest(item) }} onClose={closeRequest} />}</AnimatedOverlay>}</section>
}
