import { createHash } from 'node:crypto'
import { Prisma, type MemberAvailability } from '../../../generated/prisma/client.ts'
import type { AvailabilityConflictShift, AvailabilitySave, AvailabilityState } from '../../../shared/availability.ts'
import { availabilitySaveSchema, emptyAvailabilityConfig } from '../../../shared/availability.ts'
import { stableJson } from '../../../shared/stable-json.ts'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { getMembership } from '../../organizations/access/permissions.ts'
import { hasPermission, locationsFor, loadPermissionMembers, type PermissionActor } from '../../organizations/access/access.ts'
import { memberIdentityWhere } from '../../access/member-policy.ts'
import { requirePlanFeature } from '../../subscriptions/access.ts'
import { mediaUrl } from '../../storage/image-service.ts'
import { parseAvailability, issueForAssignment, validAvailabilityOverride } from './checks.ts'

type DB = Prisma.TransactionClient
type Actor = Awaited<ReturnType<typeof getMembership>>
const nameOf = (user: { firstName: string | null; lastName: string | null; middleName: string | null }) =>
  [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || 'Сотрудник'

async function targetFor(db: DB, actor: Actor, memberId: string) {
  const own = actor.id === memberId
  const viewPoints = locationsFor(actor, 'availability.view')
  if (own ? !hasPermission(actor, 'availability.own') && !hasPermission(actor, 'availability.view') : !actor.owner && !viewPoints.length) {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для просмотра доступности.')
  }
  const target = await db.organizationMember.findFirst({
    where: {
      AND: [memberIdentityWhere(actor, viewPoints, false), { id: memberId, leftAt: null }],
    },
    include: {
      user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true } },
      employmentPeriods: { where: { endedAt: null }, take: 1 },
      locationMemberships: { where: { leftAt: null, location: { archivedAt: null } }, select: { locationId: true } },
      locationTransfers: { where: { temporary: true, revokedAt: null, endAt: { gt: new Date() } }, select: { toLocationId: true } },
    },
  })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Действующий сотрудник недоступен.')
  const period = target.employmentPeriods[0]
  if (!period) throw new ApiError(409, 'MEMBERSHIP_CHANGED', 'Период участия изменился. Обновите данные.')
  return { target, period }
}

async function canManage(db: DB, actor: Actor, target: Awaited<ReturnType<typeof targetFor>>['target']) {
  if (actor.owner || actor.id === target.id && hasPermission(actor, 'availability.own')) return true
  if (!locationsFor(actor, 'availability.manage').length) return false
  const context = await loadPermissionMembers(db, actor.organizationId)
  const person = context.members.find(member => member.id === target.id)
  const points = new Set([
    ...(person?.permissionLocations['schedule.own'] ?? []),
    ...target.locationMemberships.map(item => item.locationId),
    ...target.locationTransfers.map(item => item.toLocationId),
  ])
  if (!points.size) return hasPermission(actor, 'availability.manage')
  return [...points].every(id => hasPermission(actor, 'availability.manage', id))
}

export async function availabilityConflicts(db: DB, actor: PermissionActor, record: MemberAvailability): Promise<AvailabilityConflictShift[]> {
  const parsed = parseAvailability(record)
  const permission = actor.id === record.memberId ? 'schedule.own' : 'schedule.view'
  const points = locationsFor(actor, permission)
  const shifts = await db.workShift.findMany({
    where: {
      organizationId: actor.organizationId, memberId: record.memberId, status: 'SCHEDULED',
      location: { archivedAt: null },
      scheduledStartAt: { gt: new Date() }, actualStartAt: null, actualEndAt: null,
      actualBreakMinutes: null, attendance: 'UNCONFIRMED',
      ...(actor.owner ? {} : { locationId: { in: points } }),
    },
    include: { location: { select: { name: true, timezone: true } } },
    orderBy: [{ scheduledStartAt: 'asc' }, { id: 'asc' }],
  })
  return shifts.flatMap(shift => {
    if (validAvailabilityOverride(shift.availabilityOverride, shift.memberId, shift.scheduledStartAt, shift.scheduledEndAt)) return []
    const issue = issueForAssignment(parsed, {
      memberId: shift.memberId, locationId: shift.locationId, start: shift.scheduledStartAt, end: shift.scheduledEndAt,
    })
    return issue ? [{
      id: shift.id, updatedAt: shift.updatedAt.toISOString(), locationId: shift.locationId,
      locationName: shift.location.name, timezone: shift.location.timezone,
      start: shift.scheduledStartAt.toISOString(), end: shift.scheduledEndAt.toISOString(),
      message: `${issue.message} · ${issue.timezone}`, canEdit: hasPermission(actor, 'schedule.edit', shift.locationId),
    }] : []
  })
}

