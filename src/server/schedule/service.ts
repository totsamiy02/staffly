import type { Prisma, WorkShift } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from '../organizations/permissions.ts'
import { startOfZonedDate, zonedDateTimeToUtc } from './timezone.ts'
import { deliverShiftAssignment } from '../mail.ts'

export type ShiftInput = { memberId: string; startDate: string; startTime: string; endDate: string; endTime: string; breakMinutes: number; description: string | null }
export type ActualInput = Omit<ShiftInput, 'memberId' | 'description'> & { reason: string }

function isOverlapError(error: unknown) {
  try { return JSON.stringify(error).includes('23P01') || JSON.stringify(error).includes('work_shifts_no_overlap') } catch { return false }
}

function displayName(user: { firstName: string | null; lastName: string | null; middleName: string | null; email: string }) {
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email.split('@')[0]
}

function countedMinutes(start: Date, end: Date) {
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

function publicShift(shift: WorkShift & { member: { user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null } }; _count?: { adjustments: number } }) {
  const effectiveStartAt = shift.actualStartAt ?? shift.scheduledStartAt
  const effectiveEndAt = shift.actualEndAt ?? shift.scheduledEndAt
  return {
    id: shift.id,
    memberId: shift.memberId,
    memberName: displayName(shift.member.user),
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

const shiftInclude = { member: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } }, _count: { select: { adjustments: true } } } as const

