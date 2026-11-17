import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { getMembership } from '../../organizations/access/permissions.ts'
import { requirePermission } from '../../organizations/access/access.ts'
import { locationContext } from '../../organizations/location-context.ts'
import { requirePlanFeature } from '../../subscriptions/access.ts'
import { eligible } from '../offer-service.ts'
import { checkMonthlyWorkload } from '../workload.ts'
import { mutatePlannedShift } from '../service.ts'
import { mediaUrl } from '../../storage/image-service.ts'

type DB = Prisma.TransactionClient
const nameOf = (user: { firstName: string | null; lastName: string | null; middleName: string | null }) =>
  [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || 'Сотрудник'

async function sourceFor(db: DB, userId: string, organizationId: string, shiftId: string) {
  const actor = await getMembership(userId, organizationId, db)
  const shift = await db.workShift.findFirst({
    where: { id: shiftId, organizationId, location: { archivedAt: null } },
    include: { location: true, member: { include: { user: true } } },
  })
  if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена недоступна.')
  requirePermission(actor, 'schedule.edit', shift.locationId)
  await requirePlanFeature(organizationId, 'availability', db)
  if (shift.status !== 'SCHEDULED' || shift.scheduledStartAt <= new Date() || shift.actualStartAt || shift.actualEndAt || shift.actualBreakMinutes !== null || shift.attendance !== 'UNCONFIRMED') {
    throw new ApiError(409, 'SHIFT_CHANGED', 'Подбор замены доступен для будущей смены без фактических отметок.')
  }
  if (await db.shiftOfferReservation.count({ where: { shiftId } })) {
    throw new ApiError(409, 'SHIFT_HAS_OFFER', 'Смена участвует в передаче или обмене. Сначала завершите или отмените предложение.')
  }
  return { actor, shift }
}

export async function replacementCandidates(userId: string, organizationId: string, shiftId: string, search: string, page: number) {
  return prisma.$transaction(async db => {
    const { shift } = await sourceFor(db, userId, organizationId, shiftId)
    const terms = search.trim().split(/\s+/).filter(Boolean)
    const people = await db.organizationMember.findMany({
      where: {
        organizationId, leftAt: null, id: { not: shift.memberId }, user: { deletedAt: null },
        ...(terms.length ? { AND: terms.map(term => ({ user: {
          OR: ['firstName', 'lastName', 'middleName'].map(field => ({ [field]: { contains: term, mode: 'insensitive' as const } })),
        } })) } : {}),
        OR: [
          { role: 'OWNER' },
          { locationMemberships: { some: { locationId: shift.locationId, leftAt: null } } },
          { locationTransfers: { some: { toLocationId: shift.locationId, temporary: true, revokedAt: null, startAt: { lte: shift.scheduledStartAt }, endAt: { gte: shift.scheduledEndAt } } } },
        ],
      },
      include: { user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true } } },
      orderBy: { id: 'asc' }, take: 1001,
    })
    if (people.length > 1000) throw new ApiError(400, 'CANDIDATES_LIMIT', 'Слишком много сотрудников. Уточните поиск.')
    const candidates = []
    for (const person of people) {
      let reason: string | null = null
      let workloadWarning: string | null = null
      try {
        await eligible(db, shift, person.id, [shiftId])
        try {
          await locationContext.run({ organizationId, locationId: shift.locationId }, () =>
            checkMonthlyWorkload(db, organizationId, person.id, shift.location.timezone, shift.location.monthlyWorkMinutes,
              [{ start: shift.scheduledStartAt, end: shift.scheduledEndAt }], [shiftId], false))
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'WORKLOAD_WARNING') throw error
          workloadWarning = error.message
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        reason = error.message
      }
      candidates.push({ id: person.id, name: nameOf(person.user), avatarUrl: mediaUrl(person.user.avatarFileId), reason, workloadWarning })
    }
    candidates.sort((a, b) => Number(!!a.reason) - Number(!!b.reason) || a.name.localeCompare(b.name, 'ru') || a.id.localeCompare(b.id))
    return {
      shift: {
        id: shift.id, updatedAt: shift.updatedAt.toISOString(), memberId: shift.memberId, memberName: nameOf(shift.member.user),
        start: shift.scheduledStartAt.toISOString(), end: shift.scheduledEndAt.toISOString(),
        timezone: shift.location.timezone, locationId: shift.locationId, locationName: shift.location.name, positionName: shift.positionNameSnapshot,
      },
      candidates: candidates.slice((page - 1) * 20, page * 20),
      pagination: { page, pages: Math.max(1, Math.ceil(candidates.length / 20)), total: candidates.length, available: candidates.filter(person => !person.reason).length },
    }
  }, { isolationLevel: 'RepeatableRead', timeout: 20000 })
}

export async function assignReplacement(userId: string, organizationId: string, shiftId: string, input: {
  memberId: string; updatedAt: string; acknowledgeWorkload: boolean
}) {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    const { actor, shift } = await sourceFor(db, userId, organizationId, shiftId)
    if (shift.updatedAt.toISOString() !== input.updatedAt || shift.memberId === input.memberId) {
      throw new ApiError(409, 'SHIFT_CHANGED', 'Смена уже изменена. Обновите список.')
    }
    await eligible(db, shift, input.memberId, [shift.id])
    return locationContext.run({ organizationId, locationId: shift.locationId }, async () => {
      await checkMonthlyWorkload(db, organizationId, input.memberId, shift.location.timezone, shift.location.monthlyWorkMinutes,
        [{ start: shift.scheduledStartAt, end: shift.scheduledEndAt }], [shiftId], input.acknowledgeWorkload)
      const scoped = await getMembership(userId, organizationId, db)
      await db.workShiftAdjustment.create({ data: {
        shiftId, changedByMemberId: actor.id, kind: 'TRANSFER',
        previousStartAt: shift.scheduledStartAt, previousEndAt: shift.scheduledEndAt, previousBreakMinutes: shift.breakMinutes,
        newStartAt: shift.scheduledStartAt, newEndAt: shift.scheduledEndAt, newBreakMinutes: shift.breakMinutes,
        reason: 'Подобрана замена с учётом доступности',
        assignmentChange: { previousMemberId: shift.memberId, newMemberId: input.memberId, initiatorMemberId: actor.id },
      } })
      await mutatePlannedShift(db, scoped, {
        current: shift, startAt: shift.scheduledStartAt, endAt: shift.scheduledEndAt,
        input: { memberId: input.memberId, startDate: '', endDate: '', startTime: '', endTime: '', positionId: shift.positionId, breakMinutes: shift.breakMinutes, description: shift.description },
      })
    })
  }, { isolationLevel: 'ReadCommitted', timeout: 20000 })
}
