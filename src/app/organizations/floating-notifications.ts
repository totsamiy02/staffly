import type { HistoryNotification } from './types.ts'
const freshnessMs = 15 * 60 * 1000

// Seen IDs are shared across pages; closing a popup does not mark the notice as read.
export function takeFreshNotifications(items: HistoryNotification[], seen: Set<string>, now = Date.now()) {
  const fresh = items.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    const age = now - Date.parse(item.createdAt)
    return !item.readAt && Number.isFinite(age) && age >= -60_000 && age <= freshnessMs
  })
  return fresh.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-4)
}