export async function listSchedule(userId: string, organizationId: string, fromDate: string, toDate: string) {
  const actor = await getMembership(userId, organizationId)
  const from = startOfZonedDate(fromDate, actor.organization.timezone)
  const to = startOfZonedDate(toDate, actor.organization.timezone)
  const shifts = await prisma.workShift.findMany({
    where: { organizationId, scheduledStartAt: { lt: to }, scheduledEndAt: { gt: from } },
    include: shiftInclude,
    orderBy: [{ scheduledStartAt: 'asc' }, { member: { user: { lastName: 'asc' } } }],
  })
  return { timezone: actor.organization.timezone, shifts: shifts.map(publicShift) }
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
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const startAt = zonedDateTimeToUtc(input.startDate, input.startTime, actor.organization.timezone)
  const endAt = zonedDateTimeToUtc(input.endDate, input.endTime, actor.organization.timezone)
  validateDuration(startAt, endAt, input.breakMinutes)
  const target = await activeTarget(prisma, organizationId, input.memberId)
  const conflict = await prisma.workShift.findFirst({ where: { memberId: input.memberId, status: 'SCHEDULED', scheduledStartAt: { lt: endAt }, scheduledEndAt: { gt: startAt } } })
  if (conflict) throw new ApiError(409, 'SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена.')
  try {
    const shift = await prisma.workShift.create({ data: { organizationId, memberId: input.memberId, createdByMemberId: actor.id, scheduledStartAt: startAt, scheduledEndAt: endAt, breakMinutes: input.breakMinutes, description: input.description }, include: shiftInclude })
    if (endAt > new Date()) void deliverShiftAssignment(target.user.email, organizationId, actor.organization.name, startAt, endAt, actor.organization.timezone).catch((error) => console.error('Shift-assignment email failed:', error))
    return publicShift(shift)
  } catch (error) {
    if (isOverlapError(error)) throw new ApiError(409, 'SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена.')
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
  const conflict = await prisma.workShift.findFirst({ where: { id: { not: shiftId }, memberId: input.memberId, status: 'SCHEDULED', scheduledStartAt: { lt: endAt }, scheduledEndAt: { gt: startAt } } })
  if (conflict) throw new ApiError(409, 'SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена.')
  try {
    const assignmentChanged = current.memberId !== input.memberId || current.scheduledStartAt.getTime() !== startAt.getTime() || current.scheduledEndAt.getTime() !== endAt.getTime()
    const shift = await prisma.workShift.update({ where: { id: shiftId }, data: { memberId: input.memberId, scheduledStartAt: startAt, scheduledEndAt: endAt, breakMinutes: input.breakMinutes, description: input.description, ...(assignmentChanged ? { assignmentReadAt: null } : {}) }, include: shiftInclude })
    if (assignmentChanged && endAt > new Date()) void deliverShiftAssignment(target.user.email, organizationId, actor.organization.name, startAt, endAt, actor.organization.timezone).catch((error) => console.error('Shift-assignment email failed:', error))
    return publicShift(shift)
  } catch (error) {
    if (isOverlapError(error)) throw new ApiError(409, 'SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена.')
    throw error
  }
}

export async function listShiftNotifications(userId: string) {
  const shifts = await prisma.workShift.findMany({
    where: { member: { userId, leftAt: null }, organization: { deletedAt: null }, status: 'SCHEDULED', assignmentReadAt: null, scheduledEndAt: { gt: new Date() } },
    include: { organization: { select: { id: true, name: true, timezone: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return shifts.map((shift) => ({ id: shift.id, organization: shift.organization, scheduledStartAt: shift.scheduledStartAt, scheduledEndAt: shift.scheduledEndAt, createdAt: shift.createdAt }))
}

export async function readShiftNotification(userId: string, shiftId: string) {
  const shift = await prisma.workShift.findFirst({ where: { id: shiftId, member: { userId } }, select: { id: true } })
  if (!shift) throw new ApiError(404, 'SHIFT_NOTIFICATION_NOT_FOUND', 'Уведомление о смене не найдено.')
  await prisma.workShift.update({ where: { id: shiftId }, data: { assignmentReadAt: new Date() } })
}

export async function getShift(userId: string, organizationId: string, shiftId: string, page = 1, limit = 20) {
  const actor = await getMembership(userId, organizationId)
  if (actor.role === 'MEMBER') {
    const shift = await prisma.workShift.findFirst({ where: { id: shiftId, organizationId }, include: shiftInclude })
    if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
    return { ...publicShift(shift), adjustments: [], adjustmentPagination: { page: 1, limit, total: 0, pages: 1 } }
  }
  const shift = await prisma.workShift.findFirst({ where: { id: shiftId, organizationId }, include: { ...shiftInclude, adjustments: { include: { changedByMember: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit } } })
  if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
  const total = shift._count.adjustments
  return { ...publicShift(shift), adjustments: shift.adjustments.map((item) => ({ ...item, changedByName: displayName(item.changedByMember.user) })), adjustmentPagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } }
}

export async function cancelShift(userId: string, organizationId: string, shiftId: string, reason: string) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const current = await shiftInOrganization(prisma, organizationId, shiftId)
  if (current.status === 'CANCELLED') throw new ApiError(409, 'SHIFT_CANCELLED', 'Смена уже отменена.')
  const shift = await prisma.workShift.update({ where: { id: shiftId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByMemberId: actor.id, cancellationReason: reason }, include: shiftInclude })
  return publicShift(shift)
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
    const fresh = await shiftInOrganization(tx, organizationId, shiftId)
    const previousStartAt = fresh.actualStartAt ?? fresh.scheduledStartAt
    const previousEndAt = fresh.actualEndAt ?? fresh.scheduledEndAt
    const previousBreakMinutes = fresh.actualBreakMinutes ?? fresh.breakMinutes
    await tx.workShiftAdjustment.create({ data: { shiftId, changedByMemberId: actor.id, previousStartAt, previousEndAt, previousBreakMinutes, newStartAt: startAt, newEndAt: endAt, newBreakMinutes: input.breakMinutes, reason: input.reason } })
    const shift = await tx.workShift.update({ where: { id: shiftId }, data: { actualStartAt: startAt, actualEndAt: endAt, actualBreakMinutes: input.breakMinutes }, include: shiftInclude })
    return publicShift(shift)
  }, { isolationLevel: 'Serializable' })
}
