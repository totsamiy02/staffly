import { mediaUrl } from '../storage/image-service.ts'
import { absenceLabels } from './absence-service.ts'
import { checkMonthlyWorkload } from './workload.ts'
import { cancelShiftRequests, lockShift } from '../requests/shift-conflicts.ts'
import type { Prisma, WorkShift } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from '../organizations/permissions.ts'
import { addCalendarDays, startOfZonedDate, zonedDateTimeToUtc } from './timezone.ts'
import { recordShiftNotification, sendImportantShiftEmail } from '../organizations/notification-service.ts'

const dateText = (value: Date) => value.toISOString().slice(0, 10)

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

function validateDuration(startAt: Date, endAt: Date, breakMinutes: number) {
  if (endAt <= startAt) throw new ApiError(400, 'INVALID_SHIFT_RANGE', 'Окончание смены должно быть позже начала.')
  const durationMinutes = Math.floor((endAt.getTime() - startAt.getTime()) / 60_000)
  if (breakMinutes >= durationMinutes) throw new ApiError(400, 'INVALID_SHIFT_BREAK', 'Перерыв должен быть короче смены.')
}

async function activeTarget(tx: Prisma.TransactionClient | typeof prisma, organizationId: string, memberId: string) {
  const member = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null, user: { deletedAt: null } }, include: { user: { select: { email: true } } } })
  if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Активный сотрудник организации не найден.')
  return member
}

async function shiftInOrganization(tx: Prisma.TransactionClient | typeof prisma, organizationId: string, shiftId: string) {
  const shift = await tx.workShift.findFirst({ where: { id: shiftId, organizationId } })
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

function publicShift(shift: WorkShift & { member: { user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null; avatarFileId: string | null } }; _count?: { adjustments: number } }) {
  const effectiveStartAt = shift.actualStartAt ?? shift.scheduledStartAt
  const effectiveEndAt = shift.actualEndAt ?? shift.scheduledEndAt
  return {
    id: shift.id,
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

const shiftInclude = { member: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } }, _count: { select: { adjustments: true } } } as const

export async function listSchedule(userId: string, organizationId: string, fromDate: string, toDate: string, mode?: 'current' | 'history') {
  const actor = await getMembership(userId, organizationId)
  const from = startOfZonedDate(fromDate, actor.organization.timezone)
  const to = startOfZonedDate(toDate, actor.organization.timezone)
  if (mode === 'history') requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const shifts = await prisma.workShift.findMany({
    where: { organizationId, status: mode === 'history' ? 'CANCELLED' : 'SCHEDULED', scheduledStartAt: { lt: to }, scheduledEndAt: { gt: from } },
    include: shiftInclude,
    orderBy: [{ scheduledStartAt: 'asc' }, { member: { user: { lastName: 'asc' } } }],
  })
  const absences = await prisma.employeeAbsence.findMany({ where: { organizationId, cancelledAt: null, startDate: { lt: new Date(`${toDate}T00:00:00.000Z`) }, endDate: { gte: new Date(`${fromDate}T00:00:00.000Z`) } }, include: { member: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } } }, orderBy: { startDate: 'asc' } })
  return { timezone: actor.organization.timezone, shifts: shifts.map(publicShift), absences: (mode === 'history' ? [] : absences).map((item) => ({ id: item.id, memberId: item.memberId, memberName: displayName(item.member.user), memberAvatarUrl: mediaUrl(item.member.user.avatarFileId), reason: actor.role === 'MEMBER' && item.memberId !== actor.id ? null : item.reason, type: actor.role === 'MEMBER' && item.memberId !== actor.id ? 'ABSENCE' as const : item.type, startDate: dateText(item.startDate), endDate: dateText(item.endDate) })) }
}

