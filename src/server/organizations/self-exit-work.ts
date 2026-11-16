import { Prisma } from '../../generated/prisma/client.ts'
import type { SelfExitWork } from '../../shared/self-exit.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from './access/permissions.ts'
import { hasPermission, locationsFor, requirePermission } from './access/access.ts'
import { requestReadSql, type Actor } from '../access/request-policy.ts'
import { loadReviewerContext, reviewersFromContext, reviewPermission, type ReviewerContext } from '../requests/reviewers.ts'
import { taskOutcome } from '../attention/policy.ts'
import { eligible } from '../schedule/offer-service.ts'
import { mutatePlannedShift } from '../schedule/service.ts'
import { checkMonthlyWorkload } from '../schedule/workload.ts'
import { locationContext } from './location-context.ts'
import { mediaUrl } from '../storage/image-service.ts'

type DB = Prisma.TransactionClient

export async function exitWorkFor(db: DB, actor: Actor, exitId: string, pointId?: string, reviewerContext?: ReviewerContext): Promise<SelfExitWork | null> {
  const exit = await db.memberSelfExit.findFirst({
    where: { id: exitId, organizationId: actor.organizationId },
    include: { member: { select: { leftAt: true, user: { select: { avatarFileId: true } } } } }
  })
  if (!exit) return null
  const points = locationsFor(actor, 'schedule.view')
  const shifts = await db.workShift.findMany({
    where: {
      organizationId: actor.organizationId,
      selfExitId: exitId,
      status: 'UNASSIGNED',
      locationId: pointId ? points.includes(pointId) || actor.owner ? pointId : { in: [] } : actor.owner ? undefined : { in: points },
    },
    include: { location: true },
    orderBy: [{ scheduledStartAt: 'asc' }, { id: 'asc' }],
  })
  const context = reviewerContext ?? await loadReviewerContext(db, actor.organizationId)
  const readable = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r.id FROM requests r JOIN organization_locations l ON l.id=r.location_id
    WHERE r.organization_id=${actor.organizationId}::uuid AND r.self_exit_id=${exitId}::uuid
      AND l.archived_at IS NULL AND r.status IN ('PENDING','APPROVED')
      ${pointId ? Prisma.sql`AND r.location_id=${pointId}::uuid` : Prisma.empty}
      AND ${requestReadSql(actor, context.roles)}`)
  const requests = readable.length ? await db.organizationRequest.findMany({
    where: { id: { in: readable.map(row => row.id) } },
    include: { location: true },
    orderBy: { createdAt: 'asc' },
  }) : []
  const tasks: SelfExitWork['tasks'] = []
  for (const request of requests) {
    const task = taskOutcome(request.outcome)
    const canAssign = hasPermission(actor, request.status === 'PENDING' ? reviewPermission(request.systemCodeSnapshot) : 'requests.resolve', request.locationId)
    if (!canAssign) continue
    const available = task
      ? context.members.some(member => task.assignees.includes(member.id) && hasPermission(member, 'requests.own', request.locationId))
      : request.status === 'PENDING' && reviewersFromContext(context, request).length > 0
    if (available || (!task && request.status !== 'PENDING')) continue
    tasks.push({
      id: request.id,
      title: task?.text || request.typeNameSnapshot,
      kind: task ? 'TASK' : 'REVIEW',
      locationId: request.locationId,
      locationName: request.location.name,
      deadline: task?.deadline ?? null,
      updatedAt: request.updatedAt.toISOString(),
      canAssign,
    })
  }
  const hasRosterAccess = actor.owner || exit.locationIds.some(id => hasPermission(actor, 'members.view', id))
  if (!shifts.length && !tasks.length && !hasRosterAccess) return null
  return {
    id: exit.id,
    memberName: exit.memberName,
    memberAvatarUrl: exit.member.leftAt ? null : mediaUrl(exit.member.user.avatarFileId),
    createdAt: exit.createdAt.toISOString(),
    tasks,
    shifts: shifts.map(shift => ({
      id: shift.id,
      locationId: shift.locationId,
      locationName: shift.location.name,
      timezone: shift.location.timezone,
      startAt: shift.scheduledStartAt.toISOString(),
      endAt: shift.scheduledEndAt.toISOString(),
      positionName: shift.positionNameSnapshot,
      updatedAt: shift.updatedAt.toISOString(),
      canAssign: shift.scheduledStartAt > new Date() && hasPermission(actor, 'schedule.edit', shift.locationId),
      canCancel: hasPermission(actor, 'schedule.cancel', shift.locationId),
    })),
  }
}

export async function getExitWork(userId: string, organizationId: string, exitId: string) {
  return prisma.$transaction(async db => {
    const actor = await getMembership(userId, organizationId, db)
    const result = await exitWorkFor(db, actor, exitId)
    if (!result) throw new ApiError(404, 'SELF_EXIT_NOT_FOUND', 'Рабочие назначения недоступны.')
    return result
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 })
}

export async function* exitAttention(db: DB, actor: Actor, pointId?: string, reviewerContext?: ReviewerContext) {
  const context = reviewerContext ?? await loadReviewerContext(db, actor.organizationId)
  let cursor: string | undefined
  for (;;) {
    const exits = await db.memberSelfExit.findMany({
      where: {
        organizationId: actor.organizationId,
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          { shifts: { some: { status: 'UNASSIGNED' } } },
          {
            requests: {
              some: { OR: [{ status: 'PENDING' }, { status: 'APPROVED', outcome: { path: ['status'], equals: 'OPEN' } }] }
            }
          },
        ]
      },
      orderBy: { id: 'asc' },
      take: 100,
    })
    for (const exit of exits) {
      const work = await exitWorkFor(db, actor, exit.id, pointId, context)
      if (work && (work.tasks.length || work.shifts.some(shift => shift.canAssign || shift.canCancel))) yield work
    }
    if (exits.length < 100) return
    cursor = exits.at(-1)!.id
  }
}

export async function exitCandidates(userId: string, organizationId: string, exitId: string, resourceId: string, kind: 'shift' | 'task', search: string, page: number) {
  return prisma.$transaction(async db => {
    const actor = await getMembership(userId, organizationId, db)
    const work = await exitWorkFor(db, actor, exitId)
    const resource = kind === 'shift' ? work?.shifts.find(s => s.id === resourceId) : work?.tasks.find(t => t.id === resourceId && t.kind === 'TASK')
    if (!resource?.canAssign) throw new ApiError(404, 'ASSIGNMENT_NOT_FOUND', 'Назначение недоступно.')
    const context = kind === 'task' ? await loadReviewerContext(db, organizationId) : null
    const shift = kind === 'shift' ? await db.workShift.findUniqueOrThrow({ where: { id: resourceId } }) : null
    const people = await db.organizationMember.findMany({
      where: {
        organizationId,
        leftAt: null,
        ...(shift ? {
          OR: [
            { role: 'OWNER' },
            { locationMemberships: { some: { locationId: shift.locationId, leftAt: null } } },
            {
              locationTransfers: {
                some: {
                  toLocationId: shift.locationId,
                  temporary: true,
                  revokedAt: null,
                  startAt: { lte: shift.scheduledStartAt },
                  endAt: { gte: shift.scheduledEndAt },
                }
              }
            },
          ]
        } : {
          id: {
            in: context!.members.filter(member => hasPermission(member, 'requests.own', resource.locationId)).map(member => member.id)
          }
        }),
        user: {
          deletedAt: null,
          ...(search ? {
            OR: ['firstName', 'lastName', 'middleName'].map(field => ({ [field]: { contains: search, mode: 'insensitive' as const } })),
          } : {})
        }
      },
      include: { user: true },
      orderBy: { id: 'asc' },
      skip: (page - 1) * 20,
      take: 21,
    })
    const candidates = []
    for (const person of people.slice(0, 20)) {
      let reason: string | null = null
      try {
        if (shift) await eligible(db, shift, person.id, [shift.id])
        else if (!context?.members.some(m => m.id === person.id && hasPermission(m, 'requests.own', resource.locationId))) {
          reason = 'Нет доступа к задачам в этой точке.'
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        reason = error.message
      }
      candidates.push({
        id: person.id,
        name: [person.user.lastName, person.user.firstName, person.user.middleName].filter(Boolean).join(' ') || 'Сотрудник',
        avatarUrl: mediaUrl(person.user.avatarFileId),
        reason
      })
    }
    return { candidates, hasMore: people.length > 20 }
  }, { timeout: 15000 })
}

export async function resolveExitShift(userId: string, organizationId: string, exitId: string, shiftId: string, input: {
  updatedAt: string; memberId?: string; acknowledgeWorkload: boolean; reason: string
}) {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    const actor = await getMembership(userId, organizationId, db)
    const shift = await db.workShift.findFirst({
      where: { id: shiftId, organizationId, selfExitId: exitId, status: 'UNASSIGNED' },
      include: { location: true }
    })
    if (!shift) throw new ApiError(409, 'ASSIGNMENT_CHANGED', 'Смена уже обработана. Обновите список.')
    requirePermission(actor, input.memberId ? 'schedule.edit' : 'schedule.cancel', shift.locationId)
    if (shift.updatedAt.toISOString() !== input.updatedAt) throw new ApiError(409, 'ASSIGNMENT_CHANGED', 'Смена изменилась. Обновите список.')
    return locationContext.run({ organizationId, locationId: shift.locationId }, async () => {
      const scopedActor = await getMembership(userId, organizationId, db)
      if (!input.memberId) {
        if (input.reason.length < 3) throw new ApiError(400, 'REASON_REQUIRED', 'Укажите причину отмены смены.')
        return mutatePlannedShift(db, scopedActor, { current: shift, reason: input.reason })
      }
      if (shift.scheduledStartAt <= new Date()) throw new ApiError(409, 'SHIFT_STARTED', 'Смена уже началась. Проверьте фактическую работу перед изменением.')
      await eligible(db, shift, input.memberId, [shiftId])
      await checkMonthlyWorkload(db, organizationId, input.memberId, shift.location.timezone, shift.location.monthlyWorkMinutes,
        [{ start: shift.scheduledStartAt, end: shift.scheduledEndAt }], [shiftId], input.acknowledgeWorkload)
      await db.workShiftAdjustment.create({
        data: {
          shiftId,
          changedByMemberId: actor.id,
          kind: 'TRANSFER',
          previousStartAt: shift.scheduledStartAt,
          previousEndAt: shift.scheduledEndAt,
          previousBreakMinutes: shift.breakMinutes,
          newStartAt: shift.scheduledStartAt,
          newEndAt: shift.scheduledEndAt,
          newBreakMinutes: shift.breakMinutes,
          reason: 'Назначена замена после выхода сотрудника',
          assignmentChange: {
            previousMemberId: shift.memberId,
            newMemberId: input.memberId,
            initiatorMemberId: actor.id,
            selfExitId: exitId
          },
        }
      })
      await mutatePlannedShift(db, scopedActor, {
        current: shift,
        restoreAssignment: true,
        startAt: shift.scheduledStartAt,
        endAt: shift.scheduledEndAt,
        input: {
          memberId: input.memberId,
          startDate: '',
          startTime: '',
          endDate: '',
          endTime: '',
          breakMinutes: shift.breakMinutes,
          positionId: shift.positionId,
          description: shift.description
        },
      })
    })
  }, { isolationLevel: 'ReadCommitted', timeout: 15000 })
}

export async function assignExitTask(userId: string, organizationId: string, exitId: string, requestId: string, input: { memberId: string; updatedAt: string }) {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    await db.$queryRaw`SELECT id FROM requests WHERE id=${requestId}::uuid AND organization_id=${organizationId}::uuid FOR UPDATE`
    const actor = await getMembership(userId, organizationId, db)
    const work = await exitWorkFor(db, actor, exitId)
    if (!work?.tasks.some(task => task.id === requestId && task.kind === 'TASK' && task.canAssign)) {
      throw new ApiError(409, 'ASSIGNMENT_CHANGED', 'Задача уже обработана или недоступна.')
    }
    const current = await db.organizationRequest.findUniqueOrThrow({ where: { id: requestId } })
    if (current.updatedAt.toISOString() !== input.updatedAt) throw new ApiError(409, 'REQUEST_CHANGED', 'Задача изменилась. Обновите список.')
    const context = await loadReviewerContext(db, organizationId)
    if (!context.members.some(member => member.id === input.memberId && hasPermission(member, 'requests.own', current.locationId))) {
      throw new ApiError(409, 'ASSIGNEE_UNAVAILABLE', 'Исполнитель больше недоступен в этой точке.')
    }
    const task = taskOutcome(current.outcome)!
    await db.organizationRequest.update({ where: { id: requestId }, data: { selfExitId: null, outcome: { ...task, assignees: [input.memberId] } } })
    await db.requestEvent.create({
      data: {
        requestId,
        actorMemberId: actor.id,
        type: 'CHANGED',
        comment: 'Задача передана новому исполнителю после выхода сотрудника.',
        changes: { selfExitId: exitId, previousAssignees: task.assignees, memberId: input.memberId }
      }
    })
    const target = context.members.find(member => member.id === input.memberId)!
    await db.accountNotification.create({
      data: {
        organizationId,
        userId: target.userId,
        requestId,
        type: 'REQUEST_APPROVED',
        title: 'Вам передана задача',
        message: current.typeNameSnapshot
      }
    })
  }, { timeout: 15000 })
}
