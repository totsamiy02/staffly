import type { HistoryNotification } from './types.ts'

export function formatNotificationPeriod(start: Date, end: Date, timezone: string) {
  const date = (value: Date, short = false) => value.toLocaleDateString('ru-RU', { timeZone: timezone, day: 'numeric', month: short ? 'short' : 'long' })
  const time = (value: Date) => value.toLocaleTimeString('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' })
  const day = (value: Date) => value.toLocaleDateString('en-CA', { timeZone: timezone })
  return day(start) === day(end) ? `${date(start)} · ${time(start)}–${time(end)}` : `${date(start, true)} ${time(start)} → ${date(end, true)} ${time(end)}`
}
export function formatNotificationTime(createdAt: string, now: number) {
  const date = new Date(createdAt), current = new Date(now)
  const minutes = Math.floor((now - date.getTime()) / 60000)
  if (minutes >= 0 && minutes < 1) return 'Только что'
  if (minutes > 0 && minutes < 60) return `${minutes} мин. назад`
  if (date.toDateString() === current.toDateString()) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(current); yesterday.setDate(current.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера'
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(date.getFullYear() !== current.getFullYear() ? { year: 'numeric' } : {}) })
}

export function formatLegacyNotificationMessage(message: string) {
  const match = message.match(/^(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}):(\d{2})\s*[—–-]\s*(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}):(\d{2})(?:\s*\([^)]*\))?$/)
  if (!match) return message.replace(/\s*\([A-Za-z_]+\/[A-Za-z_]+\)\s*/g, '')
  const [, d1, m1, y1, h1, min1, d2, m2, y2, h2, min2] = match
  return formatNotificationPeriod(new Date(`${y1}-${m1}-${d1}T${h1}:${min1}:00Z`), new Date(`${y2}-${m2}-${d2}T${h2}:${min2}:00Z`), 'UTC')
}

const typeLabels: Record<string, string> = { SHIFT_OFFER_CREATED: 'Расписание', SHIFT_OFFER_APPROVAL: 'Расписание', SHIFT_OFFER_RESULT: 'Расписание', EVENT_PUBLISHED: 'События', EVENT_CHANGED: 'События', EVENT_CANCELLED: 'События', EVENT_STARTED: 'События', DOCUMENT_ASSIGNED: 'Документ', ABSENCE_REPORTED: 'Отсутствие', ABSENCE_CHANGED: 'Отсутствие', ABSENCE_CANCELLED: 'Отсутствие', ORGANIZATION_INVITATION: 'Приглашение', SHIFT_ASSIGNED: 'Расписание', SHIFT_CHANGED: 'Расписание', SHIFT_CANCELLED: 'Расписание', ROLE_CHANGED: 'Доступ', REQUEST_CREATED: 'Заявка', REQUEST_APPROVED: 'Заявка', REQUEST_REJECTED: 'Заявка', REQUEST_CANCELLED: 'Заявка' }
const stateLabels: Record<string, string> = { AWAITING_APPROVAL: 'Ожидает согласования', COMPLETED: 'Завершено', INVALID: 'Неактуально', REQUIRED: 'Требует ознакомления', ACKNOWLEDGED: 'Ознакомлен', ACCEPTED: 'Принято', REJECTED: 'Отклонено', REVOKED: 'Отозвано', EXPIRED: 'Срок истёк', APPROVED: 'Одобрено', CANCELLED: 'Отменено', PENDING: 'На рассмотрении' }

export function notificationTypeLabel(type: string) { return typeLabels[type] ?? 'Уведомление' }
export function notificationStateLabel(item: Pick<HistoryNotification, 'type' | 'state'>) {
  if (item.type.startsWith('SHIFT_OFFER_') && item.state === 'PENDING') return 'Ожидает ответа'
  return stateLabels[item.state ?? ''] ?? item.state
}
export function notificationActionLabel(item: Pick<HistoryNotification, 'type' | 'shiftOfferId' | 'eventId' | 'documentId' | 'requestId'>) {
  return item.shiftOfferId ? 'Посмотреть предложение' : item.eventId ? 'Открыть событие' : item.documentId ? 'Открыть документ' : item.requestId ? 'Открыть заявку' : item.type.startsWith('SHIFT_') ? 'Открыть смену' : 'Подробнее'
}

export function notificationDayLabel(createdAt: string, now: number) {
  const date = new Date(createdAt), current = new Date(now)
  if (date.toDateString() === current.toDateString()) return 'Сегодня'
  const yesterday = new Date(current); yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера'
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(date.getFullYear() !== current.getFullYear() ? { year: 'numeric' } : {}) })
}

export function notificationAppearance(item: Pick<HistoryNotification, 'type' | 'state'>) {
  if (['REJECTED', 'CANCELLED', 'INVALID', 'REVOKED', 'EXPIRED'].includes(item.state ?? '') || /REJECTED|CANCELLED/.test(item.type)) return { tone: 'muted', icon: 'close' }
  if (['COMPLETED', 'APPROVED', 'ACCEPTED', 'ACKNOWLEDGED'].includes(item.state ?? '') || item.type === 'REQUEST_APPROVED') return { tone: 'green', icon: 'check' }
  if (item.type === 'SHIFT_OFFER_APPROVAL' || item.state === 'AWAITING_APPROVAL') return { tone: 'amber', icon: 'swap' }
  if (item.type.startsWith('SHIFT_OFFER_')) return { tone: 'rose', icon: 'calendar' }
  if (item.type.startsWith('SHIFT_')) return { tone: 'blue', icon: 'calendar' }
  if (item.type.startsWith('EVENT_')) return { tone: 'blue', icon: 'calendar' }
  if (item.type.startsWith('DOCUMENT_')) return { tone: 'blue', icon: 'document' }
  if (item.type.startsWith('REQUEST_') || item.type.startsWith('ABSENCE_')) return { tone: 'amber', icon: 'document' }
  return { tone: 'muted', icon: 'people' }
}
