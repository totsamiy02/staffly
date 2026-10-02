import { locationMemberWhere, scopedLocationId } from '../organizations/location-context.ts'
import { createRequest, listRequestTypes } from '../requests/service.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { z } from 'zod'
import { prisma } from '../db.ts'
import type { Prisma, RequestSystemCode } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from '../organizations/permissions.ts'
import { date } from './schemas.ts'
import { addCalendarDays, startOfZonedDate } from './timezone.ts'

export const absencePeriodBody = z.object({ startDate: date, endDate: date }).refine(value => value.endDate >= value.startDate, 'Окончание не может быть раньше начала.').refine(value => (Date.parse(value.endDate) - Date.parse(value.startDate)) / 86400000 <= 366, 'Период не должен превышать 367 дней.')
export const absenceReportBody = absencePeriodBody.safeExtend({ reason: z.enum(['SICK', 'PERSONAL', 'OTHER']).default('SICK'), comment: z.string().trim().max(500).optional() })
export const absenceEditBody = absencePeriodBody.safeExtend({ updatedAt: z.string().datetime() })
export const absenceCancelBody = z.object({ updatedAt: z.string().datetime(), reason: z.string().trim().min(3).max(500) })
export const absenceListQuery = z.object({ memberId: z.string().uuid().optional(), id: z.string().uuid().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20), todayOnly: z.enum(['true', 'false']).default('false'), history: z.enum(['true', 'false']).default('false') })
export const dateText = (date: Date) => date.toISOString().slice(0, 10)
export const absenceLabels: Partial<Record<RequestSystemCode, string>> = { VACATION: 'Отпуск', DAY_OFF: 'Отгул', SICK: 'Болезнь', SICK_LEAVE: 'Болезнь', ABSENCE: 'Отсутствие' }
const displayName = (user: { lastName: string | null; firstName: string | null; middleName: string | null; email: string }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email.split('@')[0]

export async function assertAbsencePeriod(tx: Prisma.TransactionClient, organizationId: string, memberId: string, startDate: Date, endDate: Date, excludeId?: string) {
  if (!await tx.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null, user: { deletedAt: null } } })) throw new ApiError(409, 'MEMBER_LEFT', 'Сотрудник больше не состоит в организации.')
  const overlap = await tx.employeeAbsence.findFirst({ where: { organizationId, memberId, cancelledAt: null, id: excludeId ? { not: excludeId } : undefined, startDate: { lte: endDate }, endDate: { gte: startDate } } })
  if (overlap) throw new ApiError(409, 'ABSENCE_OVERLAP', `На ${dateText(overlap.startDate)}–${dateText(overlap.endDate)} уже зарегистрировано отсутствие. Сначала измените или отмените его.`)
}
export async function absenceShiftConflicts(tx: Prisma.TransactionClient | typeof prisma, organizationId: string, memberId: string, start: Date, end: Date, timezone: string) {
  return tx.workShift.findMany({ where: { organizationId, memberId, status: 'SCHEDULED', scheduledEndAt: { gt: new Date() }, AND: [{ scheduledStartAt: { lt: startOfZonedDate(addCalendarDays(dateText(end), 1), timezone) } }, { scheduledEndAt: { gt: startOfZonedDate(dateText(start), timezone) } }] }, orderBy: { scheduledStartAt: 'asc' }, select: { id: true, scheduledStartAt: true, scheduledEndAt: true } })
}
function conflictError(error: unknown): never {
  if (error instanceof ApiError) throw error
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') throw new ApiError(409, 'ABSENCE_CONFLICT', 'Отсутствие изменилось одновременно с другим действием. Обновите данные и повторите.')
  throw error
}
export async function listAbsences(userId: string, organizationId: string, options: z.infer<typeof absenceListQuery>) {
  const actor = await getMembership(userId, organizationId)
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: actor.organization.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const today = ['year', 'month', 'day'].map(type => parts.find(item => item.type === type)!.value).join('-')
  const where = { organizationId, member: actor.role === 'MEMBER' ? undefined : locationMemberWhere(organizationId), id: options.id, memberId: actor.role === 'MEMBER' ? actor.id : options.memberId, ...(options.id ? {} : options.todayOnly === 'true' ? { cancelledAt: null, startDate: { lte: new Date(today + 'T00:00:00Z') }, endDate: { gte: new Date(today + 'T00:00:00Z') } } : options.history === 'false' ? { cancelledAt: null, endDate: { gte: new Date(today + 'T00:00:00Z') } } : { OR: [{ cancelledAt: { not: null } }, { endDate: { lt: new Date(today + 'T00:00:00Z') } }] }) }
  const [total, rows] = await Promise.all([prisma.employeeAbsence.count({ where }), prisma.employeeAbsence.findMany({ where, orderBy: [{ startDate: 'desc' }, { id: 'desc' }], skip: (options.page - 1) * options.limit, take: options.limit, include: { member: { include: { user: true } } } })])
  const absences = await Promise.all(rows.map(async item => ({ id: item.id, memberId: item.memberId, memberName: displayName(item.member.user), memberAvatarUrl: mediaUrl(item.member.user.avatarFileId), reason: item.reason, comment: item.comment, type: item.type, startDate: dateText(item.startDate), endDate: dateText(item.endDate), sourceRequestId: item.sourceRequestId, updatedAt: item.updatedAt, cancelledAt: item.cancelledAt, cancellationReason: item.cancellationReason, formerMember: !!item.member.leftAt, conflicts: await absenceShiftConflicts(prisma, organizationId, item.memberId, item.startDate, item.endDate, actor.organization.timezone) })))
  return { absences, pagination: { page: options.page, pages: Math.max(1, Math.ceil(total / options.limit)), total } }
}
export async function notifyAbsence(tx: Prisma.TransactionClient, organizationId: string, memberId: string, absenceId: string, type: 'ABSENCE_REPORTED' | 'ABSENCE_CHANGED' | 'ABSENCE_CANCELLED', startDate: Date, endDate: Date) {
  const absence = await tx.employeeAbsence.findUniqueOrThrow({ where: { id: absenceId }, select: { sourceRequestId: true } })
  const employee = await tx.organizationMember.findUniqueOrThrow({ where: { id: memberId }, include: { user: true } })
  const reviewers = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, OR: [{ role: 'OWNER' }, { role: 'ADMIN' }, { locationMemberships: { some: { role: 'ADMIN', leftAt: null, location: { archivedAt: null, members: { some: { memberId, leftAt: null } } } } } }], user: { deletedAt: null } }, select: { userId: true } })
  const recipients = [...new Set([...reviewers.map(item => item.userId), ...(type !== 'ABSENCE_REPORTED' ? [employee.userId] : [])])]
  if (recipients.length) await tx.accountNotification.createMany({ data: recipients.map(userId => ({ userId, organizationId, absenceId, requestId: absence.sourceRequestId, type, title: type === 'ABSENCE_REPORTED' ? 'Сотрудник сообщил об отсутствии' : type === 'ABSENCE_CHANGED' ? 'Период отсутствия изменён' : 'Отсутствие отменено', message: `${displayName(employee.user)} · ${dateText(startDate)}–${dateText(endDate)}` })) })
}
export async function reportSickness(userId: string, organizationId: string, input: z.input<typeof absenceReportBody>) {
  const parsed = absenceReportBody.parse(input)
  const types = await listRequestTypes(userId, organizationId)
  const type = types.find(item => item.systemCode === 'SICK')!
  const request = await createRequest(userId, organizationId, { requestTypeId: type.id, startDate: parsed.startDate, endDate: parsed.endDate, absenceReason: parsed.reason, comment: parsed.comment })
  return prisma.employeeAbsence.findUniqueOrThrow({ where: { sourceRequestId: request.id } })
}
export async function changeAbsence(userId: string, organizationId: string, absenceId: string, input: z.infer<typeof absenceEditBody> | z.infer<typeof absenceCancelBody>) {
  const actor = await getMembership(userId, organizationId)
  return prisma.$transaction(async tx => {
    const item = await tx.employeeAbsence.findFirst({ where: { id: absenceId, organizationId } })
    if (!item || (actor.role === 'MEMBER' && item.memberId !== actor.id)) throw new ApiError(404, 'ABSENCE_NOT_FOUND', 'Отсутствие не найдено.')
    if (actor.role !== 'OWNER' && item.memberId !== actor.id && scopedLocationId(organizationId) && !await tx.organizationMember.findFirst({ where: { id: item.memberId, ...locationMemberWhere(organizationId) } })) throw new ApiError(404, 'ABSENCE_NOT_FOUND', 'Отсутствие не найдено.')
    const source = item.sourceRequestId ? await tx.organizationRequest.findUnique({ where: { id: item.sourceRequestId } }) : null
    if (actor.role === 'MEMBER' && source && source.systemCodeSnapshot !== 'SICK') requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
    if (item.cancelledAt || item.updatedAt.toISOString() !== input.updatedAt) throw new ApiError(409, 'ABSENCE_CHANGED', 'Отсутствие уже изменено или отменено. Обновите данные.')
    const cancel = 'reason' in input
    const startDate = cancel ? item.startDate : new Date(input.startDate + 'T00:00:00Z'), endDate = cancel ? item.endDate : new Date(input.endDate + 'T00:00:00Z')
    if (!cancel) await assertAbsencePeriod(tx, organizationId, item.memberId, startDate, endDate, item.id)
    const updated = await tx.employeeAbsence.update({ where: { id: item.id }, data: cancel ? { cancelledAt: new Date(), cancelledByMemberId: actor.id, cancellationReason: input.reason, updatedByMemberId: actor.id } : { startDate, endDate, updatedByMemberId: actor.id } })
    if (source?.systemCodeSnapshot === 'SICK') {
      await tx.organizationRequest.update({ where: { id: source.id }, data: cancel ? { status: 'CANCELLED', cancelledAt: new Date(), resolutionComment: input.reason } : { startDate, endDate } })
      await tx.requestEvent.create({ data: { requestId: source.id, actorMemberId: actor.id, type: cancel ? 'CANCELLED' : 'EDITED', comment: cancel ? input.reason : null } })
    }
    await notifyAbsence(tx, organizationId, item.memberId, item.id, cancel ? 'ABSENCE_CANCELLED' : 'ABSENCE_CHANGED', startDate, endDate)
    return updated
  }, { isolationLevel: 'Serializable' }).catch(conflictError)
}
