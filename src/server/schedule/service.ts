import { hasPermission, requirePermission } from '../organizations/access.ts'
import { displayDate, shiftTimeRange, zonedDateAndTime } from '../../app/schedule/date-utils.ts'
import { requireLocationManager } from '../organizations/location-service.ts'
import { locationWhere, locationMemberWhere, scopedLocationId } from '../organizations/location-context.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { absenceLabels } from './absence-service.ts'
import { checkMonthlyWorkload } from './workload.ts'
import { cancelShiftRequests, lockShift } from '../requests/shift-conflicts.ts'
import type { Prisma, WorkShift } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/permissions.ts'
import { addCalendarDays, startOfZonedDate, zonedDateTimeToUtc } from './timezone.ts'
import { recordShiftNotification, sendImportantShiftEmail } from '../organizations/notification-service.ts'

const dateText = (value: Date) => value.toISOString().slice(0, 10)
export function shiftConflictMessage(shift: {scheduledStartAt:Date|string;scheduledEndAt:Date|string}, timezone:string) {
  const start=new Date(shift.scheduledStartAt).toISOString(),end=new Date(shift.scheduledEndAt).toISOString()
  return `Уже назначена смена ${displayDate(zonedDateAndTime(start,timezone).date)}, ${shiftTimeRange(start,end,timezone)}. Две смены одного сотрудника не могут совпадать по времени. Измените время или выберите другого сотрудника.`
}

export type ShiftInput = { memberId: string; startDate: string; startTime: string; endDate: string; endTime: string; breakMinutes: number; description: string | null; positionId?: string | null; acknowledgeWorkload?: boolean; acknowledgeAbsence?: boolean }
export type ActualInput = Omit<ShiftInput, 'memberId' | 'description'> & { reason: string }

function isOverlapError(error: unknown) {
  try { return JSON.stringify(error).includes('23P01') || JSON.stringify(error).includes('work_shifts_no_overlap') } catch { return false }
}

function displayName(user: { firstName: string | null; lastName: string | null; middleName: string | null; email: string }) {
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email.split('@')[0]
}

export function countedMinutes(start: Date, end: Date) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000))
}

export function validateDuration(startAt: Date, endAt: Date, breakMinutes: number) {
  if (endAt <= startAt) throw new ApiError(400, 'INVALID_SHIFT_RANGE', 'Окончание смены должно быть позже начала.')
  const durationMinutes = Math.floor((endAt.getTime() - startAt.getTime()) / 60_000)
  if (breakMinutes >= durationMinutes) throw new ApiError(400, 'INVALID_SHIFT_BREAK', 'Перерыв должен быть короче смены.')
}

export async function activeTarget(tx: Prisma.TransactionClient | typeof prisma, organizationId: string, memberId: string, startAt?: Date, endAt?: Date) {
  const member = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null, user: { deletedAt: null } }, include: { user: { select: { email: true } } } })
  if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Активный сотрудник организации не найден.')
  const locationId = scopedLocationId(organizationId)
  if (locationId && member.role !== 'OWNER') {
    const permanent = await tx.locationMember.findFirst({ where: { locationId, memberId, leftAt: null } })
    const temporary = startAt && endAt ? await tx.locationTransfer.findFirst({ where: { organizationId, memberId, toLocationId: locationId, temporary: true, startAt: { lte: startAt }, endAt: { gte: endAt } } }) : await tx.locationTransfer.findFirst({ where: { organizationId, memberId, toLocationId: locationId, temporary: true, endAt: { gt: new Date() } } })
    if (!permanent && !temporary) throw new ApiError(400, 'MEMBER_NOT_IN_LOCATION', 'Сотрудник не назначен в эту точку на период смены.')
  }
  return member
}

async function shiftInOrganization(tx: Prisma.TransactionClient | typeof prisma, organizationId: string, shiftId: string) {
  const shift = await tx.workShift.findFirst({ where: { id: shiftId, organizationId, ...locationWhere(organizationId) } })
  if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
  return shift
}

