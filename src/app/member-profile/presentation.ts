export function profileDate(value: string, timezone = 'UTC') {
  return new Date(value).toLocaleDateString('ru-RU', { timeZone: timezone, day: 'numeric', month: 'long', year: 'numeric' })
}
