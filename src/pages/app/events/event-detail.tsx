import { useState } from 'react'
import { useEvent, useEventActions } from '../../../app/events/queries.ts'
import type { StaffEvent } from '../../../app/events/types.ts'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import { eventDate, eventTime, eventTimezoneLabel } from '../../../app/events/format.ts'
import { displayDate } from '../../../app/schedule/date-utils.ts'
import DocumentDialog from '../documents/document-dialog.tsx'
import AnimatedOverlay from '../schedule/animated-overlay.tsx'
import { EventIcon, EventScope, EventState } from './event-elements.tsx'
export default function EventDetail({ organizationId, eventId, onClose, onEdit }: { organizationId: string; eventId: string; onClose: () => void; onEdit: (event: StaffEvent) => void }) {
  const query = useEvent(organizationId, eventId), actions = useEventActions(organizationId), toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const event = query.data?.event
  async function cancel() {
    if (!event) return
    try { await actions.cancel.mutateAsync({ id: event.id, revision: event.revision }); setConfirm(false); toast('Событие отменено', 'success') } catch { /* Inline error retains the dialog. */ }
  }
  return <AnimatedOverlay variant="modal" onClose={onClose} dismissible={!actions.cancel.isPending}>{close => <DocumentDialog title={event?.title ?? 'Событие'} eyebrow="События" onClose={close} busy={actions.cancel.isPending} className="event-detail-dialog" onEscape={confirm ? () => setConfirm(false) : undefined}>
    <EventState loading={query.isLoading} error={query.isError} retry={query.refetch}>{event && <>
      <div className="event-detail-tags">{event.typeLabel && <span className="event-type">{event.typeLabel}</span>}<EventScope event={event} />{event.cancelledAt && <span className="event-status event-status--cancelled">Отменено</span>}{event.status === 'PAST' && <span className="event-type">Прошедшее</span>}{event.status === 'ONGOING' && <span className="event-type">Идёт сейчас</span>}</div>
      <div className="event-facts"><p><EventIcon /><span>{displayDate(eventDate(event))}</span></p><p><EventIcon kind="clock" /><span>{eventTime(event)}<small>{eventTimezoneLabel(event.timezone)}</small></span></p>{(event.place || event.meetingUrl) && <p><EventIcon kind="place" /><span>{event.place || 'Онлайн'}</span></p>}<p><EventIcon kind="people" /><span>Получателей: {event.recipientCount}</span></p></div>
      {event.description && <section className="event-detail-section"><h3>Описание и повестка</h3><p className="event-description">{event.description}</p></section>}
      {event.meetingUrl && <a className="event-meeting-link app-secondary" href={event.meetingUrl} target="_blank" rel="noopener noreferrer"><EventIcon kind="link" />Открыть ссылку на встречу</a>}
      <section className="event-detail-section"><h3>Участники <small>{event.recipientCount}</small></h3>{event.recipients.length ? <div className="event-recipients">{event.recipients.map(member => <div key={member.id}><Avatar className="app-avatar" name={member.name} url={member.avatarUrl} /><span>{member.name}</span></div>)}</div> : <p className="event-muted">Действующих получателей нет.</p>}</section>
      <div className="event-organizer">Создал: <strong>{event.createdBy.name}</strong></div>
      {!!event.changes?.length && <details className="event-history"><summary>История события</summary><ul>{event.changes.map(change => <li key={change.id}><strong>{({ CREATED: 'Создано', UPDATED: 'Изменено', CANCELLED: 'Отменено' })[change.action] ?? change.action}</strong><span>{change.author}</span><time dateTime={change.createdAt}>{new Date(change.createdAt).toLocaleString('ru-RU', { timeZone: event.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></li>)}</ul></details>}
      {event.canManage && <footer className="event-detail-actions">{confirm ? <div className="event-cancel-confirm"><strong>Отменить событие?</strong><p>Получатели будут уведомлены. Событие сохранится в истории.</p><div><button className="app-secondary" disabled={actions.cancel.isPending} onClick={() => setConfirm(false)}>Вернуться</button><button className="app-danger" disabled={actions.cancel.isPending} onClick={() => void cancel()}>{actions.cancel.isPending ? 'Отменяем…' : 'Отменить событие'}</button></div></div> : <><button className="app-secondary" onClick={() => onEdit(event)}>Редактировать</button><button className="event-cancel-button" onClick={() => setConfirm(true)}>Отменить событие</button></>}</footer>}
      {actions.cancel.error && <p className="form-inline-error" role="alert">{actions.cancel.error.message}</p>}
    </>}</EventState>
  </DocumentDialog>}</AnimatedOverlay>
}
