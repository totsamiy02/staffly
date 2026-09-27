export const absenceNames = { VACATION: 'Отпуск', DAY_OFF: 'Отгул', SICK: 'Болезнь', SICK_LEAVE: 'Болезнь', ABSENCE: 'Отсутствие' }
export function absenceDays(start: string, end: string) { return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1 }
