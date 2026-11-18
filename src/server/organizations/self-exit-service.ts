import type { Prisma } from '../../generated/prisma/client.ts'
import type { SelfExitPreview } from '../../shared/self-exit.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { revokeMemberAccess } from './access/member-lifecycle.ts'
import { getMembership } from './access/permissions.ts'
import { loadPermissionMembers } from './access/access.ts'
import { loadReviewerContext, reviewersFromContext } from '../requests/reviewers.ts'
import { requestActions } from '../attention/sources.ts'
import { taskOutcome } from '../attention/policy.ts'
import { closeOffer } from '../schedule/offer-service.ts'
import { cancelShiftRequests } from '../requests/shift-conflicts.ts'
import { recordSecurityEvent } from '../security/journal.ts'
import { timesheetMutationContext } from '../schedule/timesheets/mutation-context.ts'
import { exitWorkFor } from './self-exit-work.ts'
import { detachOpenTasks } from '../requests/task-assignment.ts'

type DB = Prisma.TransactionClient

async function ownMembership(db: DB, userId: string, organizationId: string) {
  // Leaving is independent of a selected point, role permissions, plan or suspension.
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: {
      organization: true,
      user: true,
      employmentPeriods: { where: { endedAt: null }, take: 1 },
      locationMemberships: { where: { leftAt: null } },
    },
  })
  if (!member || member.organization.deletedAt || member.user.deletedAt) {
    throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
  }
  return member
}

async function assignments(db: DB, organizationId: string, memberId: string, now: Date) {
  const shifts = await db.workShift.findMany({
    where: {
      organizationId,
      memberId,
      status: 'SCHEDULED',
      scheduledStartAt: { gt: now },
      actualStartAt: null,
      actualEndAt: null,
      actualBreakMinutes: null,
      attendance: 'UNCONFIRMED',
      replacementCutoffAt: null,
    },
    select: { id: true, locationId: true },
    orderBy: { id: 'asc' },
  })
  const context = await loadReviewerContext(db, organizationId)
  const tasks: string[] = []
  const reviews: string[] = []
  const locations = new Set(shifts.map(shift => shift.locationId))
  for await (const request of requestActions(db, organizationId)) {
    const task = taskOutcome(request.outcome)
    if (task?.assignees.includes(memberId)) {
      tasks.push(request.id)
      locations.add(request.locationId)
    }
    else if (request.status === 'PENDING' && reviewersFromContext(context, request).some(member => member.id === memberId)) {
      reviews.push(request.id)
      locations.add(request.locationId)
    }
  }
  return { shifts, tasks, reviews, locations: [...locations] }
}

export async function previewSelfExit(userId: string, organizationId: string): Promise<SelfExitPreview> {
  return prisma.$transaction(async db => {
    const member = await ownMembership(db, userId, organizationId)
    if (member.leftAt) throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Вы уже покинули организацию.')
    const period = member.employmentPeriods[0]
    if (!period) throw new ApiError(409, 'MEMBERSHIP_CHANGED', 'Период участия изменился. Обновите список организаций.')
    const remaining = await assignments(db, organizationId, member.id, new Date())
    return {
      organization: { id: organizationId, name: member.organization.name, logoUrl: mediaUrl(member.organization.logoFileId) },
      employmentPeriodId: period.id,
      owner: member.role === 'OWNER',
      locationCount: member.locationMemberships.length,
      shifts: remaining.shifts.length,
      tasks: remaining.tasks.length,
      reviews: remaining.reviews.length,
    }
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 })
}

