const plural = new Intl.PluralRules('ru-RU')
export function word(value: number, one: string, few: string, many: string) {
  const form = plural.select(value)
  return form === 'one' ? one : form === 'few' ? few : many
}
export function metricValue(key: string, value: number) {
  const forms: [string, string, string] = key.endsWith('UNAVAILABLE') ? ['секунда','секунды','секунд'] : key === 'BACKUP_STALE' ? ['час','часа','часов'] : key === 'EMAIL_FAILURES' ? ['письмо','письма','писем'] : key === 'REPORT_FAILURES' ? ['отчёт','отчёта','отчётов'] : key === 'ADMIN_DENIALS' ? ['отказ','отказа','отказов'] : key === 'BACKUP_FAILURES' ? ['задание','задания','заданий'] : ['сбой','сбоя','сбоев']
  return `${value} ${word(value, ...forms)}`
}
