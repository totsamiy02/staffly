import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takeFreshNotifications } from '../src/app/organizations/floating-notifications.ts'
import type { AccountNotification } from '../src/app/organizations/types.ts'

const now = Date.parse('2026-10-08T12:00:00Z')
function notice(id: string, type: AccountNotification['type'] = 'EVENT_PUBLISHED', minutesAgo = 1): AccountNotification {
  return { id, type, eventId: 'event-1', requestId: null, title: 'Событие', message: 'Планёрка', createdAt: new Date(now - minutesAgo * 60_000).toISOString(), organization: { id: 'org-1', name: 'Тест', logoUrl: null } }
}

test('floating notices cover event lifecycle and retain new request alerts', () => {
  for (const type of ['EVENT_PUBLISHED', 'EVENT_CHANGED', 'EVENT_CANCELLED', 'EVENT_STARTED', 'REQUEST_CREATED'] as const) {
    assert.equal(takeFreshNotifications([notice(type, type)], new Set(), now).length, 1)
  }
  assert.deepEqual(takeFreshNotifications([notice('role', 'ROLE_CHANGED')], new Set(), now), [])
})

test('old unread notices and repeated deliveries do not reappear across pages', () => {
  const seen = new Set<string>()
  const items = [notice('old', 'EVENT_STARTED', 16), notice('new'), notice('new')]
  assert.deepEqual(takeFreshNotifications(items, seen, now).map(item => item.id), ['new'])
  assert.deepEqual(takeFreshNotifications(items, new Set([...seen]), now), [])
  assert.deepEqual(takeFreshNotifications([{ ...notice('invalid'), createdAt: 'bad-date' }], seen, now), [])
})

test('a burst displays the four most recent notices and consumes the overflow', () => {
  const seen = new Set<string>()
  const items = Array.from({ length: 6 }, (_, index) => notice(String(index), 'EVENT_CHANGED', index))
  assert.deepEqual(takeFreshNotifications(items, seen, now).map(item => item.id), ['3', '2', '1', '0'])
  assert.equal(seen.size, 6)
  assert.deepEqual(takeFreshNotifications(items, seen, now), [])
})
