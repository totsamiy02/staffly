import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatNotificationPeriod, formatNotificationTime, formatLegacyNotificationMessage } from '../src/app/organizations/notification-format.ts'

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
