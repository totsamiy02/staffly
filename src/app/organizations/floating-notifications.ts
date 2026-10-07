import type { AccountNotification } from './types.ts'

const floatingTypes = new Set<AccountNotification['type']>(['REQUEST_CREATED', 'EVENT_PUBLISHED', 'EVENT_CHANGED', 'EVENT_CANCELLED', 'EVENT_STARTED'])
const freshnessMs = 15 * 60 * 1000

// Seen IDs are shared across pages; closing a popup does not mark the notice as read.
export function takeFreshNotifications(items: AccountNotification[], seen: Set<string>, now = Date.now()) {
  const fresh = items.filter(item => {
    if (seen.has(item.id) || !floatingTypes.has(item.type)) return false
    seen.add(item.id)
    const age = now - Date.parse(item.createdAt)
    return Number.isFinite(age) && age >= -60_000 && age <= freshnessMs
  })
  return fresh.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-4)
}