export async function assertNoApprovedAbsence(organizationId: string, memberId: string, startAt: Date, endAt: Date, timezone: string, client: Prisma.TransactionClient | typeof prisma = prisma, acknowledge = false) {
  const absences = await client.employeeAbsence.findMany({ where: { organizationId, memberId, cancelledAt: null }, orderBy: { startDate: 'asc' } })
  const absence = absences.find((item) => {
    const absenceStart = startOfZonedDate(dateText(item.startDate), timezone)
    const absenceEnd = startOfZonedDate(addCalendarDays(dateText(item.endDate), 1), timezone)
    return startAt < absenceEnd && endAt > absenceStart
  })
  if (absence && !acknowledge) throw new ApiError(409, 'EMPLOYEE_ABSENT', `Сотрудник отсутствует ${dateText(absence.startDate)}–${dateText(absence.endDate)}: ${absenceLabels[absence.type] ?? 'Отсутствие'}. Подтвердите назначение смены несмотря на отсутствие.`, { absenceId: absence.id })
}

export function publicShift(shift: WorkShift & { member: { user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null; avatarFileId: string | null } }; _count?: { adjustments: number }; offerReservation?: { offer: { id: string; kind: string; status: string } } | null }) {
  const effectiveStartAt = shift.actualStartAt ?? shift.scheduledStartAt
  const effectiveEndAt = shift.actualEndAt ?? shift.scheduledEndAt
  return {
    id: shift.id,
    activeOffer: shift.offerReservation?.offer ?? null,
    locationId: shift.locationId,
    positionId: shift.positionId,
    positionName: shift.positionNameSnapshot,
    memberId: shift.memberId,
    memberName: displayName(shift.member.user),
    memberAvatarUrl: mediaUrl(shift.member.user.avatarFileId),
    scheduledStartAt: shift.scheduledStartAt,
    scheduledEndAt: shift.scheduledEndAt,
    breakMinutes: shift.breakMinutes,
    actualStartAt: shift.actualStartAt,
    actualEndAt: shift.actualEndAt,
    actualBreakMinutes: shift.actualBreakMinutes,
    effectiveMinutes: countedMinutes(effectiveStartAt, effectiveEndAt),
    description: shift.description,
    status: shift.status,
    cancelledAt: shift.cancelledAt,
    cancellationReason: shift.cancellationReason,
    adjusted: Boolean(shift._count?.adjustments),
  }
}

export const shiftInclude = { offerReservation: { select: { offer: { select: { id: true, kind: true, status: true } } } }, member: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } }, _count: { select: { adjustments: true } } } as const

export async function listCancelledShifts(userId: string, organizationId: string, query: { page: number; limit: number; memberId?: string; order: 'asc' | 'desc' }) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'schedule.history')
  const where = { organizationId, ...locationWhere(organizationId), status: 'CANCELLED' as const, ...(query.memberId ? { memberId: query.memberId } : {}) }
  const [total, shifts] = await Promise.all([
    prisma.workShift.count({ where }),
    prisma.workShift.findMany({ where, include: shiftInclude, orderBy: [{ cancelledAt: query.order }, { id: query.order }], skip: (query.page - 1) * query.limit, take: query.limit }),
  ])
  return { timezone: actor.organization.timezone, shifts: shifts.map(publicShift), pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } }
}

export async function listSchedule(userId: string, organizationId: string, fromDate: string, toDate: string, mode?: 'current' | 'history') {
  const actor = await getMembership(userId, organizationId)
  const from = startOfZonedDate(fromDate, actor.organization.timezone)
  const to = startOfZonedDate(toDate, actor.organization.timezone)
  if (mode === 'history') requirePermission(actor, 'schedule.history')
  if (!hasPermission(actor,'schedule.view') && !hasPermission(actor,'schedule.own') && hasPermission(actor,'coverage.view')) return {timezone:actor.organization.timezone,shifts:[],absences:[]}
  if (!hasPermission(actor, 'schedule.view')) requirePermission(actor, 'schedule.own')
  const shifts = await prisma.workShift.findMany({
    where: { organizationId, ...locationWhere(organizationId), ...(!hasPermission(actor, 'schedule.view') ? { memberId: actor.id } : {}), status: mode === 'history' ? 'CANCELLED' : 'SCHEDULED', scheduledStartAt: { lt: to }, scheduledEndAt: { gt: from } },
    include: shiftInclude,
    orderBy: [{ scheduledStartAt: 'asc' }, { member: { user: { lastName: 'asc' } } }],
  })
  const absences = await prisma.employeeAbsence.findMany({ where: { organizationId, member: locationMemberWhere(organizationId), ...(!hasPermission(actor, 'absences.view') && !hasPermission(actor, 'schedule.view') ? { memberId: actor.id } : {}), cancelledAt: null, startDate: { lt: new Date(`${toDate}T00:00:00.000Z`) }, endDate: { gte: new Date(`${fromDate}T00:00:00.000Z`) } }, include: { member: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } } }, orderBy: { startDate: 'asc' } })
  return { timezone: actor.organization.timezone, shifts: shifts.map(publicShift), absences: (mode === 'history' ? [] : absences).map((item) => ({ id: item.id, memberId: item.memberId, memberName: displayName(item.member.user), memberAvatarUrl: mediaUrl(item.member.user.avatarFileId), reason: !hasPermission(actor, 'absences.details') && item.memberId !== actor.id ? null : item.reason, type: !hasPermission(actor, 'absences.details') && item.memberId !== actor.id ? 'ABSENCE' as const : item.type, startDate: dateText(item.startDate), endDate: dateText(item.endDate) })) }
}

