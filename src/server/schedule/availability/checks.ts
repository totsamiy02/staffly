import { createHash } from 'node:crypto'
import type { MemberAvailability, Prisma } from '../../../generated/prisma/client.ts'
import type { AvailabilityAgreement, AvailabilityConfig, AvailabilityIssue, AvailabilityOverride } from '../../../shared/availability.ts'
import { availabilityConfigSchema } from '../../../shared/availability.ts'
import { stableJson } from '../../../shared/stable-json.ts'
import { ApiError } from '../../api-error.ts'
import { hasPermission, type PermissionActor } from '../../organizations/access/access.ts'
import { getMembership } from '../../organizations/access/permissions.ts'
import { subscriptionSnapshot } from '../../subscriptions/access.ts'
import { availabilityIssue } from './calculation.ts'

type DB = Prisma.TransactionClient
export type AvailabilityRecord = MemberAvailability & { parsed: AvailabilityConfig }
export type AssignmentPeriod = { memberId: string; locationId: string; start: Date; end: Date }

export function parseAvailability(record: MemberAvailability): AvailabilityRecord {
  const parsed = availabilityConfigSchema.safeParse(record.config)
  if (!parsed.success) throw new ApiError(409, 'AVAILABILITY_INVALID', 'Правила доступности повреждены. Обратитесь к администратору.')
  return { ...record, parsed: parsed.data }
}

export async function loadAvailabilityRecords(db: DB, organizationId: string, memberIds?: string[]) {
  const plan = await subscriptionSnapshot(organizationId, db)
  if (!plan.features.includes('availability')) return new Map<string, AvailabilityRecord>()
  const records = await db.memberAvailability.findMany({ where: {
    organizationId,
    ...(memberIds ? { memberId: { in: [...new Set(memberIds)] } } : {}),
    employmentPeriod: { endedAt: null },
    member: { leftAt: null, user: { deletedAt: null } },
  } })
  return new Map(records.map(record => [record.memberId, parseAvailability(record)]))
}

export const availabilityPeriodKey = (period: AssignmentPeriod) =>
  `${period.locationId}:${period.memberId}:${period.start.toISOString()}:${period.end.toISOString()}`

export function validAvailabilityOverride(value: unknown, memberId: string, start: Date, end: Date): value is AvailabilityOverride {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<AvailabilityOverride>
  return typeof item.reason === 'string' && item.reason.trim().length >= 3 && item.memberId === memberId
    && item.start === start.toISOString() && item.end === end.toISOString()
}

export function issueForAssignment(record: AvailabilityRecord, period: AssignmentPeriod): AvailabilityIssue | null {
  const issue = availabilityIssue(record.parsed, record.timezone, period.start, period.end)
  return issue ? {
    memberId: period.memberId,
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    date: issue.date,
    message: issue.message,
    timezone: record.timezone,
  } : null
}

// Every scheduling transaction shares the same tenant lock with availability
// edits. Confirmation binds the actor, current revisions and complete batch.
export async function checkAvailabilityAssignments(
  db: DB,
  actor: PermissionActor,
  periods: AssignmentPeriod[],
  agreement: AvailabilityAgreement = {},
) {
  const accepted = new Map<string, AvailabilityOverride>()
  const future = periods.filter(period => period.end > new Date())
  if (!future.length) return accepted
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.organizationId},1))::text`
  const records = await loadAvailabilityRecords(db, actor.organizationId, future.map(period => period.memberId))
  const conflicts = future.flatMap(period => {
    const record = records.get(period.memberId)
    const issue = record && issueForAssignment(record, period)
    return issue ? [{ period, record: record!, issue }] : []
  })
  if (!conflicts.length) return accepted
  const source = await db.organizationMember.findUniqueOrThrow({ where: { id: actor.id }, select: { userId: true, user: { select: { firstName: true, lastName: true, middleName: true } } } })
  const liveActor = await getMembership(source.userId, actor.organizationId, db)
  const canOverride = conflicts.every(({ period }) => hasPermission(liveActor, 'availability.override', period.locationId))
  const token = createHash('sha256').update(stableJson({
    actorId: actor.id,
    organizationId: actor.organizationId,
    periods: future.map(availabilityPeriodKey).sort(),
    accounts: [...records.values()].map(record => ({
      id: record.id, employmentPeriodId: record.employmentPeriodId, revision: record.revision, timezone: record.timezone,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  })).digest('hex')
  if (agreement.availabilityConfirmation !== token) {
    throw new ApiError(409, 'AVAILABILITY_WARNING', 'Есть смены вне доступности сотрудника. Измените время или укажите договорённость.', {
      availabilityConfirmation: token,
      availabilityConflicts: conflicts.map(item => item.issue),
      canOverrideAvailability: canOverride,
    })
  }
  if (!canOverride) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для назначения вне доступности.')
  const reason = agreement.availabilityReason?.trim() ?? ''
  if (reason.length < 3) throw new ApiError(400, 'AVAILABILITY_REASON_REQUIRED', 'Укажите причину назначения по договорённости.')
  for (const { period, record } of conflicts) {
    accepted.set(availabilityPeriodKey(period), {
      memberId: period.memberId, start: period.start.toISOString(), end: period.end.toISOString(),
      reason, actorMemberId: actor.id, actorName: [source.user.lastName, source.user.firstName, source.user.middleName].filter(Boolean).join(' ') || 'Сотрудник', createdAt: new Date().toISOString(), accountId: record.id, revision: record.revision,
    })
  }
  return accepted
}

export async function requireCandidateAvailability(db: DB, organizationId: string, period: AssignmentPeriod) {
  const records = await loadAvailabilityRecords(db, organizationId, [period.memberId])
  const record = records.get(period.memberId)
  const issue = record && issueForAssignment(record, period)
  if (issue) throw new ApiError(409, 'MEMBER_UNAVAILABLE', `${issue.message} · ${issue.timezone}`)
}