async function stateFor(db: DB, actor: Actor, memberId: string): Promise<AvailabilityState> {
  const { target, period } = await targetFor(db, actor, memberId)
  await requirePlanFeature(actor.organizationId, 'availability', db)
  const record = await db.memberAvailability.findUnique({ where: { employmentPeriodId: period.id } })
  const latest = record ? await db.memberAvailabilityEvent.findFirst({ where: { accountId: record.id }, orderBy: { revision: 'desc' } }) : null
  return {
    memberId, memberName: nameOf(target.user), avatarUrl: mediaUrl(target.user.avatarFileId),
    employmentPeriodId: period.id, revision: record?.revision ?? 0,
    timezone: record?.timezone ?? (await db.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { timezone: true } })).timezone,
    config: record ? parseAvailability(record).parsed : emptyAvailabilityConfig(),
    canManage: await canManage(db, actor, target),
    updatedAt: record?.updatedAt.toISOString() ?? null, updatedBy: latest?.actorName ?? null,
    conflicts: record ? await availabilityConflicts(db, actor, record) : [],
  }
}

export async function readAvailability(userId: string, organizationId: string, memberId: string) {
  return prisma.$transaction(async db => {
    const actor = await getMembership(userId, organizationId, db)
    return stateFor(db, actor, memberId)
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 })
}

async function notifyConflicts(db: DB, actor: Actor, record: MemberAvailability, memberName: string) {
  const context = await loadPermissionMembers(db, actor.organizationId)
  const allConflicts = await availabilityConflicts(db, { ...actor, owner: true }, record)
  for (const manager of context.members) {
    if (manager.id === actor.id) continue
    if (!manager.owner && !manager.permissions.includes('availability.view')) continue
    const conflicts = allConflicts.filter(shift =>
      hasPermission(manager, 'availability.view', shift.locationId) && hasPermission(manager, 'schedule.edit', shift.locationId))
    if (!conflicts.length) continue
    await db.accountNotification.create({ data: {
      organizationId: actor.organizationId, userId: manager.userId, type: 'SHIFT_AVAILABILITY_CHANGED',
      title: 'Доступность сотрудника изменилась',
      message: `${memberName}. Проверьте будущие смены вне новой доступности: ${conflicts.length}.`,
      emailContext: { availabilityMemberId: record.memberId, availabilityAccountId: record.id, employmentPeriodId: record.employmentPeriodId, locationIds: [...new Set(conflicts.map(shift => shift.locationId))] },
    } })
  }
}