export async function leaveOrganization(userId: string, organizationId: string, employmentPeriodId: string) {
  return timesheetMutationContext.run({ userId, reason: 'Самостоятельный выход сотрудника из организации' }, () =>
    prisma.$transaction(async db => {
      await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
      const member = await ownMembership(db, userId, organizationId)
      const existing = await db.memberSelfExit.findUnique({ where: { employmentPeriodId } })
      if (existing?.organizationId === organizationId && existing.memberId === member.id && member.leftAt) return { id: existing.id }
      if (member.leftAt || member.employmentPeriods[0]?.id !== employmentPeriodId) {
        throw new ApiError(409, 'MEMBERSHIP_CHANGED', 'Период участия изменился. Откройте окно выхода заново.')
      }
      if (member.role === 'OWNER') {
        throw new ApiError(409, 'OWNER_MUST_TRANSFER', 'Сначала передайте владение другому сотруднику.')
      }
      const now = new Date()
      const remaining = await assignments(db, organizationId, member.id, now)
      const memberName = [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || 'Сотрудник'
      const exit = await db.memberSelfExit.create({
        data: {
          organizationId,
          memberId: member.id,
          employmentPeriodId,
          memberName,
          locationIds: [...new Set([...remaining.locations, ...member.locationMemberships.map(point => point.locationId)])],
          requestIds: [...remaining.tasks, ...remaining.reviews],
          createdAt: now,
        }
      })
      await db.$queryRaw`SELECT set_config('staffly.self_exit_id',${exit.id},true)`
      const offers = await db.shiftOffer.findMany({
        where: {
          organizationId,
          status: { in: ['PENDING', 'AWAITING_APPROVAL'] },
          OR: [{ initiatorMemberId: member.id }, { recipientMemberId: member.id }, { acceptedByMemberId: member.id }],
        }
      })
      for (const offer of offers) await closeOffer(db, offer, 'CANCELLED', 'Участник покинул организацию.')
      await revokeMemberAccess(db, organizationId, member.id, now)
      await db.organizationMember.update({ where: { id: member.id }, data: { leftAt: now } })
      await db.documentAcknowledgement.updateMany({
        where: { memberId: member.id, acknowledgedAt: null, cancelledAt: null, document: { organizationId } },
        data: { cancelledAt: now },
      })
      if (remaining.shifts.length) {
        const ids = remaining.shifts.map(shift => shift.id)
        await db.workShift.updateMany({ where: { id: { in: ids } }, data: { status: 'UNASSIGNED', selfExitId: exit.id } })
        await cancelShiftRequests(db, organizationId, ids, member.id, 'Сотрудник покинул организацию. Исходное назначение недоступно.')
      }
      await detachOpenTasks(db, {
        organizationId, memberId: member.id, actorMemberId: member.id,
        comment: 'Исполнитель покинул организацию. Назначение снято; результат задачи сохранён.',
        selfExit: { id: exit.id, requestIds: remaining.tasks },
      })
      if (remaining.reviews.length) await db.organizationRequest.updateMany({
        where: { id: { in: remaining.reviews }, status: 'PENDING' }, data: { selfExitId: exit.id },
      })
      await db.accessAudit.create({
        data: {
          organizationId,
          actorMemberId: member.id,
          action: 'MEMBER_LEFT_SELF',
          details: {
            memberId: member.id,
            name: memberName,
            selfExitId: exit.id,
            employmentPeriodId,
            shifts: remaining.shifts.map(s => s.id),
            tasks: remaining.tasks,
            reviews: remaining.reviews
          },
        }
      })
      await recordSecurityEvent(db, { action: 'MEMBER_DEPARTED', userId, organizationId, resourceType: 'MEMBER', resourceId: member.id })
      const owner = await db.organizationMember.findFirst({ where: { organizationId, role: 'OWNER', leftAt: null, user: { deletedAt: null } } })
      if (owner) await db.accountNotification.create({
        data: {
          organizationId,
          userId: owner.userId,
          type: 'ORGANIZATION_MEMBER_LEFT',
          title: 'Сотрудник покинул организацию',
          message: `${memberName}. Проверьте оставшиеся рабочие назначения.`,
          emailContext: { selfExitId: exit.id },
        }
      })
      const recipients = await loadPermissionMembers(db, organizationId)
      for (const recipient of recipients.members) {
        if (recipient.owner) continue
        if (!recipient.permissions.some(key => ['schedule.edit', 'schedule.cancel', 'requests.resolve'].includes(key))) continue
        const actor = await getMembership(recipient.userId, organizationId, db)
        const work = await exitWorkFor(db, actor, exit.id, undefined, recipients)
        if (!recipient.owner && !work?.shifts.length && !work?.tasks.length) continue
        await db.accountNotification.create({
          data: {
            organizationId,
            userId: recipient.userId,
            type: 'ORGANIZATION_MEMBER_LEFT',
            title: 'Сотрудник покинул организацию',
            message: `${memberName}. Проверьте оставшиеся рабочие назначения.`,
            emailContext: { selfExitId: exit.id },
          }
        })
      }
      return { id: exit.id }
    }, { isolationLevel: 'ReadCommitted', timeout: 30000 }),
  )
}
