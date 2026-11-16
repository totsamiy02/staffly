import { Prisma } from '../../generated/prisma/client.ts'
import type { MemberBulkInput, MemberBulkResult, MemberBulkTarget, MemberBulkCandidates } from '../../shared/member-bulk.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { requireLocationInPlan, requireSubscriptionWritable } from '../subscriptions/access.ts'
import { bulkCandidate, bulkContext, bulkHash, bulkMembers, type BulkContext, type BulkDB, type BulkMember } from './member-bulk-policy.ts'
import { auditAccess } from './access/access.ts'

export async function memberBulkCandidates(userId: string, organizationId: string, target: MemberBulkTarget, search = ''): Promise<MemberBulkCandidates> {
  return prisma.$transaction(async db => {
    const context = await bulkContext(db, userId, organizationId, target)
    const members = await bulkMembers(db, context, undefined, search)
    const candidates = []
    // Keep one transaction connection; issuing hundreds of concurrent queries
    // does not make it parallel and can exhaust its timeout/statement queue.
    for (const member of members.slice(0, 1000)) candidates.push(await bulkCandidate(db, context, member))
    return {
      target: { ...target, name: context.name, locationId: context.locationId, locationName: context.locationName },
      members: candidates, locations: context.locations.map(location => ({ id: location.id, name: location.name })),
      roles: context.roles.map(role => ({ id: role.id, name: role.name })),
      truncated: members.length > 1000,
    }
  }, { timeout: 30000 })
}

async function addMember(db: BulkDB, context: BulkContext, member: BulkMember, input: MemberBulkInput) {
  const { actor, target } = context
  if (target.kind === 'POSITION') {
    await db.memberPosition.create({ data: { memberId: member.id, positionId: target.targetId } })
  } else if (target.kind === 'LOCATION') {
    await requireLocationInPlan(db, actor.organizationId, target.targetId)
    const role = member.role === 'ADMIN' ? 'ADMIN' : 'MEMBER'
    await db.locationMember.upsert({
      where: { locationId_memberId: { locationId: target.targetId, memberId: member.id } },
      create: { organizationId: actor.organizationId, locationId: target.targetId, memberId: member.id, role },
      update: { leftAt: null, role },
    })
  } else {
    await db.documentAcknowledgement.create({ data: {
      documentId: target.targetId, memberId: member.id, assignedByMemberId: actor.id,
      deadline: input.deadline ? new Date(input.deadline) : null, comment: input.comment,
    } })
    await db.accountNotification.create({ data: {
      userId: member.userId, organizationId: actor.organizationId, documentId: target.targetId,
      type: 'DOCUMENT_ASSIGNED', title: 'Требуется ознакомление', message: context.name,
    } })
  }
}

export async function applyMemberBulk(userId: string, organizationId: string, input: MemberBulkInput): Promise<MemberBulkResult> {
  return prisma.$transaction(async db => {
    // Same lock as membership lifecycle, subscription changes and document ACL.
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const context = await bulkContext(db, userId, organizationId, input)
    const fingerprint = bulkHash({
      kind: input.kind, targetId: input.targetId, deadline: input.deadline, comment: input.comment,
      rows: [...input.rows].sort((a, b) => a.memberId.localeCompare(b.memberId)),
    })
    const previous = await db.memberBulkOperation.findUnique({ where: {
      organizationId_actorMemberId_requestKey: { organizationId, actorMemberId: context.actor.id, requestKey: input.requestKey },
    } })
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'BULK_KEY_CONFLICT', 'Этот запрос уже использован для другого назначения. Обновите список.')
      return previous.result as unknown as MemberBulkResult
    }
    await requireSubscriptionWritable(db, organizationId)
    if (input.kind === 'LOCATION') await requireLocationInPlan(db, organizationId, input.targetId)
    const members = await bulkMembers(db, context, input.rows.map(row => row.memberId))
    const byId = new Map(members.map(member => [member.id, member]))
    const result: MemberBulkResult = { rows: [] }
    for (const row of input.rows) {
      const member = byId.get(row.memberId)
      const item: MemberBulkResult['rows'][number] = { memberId: row.memberId, action: row.action, status: 'FAILED', message: 'Сотрудник недоступен или больше не работает в организации.' }
      if (!member) { result.rows.push(item); continue }
      const candidate = await bulkCandidate(db, context, member)
      if (row.action === 'CANCEL') {
        if (input.kind !== 'DOCUMENT') throw new ApiError(400, 'BULK_ACTION_INVALID', 'Недопустимое действие.')
        if (candidate.status === 'CANCELLED') { item.status = 'UNCHANGED'; item.message = 'Назначение уже отменено.' }
        else if (!candidate.cancelRevision) item.message = 'Ознакомление уже подтверждено или больше не доступно для отмены.'
        else if (candidate.cancelRevision !== row.revision) item.message = 'Назначение изменилось. Проверьте список и повторите.'
        else {
          await db.documentAcknowledgement.update({
            where: { documentId_memberId: { documentId: input.targetId, memberId: member.id } }, data: { cancelledAt: new Date() },
          })
          await db.accountNotification.updateMany({ where: { organizationId, documentId: input.targetId, userId: member.userId, type: { in: ['DOCUMENT_ASSIGNED', 'DOCUMENT_REMINDER'] }, readAt: null }, data: { readAt: new Date() } })
          item.status = 'APPLIED'; item.message = 'Ознакомление отменено. История сохранена.'
        }
      } else if (candidate.status === 'ASSIGNED' || candidate.status === 'ACKNOWLEDGED') {
        item.status = 'UNCHANGED'; item.message = 'Уже назначено.'
      } else if (candidate.status !== 'AVAILABLE') {
        item.message = candidate.reason ?? 'Назначение недоступно.'
      } else if (candidate.revision !== row.revision) {
        item.message = 'Данные изменились после просмотра. Проверьте список и повторите.'
      } else {
        await addMember(db, context, member, input)
        item.status = 'APPLIED'; item.message = input.kind === 'DOCUMENT' ? 'Ознакомление назначено.' : input.kind === 'LOCATION' ? 'Сотрудник добавлен в точку.' : 'Должность назначена.'
      }
      result.rows.push(item)
    }
    await db.memberBulkOperation.create({ data: { organizationId, actorMemberId: context.actor.id, requestKey: input.requestKey, fingerprint, result: result as unknown as Prisma.InputJsonValue } })
    const applied = result.rows.filter(row => row.status === 'APPLIED')
    if (applied.length) await auditAccess(db, context.actor, 'MEMBER_BULK_ASSIGNED', {
      kind: input.kind, targetId: input.targetId, name: context.name,
      rows: applied.map(row => ({ memberId: row.memberId, action: row.action })), requestKey: input.requestKey,
    })
    return result
  }, { isolationLevel: 'ReadCommitted', timeout: 30000 })
}