export async function listMyUpcomingShifts(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'schedule.own')
  const shifts = await prisma.workShift.findMany({
    where: { organizationId, ...locationWhere(organizationId), memberId: actor.id, status: 'SCHEDULED', scheduledEndAt: { gt: new Date() } },
    include: shiftInclude,
    orderBy: { scheduledStartAt: 'asc' },
  })
  return { timezone: actor.organization.timezone, shifts: shifts.map(publicShift) }
}

export async function createShift(userId: string, organizationId: string, input: ShiftInput) {
  return (await createShiftBatch(userId, organizationId, [input], input.acknowledgeWorkload)).shifts[0]
}

export async function createShiftBatch(userId: string, organizationId: string, inputs: ShiftInput[], acknowledgeWorkload = false) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'schedule.create')
  if (!inputs.length || inputs.length > 62) throw new ApiError(400, 'BATCH_SIZE', 'Выберите от 1 до 62 смен.')
  const prepared = inputs.map(input => {
    const start = zonedDateTimeToUtc(input.startDate, input.startTime, actor.organization.timezone)
    const end = zonedDateTimeToUtc(input.endDate, input.endTime, actor.organization.timezone)
    validateDuration(start, end, input.breakMinutes)
    return { input, start, end }
  })
  try {
    const result = await prisma.$transaction(async tx => {
      if (scopedLocationId(organizationId)) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`; await requireLocationManager(tx, userId, organizationId, actor.locationId, 'schedule.create') }
      const records = []
      for (const memberId of [...new Set(inputs.map(input => input.memberId))].sort()) {
        await activeTarget(tx, organizationId, memberId)
        await checkMonthlyWorkload(tx, organizationId, memberId, actor.organization.timezone, actor.organization.monthlyWorkMinutes, prepared.filter(item => item.input.memberId === memberId), [], acknowledgeWorkload)
      }
      for (const { input, start, end } of prepared) {
        try {
          await activeTarget(tx, organizationId, input.memberId, start, end)
          await assertNoApprovedAbsence(organizationId, input.memberId, start, end, actor.organization.timezone, tx, input.acknowledgeAbsence)
          const conflict = await tx.workShift.findFirst({ where: { organizationId, memberId: input.memberId, status: 'SCHEDULED', scheduledStartAt: { lt: end }, scheduledEndAt: { gt: start } } }); if (conflict) throw new ApiError(409, 'SHIFT_OVERLAP', shiftConflictMessage(conflict,actor.organization.timezone))
          const position = input.positionId ? await tx.organizationPosition.findFirst({ where: { id: input.positionId, organizationId, isActive: true, members: { some: { memberId: input.memberId } } } }) : null
          if (input.positionId && !position) throw new ApiError(400, 'POSITION_NOT_ASSIGNED', 'Должность не назначена сотруднику или неактивна.')
          const mutation = await mutatePlannedShift(tx, actor, { input, startAt: start, endAt: end })
          records.push({ created: mutation.changed, notification: mutation.notification! })
        } catch (error) {
          if (error instanceof ApiError) throw new ApiError(error.status, error.code, input.startDate + ': ' + error.message + ' Пакет не сохранён.', { date: input.startDate })
          throw error
        }
      }
      return records
    }, { isolationLevel: 'Serializable' })
    for (const item of result) {
      void sendImportantShiftEmail(item.notification.id, item.created, item.created.member.user.email, actor.organization.name, actor.organization.timezone, 'SHIFT_ASSIGNED').catch(error => console.error('Shift email failed:', error))
    }
    return { shifts: result.map(item => publicShift(item.created)) }
  } catch (error) {
    if (isOverlapError(error) || (error as { code?: string }).code === 'P2034') throw new ApiError(409, 'SHIFT_CONFLICT', 'Расписание изменилось или смены пересекаются. Пакет не сохранён. Проверьте даты и повторите.')
    throw error
  }
}

export async function updateShift(userId: string, organizationId: string, shiftId: string, input: ShiftInput) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'schedule.edit')
  const current = await shiftInOrganization(prisma, organizationId, shiftId)
  if (current.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Отменённую смену нельзя изменить.')
  if (current.scheduledEndAt <= new Date()) throw new ApiError(409, 'SHIFT_ALREADY_FINISHED', 'Для завершённой смены измените фактическое время.')
  const target = await activeTarget(prisma, organizationId, input.memberId)
  const startAt = zonedDateTimeToUtc(input.startDate, input.startTime, actor.organization.timezone)
  const endAt = zonedDateTimeToUtc(input.endDate, input.endTime, actor.organization.timezone)
  validateDuration(startAt, endAt, input.breakMinutes)
  await assertNoApprovedAbsence(organizationId, input.memberId, startAt, endAt, actor.organization.timezone, prisma, input.acknowledgeAbsence)
  const conflict = await prisma.workShift.findFirst({ where: { id: { not: shiftId }, memberId: input.memberId, status: 'SCHEDULED', scheduledStartAt: { lt: endAt }, scheduledEndAt: { gt: startAt } } })
  if (conflict) throw new ApiError(409, 'SHIFT_OVERLAP', shiftConflictMessage(conflict,actor.organization.timezone))
  try {
    const shift = await prisma.$transaction(async tx => {
      if (scopedLocationId(organizationId)) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`; await requireLocationManager(tx, userId, organizationId, actor.locationId, 'schedule.edit') }
    await lockShift(tx, shiftId)
      const fresh = await shiftInOrganization(tx, organizationId, shiftId)
      if (fresh.updatedAt.getTime() !== current.updatedAt.getTime() || fresh.status !== 'SCHEDULED') throw new ApiError(409, 'SHIFT_CHANGED', 'Смена уже изменилась. Откройте её заново.')
      await activeTarget(tx, organizationId, input.memberId, startAt, endAt)
      await assertNoApprovedAbsence(organizationId, input.memberId, startAt, endAt, actor.organization.timezone, tx, input.acknowledgeAbsence)
      await checkMonthlyWorkload(tx, organizationId, input.memberId, actor.organization.timezone, actor.organization.monthlyWorkMinutes, [{ start: startAt, end: endAt }], [shiftId], input.acknowledgeWorkload)
      const position = input.positionId ? await tx.organizationPosition.findFirst({ where: { id: input.positionId, organizationId, isActive: true, members: { some: { memberId: input.memberId } } } }) : null
      if (input.positionId && !position) throw new ApiError(400, 'POSITION_NOT_ASSIGNED', 'Выберите назначенную сотруднику должность.')
      return mutatePlannedShift(tx, actor, { current: fresh, input, startAt, endAt })
    }, { isolationLevel: 'Serializable' })
    if (shift.notification) void sendImportantShiftEmail(shift.notification.id, shift.changed, target.user.email, actor.organization.name, actor.organization.timezone, current.memberId !== input.memberId ? 'SHIFT_ASSIGNED' : 'SHIFT_CHANGED', current).catch(error => console.error('Shift email failed:', error))
    if (shift.previousAssignment) {
      const previous = shift.previousAssignment
      void sendImportantShiftEmail(previous.notification.id, previous.shift, previous.shift.member.user.email, actor.organization.name, actor.organization.timezone, 'SHIFT_CANCELLED').catch(error => console.error('Shift email failed:', error))
    }
    return publicShift(shift.changed)
  } catch (error) {
    if (isOverlapError(error)) throw new ApiError(409, 'SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена.')
    throw error
  }
}