export async function listMyUpcomingShifts(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  const shifts = await prisma.workShift.findMany({
    where: { organizationId, memberId: actor.id, status: 'SCHEDULED', scheduledEndAt: { gt: new Date() } },
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
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  if (!inputs.length || inputs.length > 62) throw new ApiError(400, 'BATCH_SIZE', 'Выберите от 1 до 62 смен.')
  const prepared = inputs.map(input => {
    const start = zonedDateTimeToUtc(input.startDate, input.startTime, actor.organization.timezone)
    const end = zonedDateTimeToUtc(input.endDate, input.endTime, actor.organization.timezone)
    validateDuration(start, end, input.breakMinutes)
    return { input, start, end }
  })
  try {
    const result = await prisma.$transaction(async tx => {
      const records = []
      for (const memberId of [...new Set(inputs.map(input => input.memberId))].sort()) {
        await activeTarget(tx, organizationId, memberId)
        await checkMonthlyWorkload(tx, organizationId, memberId, actor.organization.timezone, actor.organization.monthlyWorkMinutes, prepared.filter(item => item.input.memberId === memberId), [], acknowledgeWorkload)
      }
      for (const { input, start, end } of prepared) {
        try {
          await assertNoApprovedAbsence(organizationId, input.memberId, start, end, actor.organization.timezone, tx, input.acknowledgeAbsence)
          if (await tx.workShift.findFirst({ where: { organizationId, memberId: input.memberId, status: 'SCHEDULED', scheduledStartAt: { lt: end }, scheduledEndAt: { gt: start } } })) throw new ApiError(409, 'SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена.')
          const position = input.positionId ? await tx.organizationPosition.findFirst({ where: { id: input.positionId, organizationId, isActive: true, members: { some: { memberId: input.memberId } } } }) : null
          if (input.positionId && !position) throw new ApiError(400, 'POSITION_NOT_ASSIGNED', 'Должность не назначена сотруднику или неактивна.')
          const created = await tx.workShift.create({ data: { organizationId, memberId: input.memberId, createdByMemberId: actor.id, scheduledStartAt: start, scheduledEndAt: end, breakMinutes: input.breakMinutes, description: input.description, positionId: position?.id, positionNameSnapshot: position?.name }, include: shiftInclude })
          const notification = await recordShiftNotification(tx, created, 'SHIFT_ASSIGNED', actor.organization.timezone)
          records.push({ created, notification })
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
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const current = await shiftInOrganization(prisma, organizationId, shiftId)
  if (current.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Отменённую смену нельзя изменить.')
  if (current.scheduledEndAt <= new Date()) throw new ApiError(409, 'SHIFT_ALREADY_FINISHED', 'Для завершённой смены измените фактическое время.')
  const target = await activeTarget(prisma, organizationId, input.memberId)
  const startAt = zonedDateTimeToUtc(input.startDate, input.startTime, actor.organization.timezone)
  const endAt = zonedDateTimeToUtc(input.endDate, input.endTime, actor.organization.timezone)
  validateDuration(startAt, endAt, input.breakMinutes)
  await assertNoApprovedAbsence(organizationId, input.memberId, startAt, endAt, actor.organization.timezone, prisma, input.acknowledgeAbsence)
  const conflict = await prisma.workShift.findFirst({ where: { id: { not: shiftId }, memberId: input.memberId, status: 'SCHEDULED', scheduledStartAt: { lt: endAt }, scheduledEndAt: { gt: startAt } } })
  if (conflict) throw new ApiError(409, 'SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена.')
  try {
    const assignmentChanged = current.memberId !== input.memberId || current.scheduledStartAt.getTime() !== startAt.getTime() || current.scheduledEndAt.getTime() !== endAt.getTime()
    const shift = await prisma.$transaction(async tx => {
      await lockShift(tx, shiftId)
      const fresh = await shiftInOrganization(tx, organizationId, shiftId)
      if (fresh.updatedAt.getTime() !== current.updatedAt.getTime() || fresh.status !== 'SCHEDULED') throw new ApiError(409, 'SHIFT_CHANGED', 'Смена уже изменилась. Откройте её заново.')
      await activeTarget(tx, organizationId, input.memberId)
      await assertNoApprovedAbsence(organizationId, input.memberId, startAt, endAt, actor.organization.timezone, tx, input.acknowledgeAbsence)
      await checkMonthlyWorkload(tx, organizationId, input.memberId, actor.organization.timezone, actor.organization.monthlyWorkMinutes, [{ start: startAt, end: endAt }], [shiftId], input.acknowledgeWorkload)
      const position = input.positionId ? await tx.organizationPosition.findFirst({ where: { id: input.positionId, organizationId, isActive: true, members: { some: { memberId: input.memberId } } } }) : null
      if (input.positionId && !position) throw new ApiError(400, 'POSITION_NOT_ASSIGNED', 'Выберите назначенную сотруднику должность.')
      const changed = await tx.workShift.update({ where: { id: shiftId }, data: { positionId: position?.id ?? null, positionNameSnapshot: position?.name ?? null, memberId: input.memberId, scheduledStartAt: startAt, scheduledEndAt: endAt, breakMinutes: input.breakMinutes, description: input.description, ...(assignmentChanged ? { assignmentReadAt: null } : {}) }, include: shiftInclude })
      let notification = null
      let previousAssignment = null
      if (assignmentChanged) {
        await cancelShiftRequests(tx, organizationId, [shiftId], actor.id, 'Исходная смена изменена. Создайте новую заявку при необходимости.')
        if (fresh.memberId !== changed.memberId) {
          const previousMember = await tx.organizationMember.findUniqueOrThrow({ where: { id: fresh.memberId }, include: { user: { select: { email: true } } } })
          const previousShift = { ...fresh, member: previousMember }
          const previousNotification = await recordShiftNotification(tx, previousShift, 'SHIFT_CANCELLED', actor.organization.timezone)
          previousAssignment = { shift: previousShift, notification: previousNotification }
        }
        notification = await recordShiftNotification(tx, changed, fresh.memberId !== changed.memberId ? 'SHIFT_ASSIGNED' : 'SHIFT_CHANGED', actor.organization.timezone)
      }
      return { changed, notification, previousAssignment }
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
  return notifications.flatMap(notification => notification.shift ? [{ id: notification.shift.id, organization: notification.organization, scheduledStartAt: notification.shift.scheduledStartAt, scheduledEndAt: notification.shift.scheduledEndAt, createdAt: notification.createdAt }] : [])
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
  if (actor.role === 'MEMBER') {
    const shift = await prisma.workShift.findFirst({ where: { id: shiftId, organizationId }, include: shiftInclude })
    if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
    return { ...publicShift(shift), adjustments: [], adjustmentPagination: { page: 1, limit, total: 0, pages: 1 } }
  }
  const shift = await prisma.workShift.findFirst({ where: { id: shiftId, organizationId }, include: { ...shiftInclude, adjustments: { include: { changedByMember: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit } } })
  if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
  const total = shift._count.adjustments
  return { ...publicShift(shift), adjustments: shift.adjustments.map((item) => ({ ...item, changedByName: displayName(item.changedByMember.user) })), adjustmentPagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } }
}

export async function cancelShift(userId: string, organizationId: string, shiftId: string, reason: string) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const current = await shiftInOrganization(prisma, organizationId, shiftId)
  if (current.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Смена уже отменена.')
  const shift = await prisma.$transaction(async tx => {
    await lockShift(tx, shiftId)
    const fresh = await shiftInOrganization(tx, organizationId, shiftId)
    if (fresh.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Смена уже отменена.')
    const changed = await tx.workShift.update({ where: { id: shiftId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByMemberId: actor.id, cancellationReason: reason }, include: shiftInclude })
    await cancelShiftRequests(tx, organizationId, [shiftId], actor.id, 'Исходная смена отменена.')
    const notification = await recordShiftNotification(tx, changed, 'SHIFT_CANCELLED', actor.organization.timezone)
    return { changed, notification }
  }, { isolationLevel: 'Serializable' })
  void sendImportantShiftEmail(shift.notification.id, shift.changed, shift.changed.member.user.email, actor.organization.name, actor.organization.timezone, 'SHIFT_CANCELLED').catch(error => console.error('Shift email failed:', error))
  return publicShift(shift.changed)
}

export async function correctActualTime(userId: string, organizationId: string, shiftId: string, input: ActualInput) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const current = await shiftInOrganization(prisma, organizationId, shiftId)
  if (current.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Отменённую смену нельзя корректировать.')
  if (current.scheduledEndAt > new Date()) throw new ApiError(409, 'SHIFT_NOT_FINISHED', 'Фактическое время можно указать после окончания смены.')
  const startAt = zonedDateTimeToUtc(input.startDate, input.startTime, actor.organization.timezone)
  const endAt = zonedDateTimeToUtc(input.endDate, input.endTime, actor.organization.timezone)
  validateDuration(startAt, endAt, input.breakMinutes)
  if (endAt > new Date()) throw new ApiError(400, 'ACTUAL_TIME_IN_FUTURE', 'Фактическое окончание не может быть в будущем.')
  return prisma.$transaction(async (tx) => {
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