export async function saveAvailability(userId: string, organizationId: string, memberId: string, input: AvailabilitySave) {
  input = availabilitySaveSchema.parse(input)
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    const actor = await getMembership(userId, organizationId, db)
    const { target, period } = await targetFor(db, actor, memberId)
    if (!await canManage(db, actor, target)) {
      throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Для изменения общей доступности нужны права во всех рабочих точках сотрудника.')
    }
    await requirePlanFeature(organizationId, 'availability', db)
    if (period.id !== input.employmentPeriodId) throw new ApiError(409, 'MEMBERSHIP_CHANGED', 'Период участия изменился. Откройте доступность заново.')
    const fingerprint = createHash('sha256').update(stableJson({ memberId, ...input })).digest('hex')
    const existing = await db.memberAvailabilityEvent.findUnique({ where: {
      organizationId_actorMemberId_operationId: { organizationId, actorMemberId: actor.id, operationId: input.operationId },
    } })
    if (existing) {
      if (existing.inputHash !== fingerprint) throw new ApiError(409, 'OPERATION_CHANGED', 'Этот запрос уже использован для других изменений.')
      return { revision: existing.revision, repeated: true }
    }
    const current = await db.memberAvailability.findUnique({ where: { employmentPeriodId: period.id } })
    if ((current?.revision ?? 0) !== input.revision) throw new ApiError(409, 'AVAILABILITY_CHANGED', 'Доступность уже изменена. Обновите данные перед сохранением.')
    const config = input.config as unknown as Prisma.InputJsonValue
    const record = current
      ? await db.memberAvailability.update({ where: { id: current.id }, data: { config, revision: { increment: 1 } } })
      : await db.memberAvailability.create({ data: {
        organizationId, memberId, employmentPeriodId: period.id,
        timezone: (await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } })).timezone,
        config,
      } })
    const actorName = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { firstName: true, lastName: true, middleName: true } })
    await db.memberAvailabilityEvent.create({ data: {
      organizationId, accountId: record.id, actorMemberId: actor.id, actorName: nameOf(actorName), operationId: input.operationId,
      inputHash: fingerprint, revision: record.revision, before: current?.config ?? Prisma.DbNull, after: config,
    } })
    await db.accessAudit.create({ data: {
      organizationId, actorMemberId: actor.id, action: 'AVAILABILITY_CHANGED',
      details: { memberId, employmentPeriodId: period.id, accountId: record.id, revision: record.revision },
    } })
    await notifyConflicts(db, actor, record, nameOf(target.user))
    return { revision: record.revision, repeated: false }
  }, { isolationLevel: 'ReadCommitted', timeout: 30000 })
}

export async function readAvailabilityHistory(userId: string, organizationId: string, memberId: string, page: number) {
  return prisma.$transaction(async db => {
    const actor = await getMembership(userId, organizationId, db)
    const { period } = await targetFor(db, actor, memberId)
    await requirePlanFeature(organizationId, 'availability', db)
    const account = await db.memberAvailability.findUnique({ where: { employmentPeriodId: period.id } })
    if (!account) return { events: [], hasMore: false }
    const events = await db.memberAvailabilityEvent.findMany({
      where: { accountId: account.id }, orderBy: { revision: 'desc' }, skip: (page - 1) * 20, take: 21,
      select: { id: true, revision: true, createdAt: true, actorName: true, before: true, after: true },
    })
    return { events: events.slice(0, 20), hasMore: events.length > 20 }
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 })
}

export async function availabilityMembers(userId: string, organizationId: string) {
  return prisma.$transaction(async db => {
    const actor = await getMembership(userId, organizationId, db)
    const points = locationsFor(actor, 'availability.view')
    if (!actor.owner && !points.length && !hasPermission(actor, 'availability.own')) {
      throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Доступность сотрудников недоступна.')
    }
    await requirePlanFeature(organizationId, 'availability', db)
    const members = await db.organizationMember.findMany({
      where: {
        AND: [memberIdentityWhere(actor, points, false), { leftAt: null }],
      },
      select: { id: true, user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true } } },
      take: 1001,
    })
    if (members.length > 1000) throw new ApiError(400, 'MEMBERS_LIMIT', 'Уточните сотрудника через его профиль.')
    return {
      members: members.map(member => ({ id: member.id, displayName: nameOf(member.user), email: '', avatarUrl: mediaUrl(member.user.avatarFileId) }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.id.localeCompare(b.id)),
    }
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 })
}
