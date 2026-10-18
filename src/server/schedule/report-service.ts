import { locationsFor, hasPermission } from '../organizations/access.ts'
import type { Permission } from '../../app/access/catalog.ts'
import ExcelJS from 'exceljs'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/permissions.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { addCalendarDays, startOfZonedDate, zonedParts } from './timezone.ts'
import { reportCatalog, reportScopeError, normalizeReportConfig, type ReportInput, type ReportPreview, type ReportSheet, type ReportConfig } from '../../app/schedule/reporting.ts'
import { mediaUrl } from '../storage/image-service.ts'

const MAX_ROWS = 25000
const fail = (message: string) => new ApiError(403, 'INSUFFICIENT_PERMISSIONS', message)
type DB = Prisma.TransactionClient
export async function reportAccess(userId: string, organizationId: string, db: DB = prisma, permission: Permission = 'reports.preview') {
  const actor = await getMembership(userId, organizationId, db)
  if (!actor.owner && !locationsFor(actor, permission).length) throw fail('Отчёты доступны владельцу и управляющим точек.')
  const locations = await db.organizationLocation.findMany({ where: { organizationId, ...(actor.organizationRole === 'OWNER' ? {} : { id: { in: locationsFor(actor, permission) }, archivedAt: null }) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return { actor, locations }
}
function selectedLocations(access: Awaited<ReturnType<typeof reportAccess>>, ids: string[]) {
  if (ids.some(id => !access.locations.some(location => location.id === id))) throw fail('Одна из выбранных точек недоступна для отчёта.')
  return ids.length ? access.locations.filter(location => ids.includes(location.id)) : access.locations
}
function range(from: string, to: string, timezone: string) { return { start: startOfZonedDate(from, timezone), end: startOfZonedDate(addCalendarDays(to, 1), timezone) } }
function scopeWhere(organizationId: string, locations: Awaited<ReturnType<typeof reportAccess>>['locations'], from: string, to: string): Prisma.OrganizationMemberWhereInput {
  return { organizationId, OR: locations.map(location => {
    const { start, end } = range(from, to, location.timezone)
    return { OR: [
      { workShifts: { some: { organizationId, locationId: location.id, status: { not: 'CANCELLED' }, cancelledAt: null, scheduledStartAt: { gte: start, lt: end } } } },
      { locationMemberships: { some: { locationId: location.id, joinedAt: { lt: end }, OR: [{ leftAt: null }, { leftAt: { gt: start } }] } } },
      { locationTransfers: { some: { toLocationId: location.id, startAt: { lt: end }, AND: [{ OR: [{ revokedAt: null }, { revokedAt: { gt: start } }] }, { OR: [{ revokedAt: null }, { revokedAt: { gt: prisma.locationTransfer.fields.startAt } }] }], OR: [{ endAt: null }, { endAt: { gt: start } }] } } },
    ] }
  }) }
}
const nameOf = (user: { lastName: string | null; firstName: string | null; middleName: string | null; email: string }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email.split('@')[0]
export async function reportOptions(userId: string, organizationId: string) {
  const { actor, locations } = await reportAccess(userId, organizationId)
  const templates = await prisma.reportTemplate.findMany({ where: { organizationId }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  return { locations: locations.map(({ id, name, timezone, archivedAt }) => ({ id, name, timezone, archivedAt })), templates: templates.map(template => ({ id: template.id, name: template.name, config: normalizeReportConfig(template.config as ReportConfig), canManage: (actor.owner || locationsFor(actor,'reports.templates').length>0) && (actor.owner || template.createdByMemberId===actor.id || locationsFor(actor,'reports.templates.all').length>0) })) }
}
export async function reportMembers(userId: string, organizationId: string, input: ReportInput) {
  const access = await reportAccess(userId, organizationId)
  const selected = selectedLocations(access, input.locationIds)
  if (!selected.length) throw fail('Нет доступных точек.')
  const members = await prisma.organizationMember.findMany({ where: { ...scopeWhere(organizationId, selected, input.from, input.to), ...(input.includeFormer ? {} : { leftAt: null, user: { deletedAt: null } }) }, include: { user: true }, orderBy: { id: 'asc' }, take: 1001 })
  if (members.length > 1000) throw new ApiError(400, 'REPORT_LIMIT', 'В области больше 1000 сотрудников. Выберите меньше точек или короче период.')
  return { members: members.map(member => ({ id: member.id, displayName: nameOf(member.user), email: member.user.email, avatarUrl: mediaUrl(member.user.avatarFileId), former: !!member.leftAt || !!member.user.deletedAt })) }
}
export async function saveReportTemplate(userId: string, organizationId: string, id: string | null, input: { name: string; config: ReportConfig }) {
  return prisma.$transaction(async db => {
    const { actor } = await reportAccess(userId, organizationId, db, 'reports.templates')
    if (id) await editableTemplate(db, organizationId, id, actor)
    else if (await db.reportTemplate.count({ where: { organizationId } }) >= 100) throw new ApiError(400, 'REPORT_LIMIT', 'Можно сохранить не более 100 настроек.')
    const data = { name: input.name, config: normalizeReportConfig(input.config) as unknown as Prisma.InputJsonValue }
    return id ? db.reportTemplate.update({ where: { id }, data }) : db.reportTemplate.create({ data: { ...data, organizationId, createdByMemberId: actor.id } })
  }, { isolationLevel: 'Serializable' })
}
async function editableTemplate(db: DB, organizationId: string, id: string, actor: Awaited<ReturnType<typeof getMembership>>) {
  const template = await db.reportTemplate.findFirst({ where: { id, organizationId } })
  if (!template) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Настройка не найдена.')
  if (!locationsFor(actor, 'reports.templates.all').length && !actor.owner && template.createdByMemberId !== actor.id) throw fail('Можно изменять и удалять только собственные настройки.')
  return template
}
export async function deleteReportTemplate(userId: string, organizationId: string, id: string) {
  await prisma.$transaction(async db => { const { actor } = await reportAccess(userId, organizationId, db, 'reports.templates'); await editableTemplate(db, organizationId, id, actor); await db.reportTemplate.delete({ where: { id } }) })
}
type Cell = string | number | Date | null
type Row = Record<string, Cell>
export type BuiltReport = { generatedAt: Date; metrics: ReportPreview['metrics']; warnings: ReportPreview['warnings']; rows: Record<ReportSheet, Row[]>; config: ReportConfig }
// Repeatable read gives all sheets one database snapshot within this operation.
export async function buildReport(userId: string, organizationId: string, input: ReportInput, now = new Date(), permission: Permission = 'reports.preview'): Promise<BuiltReport> {
  input = { ...input, config: normalizeReportConfig(input.config) }
  return prisma.$transaction(async db => {
    const access = await reportAccess(userId, organizationId, db, permission), locations = selectedLocations(access, input.locationIds)
    const scopeError = reportScopeError(input.config, locations.length)
    if (scopeError) throw new ApiError(400, 'REPORT_LOCATION_REQUIRED', scopeError)
    const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId } })
    const members = await db.organizationMember.findMany({ where: { ...scopeWhere(organizationId, locations, input.from, input.to), ...(input.includeFormer ? {} : { leftAt: null, user: { deletedAt: null } }) }, include: { user: true, locationMemberships: true, locationTransfers: true }, take: MAX_ROWS + 1 })
    if (members.length > MAX_ROWS) throw new ApiError(400, 'REPORT_LIMIT', 'Слишком много сотрудников. Уменьшите область отчёта.')
    if (input.memberIds.some(id => !members.some(member => member.id === id))) throw fail('Выбранный сотрудник вне организации, периода или управляемой области.')
    const selectedMembers = input.memberIds.length ? members.filter(member => input.memberIds.includes(member.id)) : members
    const memberMap = new Map(selectedMembers.map(member => [member.id, member]))
    const shifts = await db.workShift.findMany({ where: { organizationId, memberId: { in: [...memberMap.keys()] }, status: { not: 'CANCELLED' }, cancelledAt: null, OR: locations.map(location => { const { start, end } = range(input.from, input.to, location.timezone); return { locationId: location.id, scheduledStartAt: { gte: start, lt: end } } }) }, orderBy: [{ scheduledStartAt: 'asc' }, { memberId: 'asc' }, { id: 'asc' }], take: MAX_ROWS + 1 })
    const absences = await db.employeeAbsence.findMany({ where: { organizationId, memberId: { in: [...memberMap.keys()] }, cancelledAt: null, startDate: { lte: new Date(input.to) }, endDate: { gte: new Date(input.from) } }, orderBy: [{ startDate: 'asc' }, { memberId: 'asc' }, { id: 'asc' }], take: MAX_ROWS + 1 })
    if (shifts.length > MAX_ROWS || absences.length > MAX_ROWS) throw new ApiError(400, 'REPORT_LIMIT', `Не более ${MAX_ROWS} строк на лист. Уменьшите период или область.`)
    let templateName: string | null = null
    if (input.templateId) { const template = await db.reportTemplate.findFirst({ where: { id: input.templateId, organizationId } }); if (!template) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Настройка больше недоступна.'); templateName = template.name }
    const rows: BuiltReport['rows'] = { summary: [], shifts: [], absences: [], parameters: [] }
    const totals = new Map<string, { memberId: string; locationId: string; minutes: number; shifts: number; locations: Set<string>; positions: Set<string> }>()
    const locationLabels = new Map(locations.map(point => {
      const duplicates = locations.filter(other => other.name === point.name)
      const label = duplicates.length > 1 ? `${point.name} (${point.city}, ${point.address || 'без адреса'})` : point.name
      return [point.id, duplicates.filter(other => other.city === point.city && other.address === point.address).length > 1 ? `${label} · ${point.id}` : label]
    }))
    const locationLabel = (id: string) => locationLabels.get(id)!
    const startsByMemberPoint = new Map<string, number[]>()
    const metrics = { employees: 0, shifts: shifts.length, minutes: 0, hours: 0, futureShifts: 0, futureHours: 0 }
    let futureMinutes = 0
    const nameCounts = new Map<string, number>()
    for (const member of selectedMembers) { const name = nameOf(member.user); nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1) }
    const identity = (id: string) => {
      const member = memberMap.get(id)!, name = nameOf(member.user)
      const sameName = (nameCounts.get(name) ?? 0) > 1
      return { memberId: id, name: sameName ? `${name} (${id.slice(0, 8)})` : name }
    }
    for (const shift of shifts) {
      const scopeKey = `${shift.memberId}:${shift.locationId}`
      const starts = startsByMemberPoint.get(scopeKey) ?? []
      starts.push(shift.scheduledStartAt.getTime()); startsByMemberPoint.set(scopeKey, starts)
      const location = locations.find(location => location.id === shift.locationId)!, minutes = shift.attendance==='NO_SHOW'?0:Math.max(0, Math.floor(((shift.actualEndAt??shift.scheduledEndAt).getTime() - (shift.actualStartAt??shift.scheduledStartAt).getTime()) / 60000))
      const aggregate = totals.get(scopeKey) ?? { memberId: shift.memberId, locationId: shift.locationId, minutes: 0, shifts: 0, locations: new Set<string>(), positions: new Set<string>() }
      aggregate.minutes += minutes; aggregate.shifts++; aggregate.locations.add(locationLabel(location.id)); if (shift.positionNameSnapshot) aggregate.positions.add(shift.positionNameSnapshot); totals.set(scopeKey, aggregate)
      metrics.minutes += minutes
      const future = shift.scheduledStartAt > now
      if (future) { metrics.futureShifts++; futureMinutes += minutes }
      rows.shifts.push({ id: shift.id, ...identity(shift.memberId), locationId: location.id, location: locationLabel(location.id), timezone: location.timezone, position: shift.positionNameSnapshot, start: localExcelDate(shift.actualStartAt??shift.scheduledStartAt, location.timezone), end: localExcelDate(shift.actualEndAt??shift.scheduledEndAt, location.timezone), break: shift.breakMinutes, minutes, hours: minutes / 60, state: shift.attendance==='NO_SHOW'?'Неявка':shift.attendance==='PARTIAL'?'Частично отработана':future ? 'Будущая' : shift.scheduledEndAt <= now ? 'Завершена' : 'Идёт', comment: shift.description })
    }
    for (const absence of absences) {
      const start = absence.startDate.toISOString().slice(0, 10), end = absence.endDate.toISOString().slice(0, 10), overlapStart = start > input.from ? start : input.from, overlapEnd = end < input.to ? end : input.to
      // Check the absence's own overlap, rather than revealing the whole period's absences after a transfer.
      const member = memberMap.get(absence.memberId)!
      const relevant = locations.filter(location => {
        const { start: a, end: b } = range(overlapStart, overlapEnd, location.timezone)
        return hasStartInRange(startsByMemberPoint.get(`${member.id}:${location.id}`) ?? [], a.getTime(), b.getTime()) || member.locationMemberships.some(item => item.locationId === location.id && item.joinedAt < b && (!item.leftAt || item.leftAt > a)) || member.locationTransfers.some(item => item.toLocationId === location.id && item.startAt < b && (!item.revokedAt || item.revokedAt > a && item.revokedAt > item.startAt) && (!item.endAt || item.endAt > a))
      })
      if (!relevant.length) continue
      for (const location of relevant) {
        const scopeKey = `${absence.memberId}:${location.id}`
        if (!totals.has(scopeKey)) totals.set(scopeKey, { memberId: absence.memberId, locationId: location.id, minutes: 0, shifts: 0, locations: new Set([locationLabel(location.id)]), positions: new Set() })
      }
      const details = relevant.every(l=>hasPermission(access.actor,'absences.details',l.id))
      rows.absences.push({ locations: relevant.map(location => locationLabel(location.id)).join('; '), id: absence.id, ...identity(absence.memberId), type: details ? ({ VACATION: 'Отпуск', SICK: 'Больничный', SICK_LEAVE: 'Больничный', DAY_OFF: 'Отгул', ABSENCE: 'Отсутствие' } as Record<string, string>)[absence.type] ?? 'Отсутствие' : 'Отсутствие', start: new Date(start), end: new Date(end), overlapStart: new Date(overlapStart), overlapEnd: new Date(overlapEnd), days: (Date.parse(overlapEnd) - Date.parse(overlapStart)) / 86400000 + 1, source: absence.sourceRequestId ? 'Одобренная заявка' : 'Зарегистрированное отсутствие', comment: details ? absence.comment : null })
    }
    const warnings: BuiltReport['warnings'] = { incompleteName: [] }
    for (const aggregate of totals.values()) {
      const id = aggregate.memberId
      const member = memberMap.get(id)!, identityRow = identity(id)
      rows.summary.push({ ...identityRow, locationId: aggregate.locationId, locations: [...aggregate.locations].sort().join('; ') || null, positions: [...aggregate.positions].sort().join('; ') || null, status: member.leftAt || member.user.deletedAt ? 'Бывший' : 'Активный', shifts: aggregate.shifts, hours: aggregate.minutes / 60 })
      if ((!member.user.firstName || !member.user.lastName || !member.user.middleName) && !warnings.incompleteName.some(item => item.id === id)) warnings.incompleteName.push({ id, name: identityRow.name })
    }
    rows.summary.sort((a, b) => String(a.locations).localeCompare(String(b.locations), 'ru') || String(a.locationId).localeCompare(String(b.locationId)) || String(a.name).localeCompare(String(b.name), 'ru') || String(a.memberId).localeCompare(String(b.memberId)))
    rows.shifts.sort((a, b) => String(a.location).localeCompare(String(b.location), 'ru') || String(a.locationId).localeCompare(String(b.locationId)) || String(a.name).localeCompare(String(b.name), 'ru') || (a.start as Date).getTime() - (b.start as Date).getTime())
    rows.absences.sort((a, b) => String(a.locations).localeCompare(String(b.locations), 'ru') || String(a.name).localeCompare(String(b.name), 'ru') || (a.start as Date).getTime() - (b.start as Date).getTime())
    metrics.employees = new Set([...totals.values()].map(value => value.memberId)).size; metrics.hours = metrics.minutes / 60; metrics.futureHours = futureMinutes / 60
    const parameters: Record<string, string> = {
      'Организация': organization.name, 'Период включительно': `${input.from.split('-').reverse().join('.')} — ${input.to.split('-').reverse().join('.')}`, 'Время формирования': `${new Intl.DateTimeFormat('ru-RU', { timeZone: organization.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(now)} (${organization.timezone})`, 'Точки и часовые пояса': locations.map(location => `${locationLabel(location.id)} (${location.timezone})`).join('; '), 'Сотрудники': input.memberIds.length ? selectedMembers.map(member => nameOf(member.user)).join('; ') : 'Все с данными периода в выбранной области', 'Бывшие сотрудники': input.includeFormer ? 'Включены при наличии данных' : 'Исключены', 'Расчёт часов': 'Фактическое время, если указано, иначе план; неявка — 0 часов', 'Перерыв': 'Включён в длительность', 'Отменённые смены': 'Исключены', 'Будущие смены': `${metrics.futureShifts}; ${metrics.futureHours.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ч; включены`, 'Ночные смены': 'Целиком по местной дате начала в часовом поясе точки', 'Отсутствия': 'Неотменённые записи; пересечение дат включительно; не уменьшают часы и не означают оплату', 'Область отсутствий': 'Смены, назначения или переводы в выбранные точки, пересекающиеся с датами отсутствия; каждое отсутствие один раз', 'Точность': 'Полные минуты; суммирование до перевода в часы; отображение 2 знака', 'Сохранённая настройка': templateName ?? 'Не использована', 'Разделение заведений': 'Сводка: отдельная строка для каждого сотрудника в каждом заведении. Смены сгруппированы по заведению и сотруднику.', 'Идентификаторы': 'Технические ID доступны только по выбору колонок.',
    }
    rows.parameters = Object.entries(parameters).map(([parameter, value]) => ({ parameter, value }))
    for (const sheet of input.config.sheets.filter(sheet => sheet.enabled)) {
      if (rows[sheet.key].length > MAX_ROWS) throw new ApiError(400, 'REPORT_LIMIT', 'Слишком много строк после разделения по заведениям. Уменьшите область отчёта.')
      if (rows[sheet.key].some(row => sheet.columns.some(column => typeof row[column.key] === 'string' && (row[column.key] as string).length > 32767))) {
        throw new ApiError(400, 'REPORT_LIMIT', 'Слишком длинное текстовое значение для ячейки Excel. Уменьшите область отчёта или состав сотрудников.')
      }
    }
    return { generatedAt: now, metrics, warnings, rows, config: input.config }
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 })
}
export function localExcelDate(date: Date, timezone: string) { const p = zonedParts(date, timezone); return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)) }
function hasStartInRange(starts: number[], from: number, to: number) {
  let low = 0, high = starts.length
  while (low < high) { const middle = Math.floor((low + high) / 2); if (starts[middle] < from) low = middle + 1; else high = middle }
  return low < starts.length && starts[low] < to
}
function totalCells(report: BuiltReport, key: ReportSheet, columns: Array<{ key: string }>): Array<string | number | null> | null {
  if (key !== 'summary' || !report.config.totals) return null
  return columns.map(column => column.key === 'shifts' ? report.metrics.shifts : column.key === 'hours' ? report.metrics.hours : null)
}
export function previewReport(report: BuiltReport): ReportPreview {
  return { generatedAt: report.generatedAt.toISOString(), metrics: report.metrics, warnings: report.warnings, sheets: report.config.sheets.filter(sheet => sheet.enabled).map(sheet => ({ key: sheet.key, title: reportCatalog[sheet.key].title, columns: sheet.columns.map(column => ({ ...reportCatalog[sheet.key].fields.find(field => field.key === column.key)!, title: column.title })), rows: report.rows[sheet.key].slice(0, 20).map(row => sheet.columns.map(column => { const value = row[column.key]; return value instanceof Date ? value.toISOString() : value })), total: report.rows[sheet.key].length, totals: totalCells(report, sheet.key, sheet.columns) })) }
}
export async function reportWorkbook(report: BuiltReport) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Staffly'; workbook.created = report.generatedAt
  const metadata = new Map(report.rows.parameters.map(row => [row.parameter, row.value]))
  const presentation = report.config.layout === 'report'
  const headerRow = presentation ? 7 : 1
  const ink = 'FF202124', muted = 'FF717680', line = 'FFDDE0E4'
  for (const sheet of report.config.sheets.filter(sheet => sheet.enabled)) {
    const worksheet = workbook.addWorksheet(reportCatalog[sheet.key].title)
    worksheet.properties.defaultRowHeight = 28
    worksheet.columns = sheet.columns.map(column => {
      const field = reportCatalog[sheet.key].fields.find(field => field.key === column.key)!
      return { key: column.key, width: field.width, style: { font: { name: 'Arial', size: 11, color: { argb: ink } }, numFmt: field.type === 'hours' ? '0.00' : field.type === 'number' ? '0' : field.type === 'date' ? 'dd.mm.yyyy' : field.type === 'datetime' ? 'dd.mm.yyyy hh:mm' : '@', alignment: { vertical: 'middle', horizontal: ['number', 'hours'].includes(field.type) ? 'right' : 'left', wrapText: true } } }
    })
    if (presentation) {
      worksheet.getCell('A1').value = String(metadata.get('Организация') ?? 'Staffly')
      worksheet.getCell('A1').font = { name: 'Arial', size: 11, color: { argb: muted } }
      worksheet.getCell('A2').value = `${reportCatalog[sheet.key].title} · отчёт рабочего времени`
      worksheet.getCell('A2').font = { name: 'Arial', size: 17, bold: true, color: { argb: ink } }
      worksheet.getRow(2).height = 32
      worksheet.getCell('A3').value = String(metadata.get('Период включительно') ?? '')
      worksheet.getCell('A4').value = `Сформирован: ${String(metadata.get('Время формирования') ?? '')}`
      for (const row of [1, 2, 3, 4]) worksheet.getCell(row, 1).alignment = { vertical: 'middle', wrapText: false }
      for (const row of [3, 4]) worksheet.getCell(row, 1).font = { name: 'Arial', size: 10, color: { argb: muted } }
      worksheet.getRow(5).height = 10; worksheet.getRow(6).height = 12
      sheet.columns.forEach((_, index) => { worksheet.getCell(5, index + 1).border = { bottom: { style: 'thin', color: { argb: line } } } })
    }
    const header = worksheet.getRow(headerRow)
    header.values = sheet.columns.map(column => column.title)
    header.height = 42; header.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF30343B' } }
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    header.eachCell(cell => { cell.numFmt = '@' })
    let previousLocation: Cell | undefined
    for (const [index, row] of report.rows[sheet.key].entries()) {
      const added = worksheet.addRow(sheet.columns.map(column => row[column.key] ?? null))
      added.height = Math.max(34, ...sheet.columns.map((column, col) => {
        const value = row[column.key], width = worksheet.getColumn(col + 1).width ?? 24
        return typeof value === 'string' ? value.split('\n').reduce((count, text) => count + Math.max(1, Math.ceil(text.length / Math.max(1, width - 3))), 0) * 15 + 10 : 34
      }))
      const point = row.locationId ?? row.locations
      added.eachCell({ includeEmpty: true }, (cell, col) => {
        if (index % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F7F8' } }
        if (index && point !== undefined && point !== previousLocation) cell.border = { top: { style: 'thin', color: { argb: 'FFBBC1C9' } } }
        const key = sheet.columns[col - 1].key
        if (key === 'id' || key === 'memberId') cell.font = { name: 'Arial', size: 10, color: { argb: muted } }
      })
      previousLocation = point
    }
    const dataEnd = worksheet.rowCount
    worksheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: dataEnd, column: sheet.columns.length } }
    const totals = totalCells(report, sheet.key, sheet.columns)
    if (totals) {
      const total = worksheet.addRow(totals)
      total.font = { name: 'Arial', size: 11, bold: true, color: { argb: ink } }; total.height = 34
      total.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECEF' } }
      total.eachCell({ includeEmpty: true }, cell => { cell.border = { top: { style: 'thin', color: { argb: 'FFBBC1C9' } } } })
      const label = totals.findIndex(value => value === null)
      if (label >= 0) total.getCell(label + 1).value = 'Итого'
    }
    const lastTableRow = worksheet.rowCount
    if (presentation) {
      worksheet.addRow([])
      const note = worksheet.addRow([sheet.key === 'absences' ? 'Отсутствия не уменьшают часы. Заведения показывают область учёта; дни не суммируются между точками.' : sheet.key === 'summary' ? 'Отдельная строка на сотрудника и заведение. Фактическое время, иначе план; неявка — 0 часов; перерыв включён.' : sheet.key === 'shifts' ? 'Даты и время местные для заведения; часовой пояс указан в строке. Отменённые смены исключены.' : 'Правила и фильтры на момент формирования отчёта.'])
      note.font = { name: 'Arial', size: 10, color: { argb: muted } }; note.getCell(1).alignment = { wrapText: false }
    }
    const nameIndex = sheet.columns.findIndex(column => column.key === 'name')
    worksheet.views = [{ state: 'frozen', ySplit: headerRow, xSplit: nameIndex >= 0 && nameIndex < sheet.columns.length - 1 ? nameIndex + 1 : 0, showGridLines: false }]
    worksheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow}:${headerRow}`, printArea: `A1:${worksheet.getColumn(sheet.columns.length).letter}${lastTableRow}` }
    worksheet.headerFooter.oddFooter = '&LStaffly&RСтраница &P из &N'
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
