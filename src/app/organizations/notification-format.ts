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
