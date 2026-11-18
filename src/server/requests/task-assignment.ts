import { Prisma } from '../../generated/prisma/client.ts'
import { z } from 'zod'
import { requestReadSql, type Actor } from '../access/request-policy.ts'
import { ApiError } from '../api-error.ts'
import { taskOutcome } from '../attention/policy.ts'
import { prisma } from '../db.ts'
import { hasPermission, requirePermission } from '../organizations/access/access.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { locationWhere } from '../organizations/location-context.ts'
import { loadReviewerContext, type ReviewerContext } from './reviewers.ts'

type DB = Prisma.TransactionClient
type Task = NonNullable<ReturnType<typeof taskOutcome>>
type TaskRequest = {
  id: string
  organizationId: string
  locationId: string
  updatedAt: Date
  typeNameSnapshot: string
  status: string
  outcome: unknown
  selfExitId: string | null
}

export const taskAssignmentBody = z.object({ memberId: z.uuid(), updatedAt: z.iso.datetime() }).strict()

export function taskAssignees(context: ReviewerContext, locationId: string) {
  return context.members.filter(member => hasPermission(member, 'requests.own', locationId))
}

export function hasTaskAssignee(context: ReviewerContext, locationId: string, task: Task) {
  return context.members.some(member => task.assignees.includes(member.id) && hasPermission(member, 'requests.own', locationId))
}

// Called inside the membership transaction, with the organization lock held.
export async function detachOpenTasks(db: DB, input: {
  organizationId: string
  memberId: string
  actorMemberId: string
  comment: string
  selfExit?: { id: string; requestIds: string[] }
}) {
  if (input.selfExit && !input.selfExit.requestIds.length) return
  const rows = await db.$queryRaw<Array<{ id: string; outcome: Prisma.JsonObject }>>(Prisma.sql`
    SELECT id, outcome FROM requests
    WHERE organization_id=${input.organizationId}::uuid AND status='APPROVED'
      AND outcome->>'kind'='TASK' AND outcome->>'status'='OPEN'
      AND outcome->'assignees' @> ${JSON.stringify([input.memberId])}::jsonb
      ${input.selfExit ? Prisma.sql`AND id = ANY(${input.selfExit.requestIds}::uuid[])` : Prisma.empty}
    ORDER BY id FOR UPDATE`)
  for (const row of rows) {
    const task = taskOutcome(row.outcome)
    if (!task?.assignees.includes(input.memberId)) continue
    const assignees = task.assignees.filter(id => id !== input.memberId)
    await db.organizationRequest.update({
      where: { id: row.id },
      data: { selfExitId: input.selfExit?.id ?? null, outcome: { ...row.outcome, assignees } },
    })
    await db.requestEvent.create({
      data: {
        requestId: row.id, actorMemberId: input.actorMemberId, type: 'CHANGED', comment: input.comment,
        changes: { action: 'TASK_ASSIGNEE_REMOVED', memberId: input.memberId, previousAssignees: task.assignees,
          selfExitId: input.selfExit?.id ?? null },
      },
    })
  }
}

function unstaffedTask(item: TaskRequest) {
  return item.status === 'APPROVED' && !item.selfExitId ? taskOutcome(item.outcome) : null
}

export async function canAssignUnstaffedTask(actor: Actor, item: TaskRequest & { location: { archivedAt: Date | null } }) {
  const task = unstaffedTask(item)
  return Boolean(task && !item.location.archivedAt && hasPermission(actor, 'requests.resolve', item.locationId)
    && (!task.assignees.length || !hasTaskAssignee(await loadReviewerContext(prisma, actor.organizationId), item.locationId, task)))
}

async function requireUnstaffedTask(db: DB, userId: string, organizationId: string, requestId: string, lock: boolean) {
  const actor = await getMembership(userId, organizationId, db)
  const context = await loadReviewerContext(db, organizationId)
  const where = locationWhere(organizationId)
  const [visible] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r.id FROM requests r JOIN organization_locations l ON l.id=r.location_id
    WHERE r.id=${requestId}::uuid AND l.archived_at IS NULL AND ${requestReadSql(actor, context.roles)}
      ${where.locationId ? Prisma.sql`AND r.location_id=${where.locationId}::uuid` : Prisma.empty}
    ${lock ? Prisma.sql`FOR UPDATE OF r` : Prisma.empty}`)
  if (!visible) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.')
  const item = await db.organizationRequest.findUniqueOrThrow({ where: { id: visible.id } })
  requirePermission(actor, 'requests.resolve', item.locationId)
  const task = unstaffedTask(item)
  if (!task || hasTaskAssignee(context, item.locationId, task)) {
    throw new ApiError(409, 'ASSIGNMENT_CHANGED', 'У задачи уже есть исполнитель или она завершена. Обновите карточку.')
  }
  return { actor, context, item, task }
}

export async function taskAssignmentCandidates(userId: string, organizationId: string, requestId: string) {
  return prisma.$transaction(async db => {
    const { context, item } = await requireUnstaffedTask(db, userId, organizationId, requestId, false)
    const people = await db.organizationMember.findMany({
      where: { organizationId, id: { in: taskAssignees(context, item.locationId).map(member => member.id) } },
      select: { id: true, user: { select: { firstName: true, lastName: true, middleName: true } } },
    })
    return { members: people.map(({ id, user }) => ({
      id, name: [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || 'Сотрудник',
    }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.id.localeCompare(right.id)) }
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 })
}

export async function assignOpenTask(db: DB, actor: Actor, context: ReviewerContext, item: TaskRequest, task: Task, input: z.infer<typeof taskAssignmentBody>) {
  if (item.updatedAt.toISOString() !== input.updatedAt) {
    throw new ApiError(409, 'REQUEST_CHANGED', 'Задача изменилась. Обновите карточку.')
  }
  const target = taskAssignees(context, item.locationId).find(member => member.id === input.memberId)
  if (!target) throw new ApiError(409, 'ASSIGNEE_UNAVAILABLE', 'Исполнитель больше недоступен в этой точке.')
  await db.organizationRequest.update({
    where: { id: item.id },
    data: { selfExitId: null, outcome: { ...item.outcome as Prisma.JsonObject, assignees: [target.id] } },
  })
  await db.requestEvent.create({
    data: {
      requestId: item.id, actorMemberId: actor.id, type: 'CHANGED', comment: 'Задача передана новому исполнителю.',
      changes: { action: 'TASK_ASSIGNEE_ASSIGNED', selfExitId: item.selfExitId, previousAssignees: task.assignees, memberId: target.id },
    },
  })
  await db.accountNotification.create({
    data: {
      organizationId: item.organizationId, userId: target.userId, requestId: item.id,
      type: 'REQUEST_APPROVED', title: 'Вам передана задача', message: item.typeNameSnapshot,
    },
  })
}

export async function assignUnstaffedTask(userId: string, organizationId: string, requestId: string, input: z.infer<typeof taskAssignmentBody>) {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const { actor, context, item, task } = await requireUnstaffedTask(db, userId, organizationId, requestId, true)
    await assignOpenTask(db, actor, context, item, task, input)
  }, { timeout: 15000 })
}