export async function listShiftNotifications(userId: string) {
  const notifications = await prisma.accountNotification.findMany({
    where: { userId, hiddenAt: null, readAt: null, type: { in: ['SHIFT_ASSIGNED', 'SHIFT_CHANGED'] }, shift: { member: { userId, leftAt: null }, status: 'SCHEDULED', scheduledEndAt: { gt: new Date() } }, organization: { deletedAt: null } },
    include: { shift: true, organization: { select: { id: true, name: true, timezone: true } } },
    distinct: ['shiftId'], orderBy: { createdAt: 'desc' }, take: 50,
  })
  const filtered = []
  for (const notification of notifications) {const actor=await getMembership(userId,notification.organization.id);if(notification.shift && hasPermission(actor,'schedule.own',notification.shift.locationId)) filtered.push(notification)}
  return filtered.flatMap(notification => notification.shift ? [{ id: notification.shift.id, organization: notification.organization, scheduledStartAt: notification.shift.scheduledStartAt, scheduledEndAt: notification.shift.scheduledEndAt, createdAt: notification.createdAt }] : [])
}

export async function readShiftNotification(userId: string, shiftId: string) {
  const shift = await prisma.workShift.findFirst({ where: { id: shiftId, member: { userId, leftAt: null }, organization: { deletedAt: null } }, select: { id: true } })
  if (!shift) throw new ApiError(404, 'SHIFT_NOTIFICATION_NOT_FOUND', 'Уведомление о смене не найдено.')
  await prisma.$transaction([
    prisma.workShift.update({ where: { id: shiftId }, data: { assignmentReadAt: new Date() } }),
    prisma.accountNotification.updateMany({ where: { shiftId, userId, type: { in: ['SHIFT_ASSIGNED', 'SHIFT_CHANGED'] }, readAt: null }, data: { readAt: new Date() } }),
  ])
}

