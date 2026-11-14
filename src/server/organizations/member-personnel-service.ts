import { z } from 'zod'
import { requireSubscriptionWritable } from '../subscriptions/access.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from './access/permissions.ts'
import { hasPermission } from './access/access.ts'
import { memberIdentityWhere } from '../access/member-policy.ts'
import { personnelBody, personnelLabels, type PersonnelRecord, type PersonnelHistory } from '../../shared/member-personnel.ts'
import type { Prisma } from '../../generated/prisma/client.ts'

type Actor = Awaited<ReturnType<typeof getMembership>>
type Target = Prisma.OrganizationMemberGetPayload<{
  include: { locationMemberships: true; accessAssignments: true }
}>
const fields = Object.keys(personnelLabels) as Array<keyof typeof personnelLabels>

export function personnelRecord(target: PersonnelRecord): PersonnelRecord {
  const entries = [...fields, 'personnelRevision'].map(key => [key, target[key as keyof PersonnelRecord]])
  return Object.fromEntries(entries) as PersonnelRecord
}

export function personnelCapabilities(actor: Actor, target: Target) {
  const own = actor.id === target.id
  const inPoint = target.role === 'OWNER' || !!target.accessRoleId
    || target.accessAssignments.some(assignment => assignment.locationId === actor.locationId)
    || target.locationMemberships.some(point => point.locationId === actor.locationId && (target.leftAt || !point.leftAt))
  const allowed = (key: 'members.personnel.view' | 'members.personnel.edit' | 'members.personnel.history') =>
    actor.owner || inPoint && hasPermission(actor, key, actor.locationId)

  return {
    view: own || allowed('members.personnel.view'),
    edit: !target.leftAt && allowed('members.personnel.view') && allowed('members.personnel.edit'),
    contacts: !target.leftAt && own,
    history: allowed('members.personnel.view') && allowed('members.personnel.history'),
  }
}

async function readTarget(db: Prisma.TransactionClient, actor: Actor, memberId: string) {
  if (actor.id !== memberId && !hasPermission(actor, 'members.view', actor.locationId)) {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Карточка сотрудника недоступна.')
  }
  const target = await db.organizationMember.findFirst({
    where: { AND: [memberIdentityWhere(actor, [actor.locationId]), { id: memberId }] },
    include: { locationMemberships: true, accessAssignments: true },
  })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
  return target
}

export async function getMemberPersonnel(userId: string, organizationId: string, memberId: string, historyPage?: number) {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    const actor = await getMembership(userId, organizationId, db)
    const target = await readTarget(db, actor, memberId)
    const capabilities = personnelCapabilities(actor, target)
    const contacts = capabilities.view || hasPermission(actor, 'members.contacts', actor.locationId)
      ? { workEmail: target.workEmail, workPhone: target.workPhone }
      : { workEmail: null, workPhone: null }

    if (historyPage !== undefined && !capabilities.history) {
      throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'История кадровых изменений недоступна.')
    }
    const history = historyPage === undefined ? undefined : await loadPersonnelHistory(db, organizationId, memberId, historyPage)
    return {
      record: capabilities.view ? personnelRecord(target) : null,
      contacts,
      capabilities,
      ...(historyPage === undefined ? {} : { history }),
    }
  })
}

export async function updateMemberPersonnel(
  userId: string,
  organizationId: string,
  memberId: string,
  input: z.infer<typeof personnelBody>,
) {
  try {
    return await prisma.$transaction(async db => {
      await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
      const actor = await getMembership(userId, organizationId, db)
      const target = await readTarget(db, actor, memberId)
      const capabilities = personnelCapabilities(actor, target)
      if (input.mode === 'personnel' ? !capabilities.edit : !capabilities.contacts) {
        throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Изменение этих кадровых сведений недоступно.')
      }
      await requireSubscriptionWritable(db, organizationId)
      const { mode: _mode, revision, ...data } = input
      const changes = Object.entries(data)
        .filter(([field, value]) => target[field as keyof typeof data] !== value)
        .map(([field, after]) => ({ field, before: target[field as keyof typeof data], after }))

      // An identical retry after a lost response must not add a second history event.
      if (!changes.length) return { record: personnelRecord(target) }
      if (revision !== target.personnelRevision) {
        throw new ApiError(409, 'PERSONNEL_CHANGED', 'Карточка уже изменена. Обновите её перед сохранением.')
      }
      const saved = await db.organizationMember.update({
        where: { id: memberId },
        data: { ...data, personnelRevision: { increment: 1 } },
      })
      await db.accessAudit.create({
        data: {
          organizationId,
          actorMemberId: actor.id,
          action: 'PERSONNEL_UPDATED',
          details: { memberId, changes, revision: saved.personnelRevision },
        },
      })
      return { record: personnelRecord(saved) }
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ApiError(409, 'PERSONNEL_NUMBER_EXISTS', 'Табельный номер уже занят в этой организации.')
    }
    throw error
  }
}

export async function loadPersonnelHistory(db: Prisma.TransactionClient, organizationId: string, memberId: string, page: number) {
  const where = {
    organizationId,
    action: 'PERSONNEL_UPDATED',
    details: { path: ['memberId'], equals: memberId },
  }
  const total = await db.accessAudit.count({ where })
  const entries = await db.accessAudit.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * 15,
    take: 15,
  })
  const authors = await db.organizationMember.findMany({
    where: { organizationId, id: { in: entries.map(entry => entry.actorMemberId) } },
    select: { id: true, user: { select: { firstName: true, lastName: true, email: true, deletedAt: true } } },
  })
  const items = entries.map(entry => {
    const author = authors.find(member => member.id === entry.actorMemberId)
    const actorName = author && !author.user.deletedAt
      ? [author.user.lastName, author.user.firstName].filter(Boolean).join(' ') || author.user.email.split('@')[0] || 'Сотрудник'
      : 'Бывший участник'
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      actorName,
      changes: (entry.details as { changes: PersonnelHistory['changes'] }).changes,
    }
  })
  return { items, page, total, pages: Math.max(1, Math.ceil(total / 15)) }
}
