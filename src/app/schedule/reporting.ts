export const reportSheets = ['summary', 'shifts', 'absences', 'parameters'] as const
export type ReportSheet = typeof reportSheets[number]
export type ReportField = { key: string; title: string; type: 'text' | 'number' | 'hours' | 'date' | 'datetime'; width: number }
const field = (key: string, title: string, type: ReportField['type'] = 'text', width = 24): ReportField => ({ key, title, type, width })
const identity = [field('name', 'Полные ФИО', 'text', 36), field('personnelNumber', 'Табельный номер', 'text', 20), field('memberId', 'ID сотрудника (технический)', 'text', 38)]
export const reportCatalog: Record<ReportSheet, { title: string; fields: ReportField[] }> = {
  summary: { title: 'Сводка', fields: [...identity, field('locations', 'Заведение', 'text', 30), field('positions', 'Должности на сменах', 'text', 30), field('status', 'Статус сотрудника'), field('shifts', 'Количество назначений', 'number'), field('hours', 'Часы с учётом результата', 'hours')] },
  shifts: { title: 'Смены', fields: [...identity, field('id', 'ID смены (технический)', 'text', 38), field('location', 'Точка'), field('timezone', 'Часовой пояс'), field('position', 'Должность на смене'), field('start', 'Начало (факт или план)', 'datetime'), field('end', 'Конец (факт или план)', 'datetime'), field('break', 'Перерыв по графику, мин', 'number'), field('minutes', 'Длительность, мин', 'number'), field('hours', 'Часы с учётом результата', 'hours'), field('state', 'Результат / состояние'), field('comment', 'Комментарий к смене', 'text', 48)] },
  absences: { title: 'Отсутствия', fields: [...identity, field('locations', 'Заведения в области отсутствия', 'text', 36), field('id', 'ID отсутствия (технический)', 'text', 38), field('type', 'Тип'), field('start', 'Исходное начало', 'date'), field('end', 'Исходный конец', 'date'), field('overlapStart', 'Начало пересечения', 'date'), field('overlapEnd', 'Конец пересечения', 'date'), field('days', 'Календарных дней в периоде', 'number'), field('source', 'Основание', 'text', 32), field('comment', 'Комментарий', 'text', 48)] },
  parameters: { title: 'Параметры', fields: [field('parameter', 'Параметр', 'text', 38), field('value', 'Значение', 'text', 100)] },
}
export type ReportConfig = { layout?: 'report' | 'table'; sheets: Array<{ key: ReportSheet; enabled: boolean; columns: Array<{ key: string; title: string }> }>; totals: boolean }
export function defaultReportConfig(): ReportConfig { return { layout: 'report', sheets: reportSheets.map(key => ({ key, enabled: true, columns: reportCatalog[key].fields.filter(field => !['id', 'memberId'].includes(field.key)).map(({ key, title }) => ({ key, title })) })), totals: true } }
export function reportConfigError(config: ReportConfig): string | null {
  if (!config.sheets.some(sheet => sheet.enabled)) return 'Включите хотя бы один лист.'
  if (new Set(config.sheets.map(sheet => sheet.key)).size !== config.sheets.length) return 'Листы не должны повторяться.'
  for (const sheet of config.sheets) {
    if (!reportSheets.includes(sheet.key)) return 'Неизвестный лист.'
    if (sheet.enabled && !sheet.columns.length) return `Выберите хотя бы одну колонку: ${reportCatalog[sheet.key].title}.`
    const titles = new Set<string>(), keys = new Set<string>()
    for (const column of sheet.columns) {
      const title = column.title.trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('ru')
      if (!title || column.title.trim().length > 80) return 'Название колонки должно содержать от 1 до 80 символов.'
      if (titles.has(title)) return 'Названия колонок внутри листа не должны повторяться.'
      if (keys.has(column.key) || !reportCatalog[sheet.key].fields.some(field => field.key === column.key)) return 'Неизвестное или повторяющееся поле.'
      titles.add(title); keys.add(column.key)
    }
  }
  return null
}
export type ReportInput = { from: string; to: string; locationIds: string[]; memberIds: string[]; includeFormer: boolean; config: ReportConfig; templateId?: string }
export type ReportTemplate = { id: string; name: string; config: ReportConfig; canManage: boolean }
export type ReportPreview = {
  generatedAt: string
  metrics: { employees: number; shifts: number; minutes: number; hours: number; futureShifts: number; futureHours: number }
  warnings: { missingNumber: Array<{ id: string; name: string }>; incompleteName: Array<{ id: string; name: string }> }
  sheets: Array<{ key: ReportSheet; title: string; columns: Array<ReportField>; rows: Array<Array<string | number | null>>; total: number; totals: Array<string | number | null> | null }>
}

export function reportScopeError(config: ReportConfig, locationCount: number): string | null {
  if (locationCount < 2) return null
  for (const sheet of config.sheets.filter(sheet => sheet.enabled && sheet.key !== 'parameters')) {
    const key = sheet.key === 'shifts' ? 'location' : 'locations'
    if (!sheet.columns.some(column => column.key === key)) return `Для нескольких заведений включите колонку «${sheet.key === 'absences' ? 'Заведения в области отсутствия' : 'Заведение'}» на листе «${reportCatalog[sheet.key].title}».`
  }
  return null
}
