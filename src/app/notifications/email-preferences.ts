export const emailCategories = [
  { key: 'shiftChanges', group: 'schedule', title: 'Изменения смен', description: 'Назначение, перенос и отмена ближайших смен', icon: 'schedule' },
  { key: 'publishedSchedule', group: 'schedule', title: 'Опубликованный график', description: 'Один итоговый график после применения согласованного расписания', icon: 'schedule' },
  { key: 'shiftOffers', group: 'schedule', title: 'Предложения смен', description: 'Срочное адресное предложение и итог передачи или обмена', icon: 'employees' },
  { key: 'scheduleDiscussion', group: 'schedule', title: 'Согласование графика', description: 'Начало обсуждения, новая редакция и одно напоминание перед сроком', icon: 'schedule' },
  { key: 'requestResults', group: 'requests', title: 'Результаты заявок', description: 'Окончательное решение по вашим заявкам', icon: 'requests' },
  { key: 'vacationCollection', group: 'requests', title: 'Пожелания на отпуск', description: 'Начало сбора и одно напоминание перед сроком', icon: 'requests' },
  { key: 'documents', group: 'documents', title: 'Документы для ознакомления', description: 'Назначение и одно напоминание перед сроком', icon: 'documents' },
  { key: 'importantEvents', group: 'events', title: 'Важные события', description: 'Публикация, перенос и отмена событий, отмеченных важными', icon: 'events' },
  { key: 'urgentAbsences', group: 'management', title: 'Срочные отсутствия', description: 'Отсутствие сотрудника, затрагивающее ближайшую смену', icon: 'employees' },
  { key: 'actionDigest', group: 'management', title: 'Заявки и согласования', description: 'Каждая новая заявка, принятое предложение смены или завершённое обсуждение, где нужно ваше решение', icon: 'requests' },
] as const

export type EmailCategory = typeof emailCategories[number]['key']
export type EmailPreferences = { enabled: boolean; categories: Record<EmailCategory, boolean>; revision: number }
export const emailCategoryKeys = emailCategories.map(item => item.key)
export function defaultEmailCategories(): Record<EmailCategory, boolean> {
  return Object.fromEntries(emailCategoryKeys.map(key => [key, !['vacationCollection', 'urgentAbsences', 'actionDigest'].includes(key)])) as Record<EmailCategory, boolean>
}
export function normalizeEmailCategories(value: unknown): Record<EmailCategory, boolean> {
  const values = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return Object.fromEntries(emailCategoryKeys.map(key => [key, values[key] === true])) as Record<EmailCategory, boolean>
}