export async function getShift(userId: string, organizationId: string, shiftId: string, page = 1, limit = 20) {
  const actor = await getMembership(userId, organizationId)
  if (!hasPermission(actor, 'schedule.history')) {
    const shift = await prisma.workShift.findFirst({ where: { id: shiftId, organizationId, ...locationWhere(organizationId) }, include: shiftInclude })
    if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
    requirePermission(actor, shift.memberId === actor.id ? 'schedule.own' : 'schedule.view')
    return { ...publicShift(shift), adjustments: [], adjustmentPagination: { page: 1, limit, total: 0, pages: 1 } }
  }
  const shift = await prisma.workShift.findFirst({ where: { id: shiftId, organizationId, ...locationWhere(organizationId) }, include: { ...shiftInclude, adjustments: { include: { changedByMember: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit } } })
  if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
  requirePermission(actor, shift.memberId === actor.id ? 'schedule.own' : 'schedule.view')
  const total = shift._count.adjustments
  return { ...publicShift(shift), adjustments: shift.adjustments.map((item) => ({ ...item, changedByName: displayName(item.changedByMember.user) })), adjustmentPagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } }
}

export async function cancelShift(userId: string, organizationId: string, shiftId: string, reason: string) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'schedule.cancel')
  const current = await shiftInOrganization(prisma, organizationId, shiftId)
  if (current.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Смена уже отменена.')
  const shift = await prisma.$transaction(async tx => {
    if (scopedLocationId(organizationId)) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`; await requireLocationManager(tx, userId, organizationId, actor.locationId, 'schedule.cancel') }
    await lockShift(tx, shiftId)
    const fresh = await shiftInOrganization(tx, organizationId, shiftId)
    if (fresh.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Смена уже отменена.')
    return mutatePlannedShift(tx, actor, { current: fresh, reason })
  }, { isolationLevel: 'Serializable' })
  void sendImportantShiftEmail(shift.notification!.id, shift.changed, shift.changed.member.user.email, actor.organization.name, actor.organization.timezone, 'SHIFT_CANCELLED').catch(error => console.error('Shift email failed:', error))
  return publicShift(shift.changed)
}

export async function correctActualTime(userId: string, organizationId: string, shiftId: string, input: ActualInput) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'schedule.actual')
  const current = await shiftInOrganization(prisma, organizationId, shiftId)
  if (current.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Отменённую смену нельзя корректировать.')
  if (current.scheduledEndAt > new Date()) throw new ApiError(409, 'SHIFT_NOT_FINISHED', 'Фактическое время можно указать после окончания смены.')
  const startAt = zonedDateTimeToUtc(input.startDate, input.startTime, actor.organization.timezone)
  const endAt = zonedDateTimeToUtc(input.endDate, input.endTime, actor.organization.timezone)
  validateDuration(startAt, endAt, input.breakMinutes)
  if (endAt > new Date()) throw new ApiError(400, 'ACTUAL_TIME_IN_FUTURE', 'Фактическое окончание не может быть в будущем.')
  return prisma.$transaction(async (tx) => {
    if (scopedLocationId(organizationId)) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`; await requireLocationManager(tx, userId, organizationId, actor.locationId, 'schedule.actual') }
    await lockShift(tx, shiftId)
    const fresh = await shiftInOrganization(tx, organizationId, shiftId)
    if (fresh.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Отменённую смену нельзя корректировать.')
    const previousStartAt = fresh.actualStartAt ?? fresh.scheduledStartAt
    const previousEndAt = fresh.actualEndAt ?? fresh.scheduledEndAt
    const previousBreakMinutes = fresh.actualBreakMinutes ?? fresh.breakMinutes
    await tx.workShiftAdjustment.create({ data: { shiftId, changedByMemberId: actor.id, previousStartAt, previousEndAt, previousBreakMinutes, newStartAt: startAt, newEndAt: endAt, newBreakMinutes: input.breakMinutes, reason: input.reason } })
    const shift = await tx.workShift.update({ where: { id: shiftId }, data: { actualStartAt: startAt, actualEndAt: endAt, actualBreakMinutes: input.breakMinutes }, include: shiftInclude })
    return publicShift(shift)
  }, { isolationLevel: 'Serializable' })
}

