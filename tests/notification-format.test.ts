import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatNotificationPeriod, formatNotificationTime, formatLegacyNotificationMessage, notificationStateLabel, notificationActionLabel, notificationDayLabel, notificationAppearance } from '../src/app/organizations/notification-format.ts'

test('formats shift periods in organization time without exposing timezone identifiers', () => {
  assert.equal(formatNotificationPeriod(new Date('2026-10-02T06:00:00Z'), new Date('2026-10-02T19:00:00Z'), 'Europe/Moscow'), '2 октября · 09:00–22:00')
  const overnight = formatNotificationPeriod(new Date('2026-10-02T20:00:00Z'), new Date('2026-10-02T23:00:00Z'), 'Europe/Moscow')
  assert.match(overnight, /2 окт.*23:00 → 3 окт.*02:00/)
  assert.ok(!overnight.includes('Europe/Moscow'))
})
test('notification times preserve recent minutes and show year for older history', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  assert.equal(formatNotificationTime('2026-10-02T11:58:00Z', now), '2 мин. назад')
  assert.equal(formatNotificationTime('2026-10-02T11:59:59Z', now), 'Только что')
  assert.match(formatNotificationTime('2025-06-01T12:00:00Z', now), /2025/)
})

test('renders existing technical shift messages without changing stored history', () => {
  assert.equal(formatLegacyNotificationMessage('02.10.2026, 09:00 — 02.10.2026, 22:00 (Europe/Moscow)'), '2 октября · 09:00–22:00')
  assert.equal(formatLegacyNotificationMessage('Новая заявка'), 'Новая заявка')
})

test('shared notification presentation distinguishes pending offers and opens the linked resource', () => {
  assert.equal(notificationStateLabel({ type: 'SHIFT_OFFER_CREATED', state: 'PENDING' }), 'Ожидает ответа')
  assert.equal(notificationStateLabel({ type: 'REQUEST_CREATED', state: 'PENDING' }), 'На рассмотрении')
  assert.equal(notificationActionLabel({ type: 'SHIFT_OFFER_CREATED', shiftOfferId: 'offer' }), 'Посмотреть предложение')
  assert.equal(notificationActionLabel({ type: 'SHIFT_ASSIGNED' }), 'Открыть смену')
  assert.equal(notificationActionLabel({ type: 'DOCUMENT_ASSIGNED', documentId: 'document' }), 'Открыть документ')
})

test('groups notification history by local calendar day across month and year boundaries', () => {
  const now = new Date(2026, 0, 1, 0, 10).getTime()
  assert.equal(notificationDayLabel(new Date(2026, 0, 1, 0, 5).toISOString(), now), 'Сегодня')
  assert.equal(notificationDayLabel(new Date(2025, 11, 31, 23, 59).toISOString(), now), 'Вчера')
  assert.match(notificationDayLabel(new Date(2025, 11, 30).toISOString(), now), /30 декабря 2025/)
})

test('closed notification states take priority over invitation and offer type colors', () => {
  assert.deepEqual(notificationAppearance({ type: 'SHIFT_OFFER_CREATED', state: 'COMPLETED' }), { tone: 'green', icon: 'check' })
  assert.deepEqual(notificationAppearance({ type: 'SHIFT_OFFER_CREATED', state: 'INVALID' }), { tone: 'muted', icon: 'close' })
  assert.deepEqual(notificationAppearance({ type: 'SHIFT_OFFER_APPROVAL', state: 'AWAITING_APPROVAL' }), { tone: 'amber', icon: 'swap' })
  assert.deepEqual(notificationAppearance({ type: 'ORGANIZATION_INVITATION', state: 'REJECTED' }), { tone: 'muted', icon: 'close' })
})