// The transaction-level operation is shared by ordinary assignment and draft application.
// Callers validate the complete final set and workload before invoking it.
export async function mutatePlannedShift(tx: Prisma.TransactionClient, actor: Awaited<ReturnType<typeof getMembership>>, change: { current?: WorkShift; input?: ShiftInput; startAt?: Date; endAt?: Date; reason?: string }) {
  const { current, input, startAt, endAt } = change
  let previousAssignment = null
  if (!input) {
    if (!current) throw new ApiError(400, 'SHIFT_REQUIRED', 'Выберите исходную смену.')
    const changed = await tx.workShift.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByMemberId: actor.id, cancellationReason: change.reason ?? 'Отмена в предварительном графике' }, include: shiftInclude })
    await cancelShiftRequests(tx, actor.organizationId, [current.id], actor.id, 'Исходная смена отменена.')
    const notification = await recordShiftNotification(tx, changed, 'SHIFT_CANCELLED', actor.organization.timezone)
    return { changed, notification, previousAssignment }
  }
  if (!startAt || !endAt) throw new ApiError(400, 'SHIFT_RANGE', 'Укажите время смены.')
  validateDuration(startAt, endAt, input.breakMinutes)
  await activeTarget(tx, actor.organizationId, input.memberId, startAt, endAt)
  await assertNoApprovedAbsence(actor.organizationId, input.memberId, startAt, endAt, actor.organization.timezone, tx, input.acknowledgeAbsence)
  const position = input.positionId ? await tx.organizationPosition.findFirst({ where: { id: input.positionId, organizationId: actor.organizationId, isActive: true, members: { some: { memberId: input.memberId } } } }) : null
  if (input.positionId && !position) throw new ApiError(400, 'POSITION_NOT_ASSIGNED', 'Должность не назначена сотруднику или неактивна.')
  const assignmentChanged = !current || current.memberId !== input.memberId || +current.scheduledStartAt !== +startAt || +current.scheduledEndAt !== +endAt || current.positionId !== (input.positionId ?? null)
  const data = { memberId: input.memberId, positionId: position?.id ?? null, positionNameSnapshot: position?.name ?? null, scheduledStartAt: startAt, scheduledEndAt: endAt, breakMinutes: input.breakMinutes, description: input.description, ...(assignmentChanged ? { assignmentReadAt: null } : {}) }
  const changed = current ? await tx.workShift.update({ where: { id: current.id }, data, include: shiftInclude }) : await tx.workShift.create({ data: { ...data, organizationId: actor.organizationId, locationId: actor.locationId, createdByMemberId: actor.id }, include: shiftInclude })
  if (current && assignmentChanged) {
    await cancelShiftRequests(tx, actor.organizationId, [current.id], actor.id, 'Исходная смена изменена. Создайте новую заявку при необходимости.')
    if (current.memberId !== input.memberId) {
      const member = await tx.organizationMember.findUniqueOrThrow({ where: { id: current.memberId }, include: { user: { select: { email: true } } } })
      const shift = { ...current, member }
      previousAssignment = { shift, notification: await recordShiftNotification(tx, shift, 'SHIFT_CANCELLED', actor.organization.timezone) }
    }
  }
  const notification = assignmentChanged ? await recordShiftNotification(tx, changed, !current || current.memberId !== input.memberId ? 'SHIFT_ASSIGNED' : 'SHIFT_CHANGED', actor.organization.timezone) : null
  return { changed, notification, previousAssignment }
}
