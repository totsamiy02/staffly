import { createHash } from 'node:crypto'
import { Prisma } from '../../generated/prisma/client.ts'
import type { MemberBulkCandidate, MemberBulkTarget } from '../../shared/member-bulk.ts'
import { ApiError } from '../api-error.ts'
import { documentReadSql, docPermission } from '../access/document-policy.ts'
import { memberIdentityWhere } from '../access/member-policy.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { getMembership } from './access/permissions.ts'
import { hasPermission, locationsFor, memberAudienceRoleIds } from './access/access.ts'

export type BulkDB = Prisma.TransactionClient
export const bulkHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const memberInclude = {
  user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true } },
  positions: { include: { position: true } },
  locationMemberships: { where: { leftAt: null, location: { archivedAt: null } }, include: { location: true } },
  accessAssignments: true,
} satisfies Prisma.OrganizationMemberInclude
export type BulkMember = Prisma.OrganizationMemberGetPayload<{ include: typeof memberInclude }>

export async function bulkContext(db: BulkDB, userId: string, organizationId: string, target: MemberBulkTarget) {
  const actor = await getMembership(userId, organizationId, db)
  const locations = await db.organizationLocation.findMany({ where: { organizationId, archivedAt: null }, orderBy: { name: 'asc' } })
  const viewLocations = locations.filter(location => hasPermission(actor, 'members.view', location.id))
  const identityWhere = memberIdentityWhere(actor, viewLocations.map(location => location.id), false)
  if (target.kind === 'POSITION') {
    if (!actor.owner && !locationsFor(actor, 'members.positions').length && !hasPermission(actor, 'members.positions', null)) {
      throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для назначения должностей.')
    }
    const position = await db.organizationPosition.findFirst({ where: { id: target.targetId, organizationId, isActive: true } })
    if (!position) throw new ApiError(404, 'POSITION_NOT_FOUND', 'Должность не найдена или неактивна.')
    return { actor, target, name: position.name, locationId: null, locationName: null, signature: bulkHash(position), identityWhere, locations: viewLocations, roles: [] }
  }
  if (target.kind === 'LOCATION') {
    const location = locations.find(item => item.id === target.targetId)
    if (!location) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена или закрыта.')
    if (!hasPermission(actor, 'members.assign', location.id) || !hasPermission(actor, 'members.view', location.id)) {
      throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для добавления сотрудников в эту точку.')
    }
    return { actor, target, name: location.name, locationId: location.id, locationName: location.name, signature: bulkHash({ id: location.id, revision: location.revision }), identityWhere, locations: viewLocations, roles: [] }
  }
  const document = await db.document.findFirst({ where: { id: target.targetId, organizationId, deletedAt: null }, include: { storedFile: true } })
  if (!document || document.storedFile.purgedAt || document.storedFile.pendingDeletionAt
    || !(await db.$queryRaw<Array<{ id: string }>>`SELECT d.id FROM documents d WHERE d.id = ${target.targetId}::uuid AND ${documentReadSql(actor)}`).length) {
    throw new ApiError(404, 'DOCUMENT_NOT_FOUND', 'Документ не найден или недоступен.')
  }
  if (!docPermission(actor, 'documents.assign', document.locationId)) {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для назначения ознакомления.')
  }
  const ancestors = []
  let folderId = document.folderId
  const seen = new Set<string>()
  while (folderId) {
    if (seen.has(folderId)) throw new ApiError(409, 'DOCUMENT_FOLDER_CYCLE', 'Проверьте расположение документа.')
    seen.add(folderId)
    const folder = await db.documentFolder.findFirstOrThrow({ where: { id: folderId, organizationId } })
    ancestors.push(folder)
    folderId = folder.parentId
  }
  // Match the existing document recipient scope; assigning a document does not
  // reveal a directory of people from unrelated locations.
  const documentIdentity: Prisma.OrganizationMemberWhereInput = actor.owner || !document.locationId ? {} : {
    OR: [{ role: 'OWNER' }, { accessRoleId: { not: null } },
      { locationMemberships: { some: { locationId: document.locationId, leftAt: null } } },
      { accessAssignments: { some: { locationId: document.locationId } } }],
  }
  const roles = await db.accessRole.findMany({ where: { organizationId }, select: { id: true, name: true, systemCode: true }, orderBy: { name: 'asc' } })
  return {
    actor, target, name: document.displayName, locationId: document.locationId,
    locationName: locations.find(location => location.id === document.locationId)?.name ?? null,
    signature: bulkHash({ document, ancestors }), identityWhere: documentIdentity,
    locations: viewLocations, document, roles,
  }
}
export type BulkContext = Awaited<ReturnType<typeof bulkContext>>

export async function bulkMembers(db: BulkDB, context: BulkContext, ids?: string[], search = '') {
  return db.organizationMember.findMany({
    where: { AND: [context.identityWhere, {
      organizationId: context.actor.organizationId, leftAt: null, user: { deletedAt: null },
      ...(ids ? { id: { in: ids } } : {}),
      ...(search ? { AND: search.split(/\s+/).map(part => ({ OR: [
        { user: { firstName: { contains: part, mode: 'insensitive' as const } } },
        { user: { lastName: { contains: part, mode: 'insensitive' as const } } },
        { user: { middleName: { contains: part, mode: 'insensitive' as const } } },
      ] })) } : {}),
    }] },
    include: memberInclude, orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { id: 'asc' }],
    take: ids ? 100 : 1001,
  })
}

export async function bulkCandidate(db: BulkDB, context: BulkContext, member: BulkMember): Promise<MemberBulkCandidate> {
  const { actor, target } = context
  let status: MemberBulkCandidate['status'] = 'AVAILABLE'
  let reason: string | null = null
  let cancellation: unknown = null
  let previousPlacement: unknown = null
  let acknowledgement: Awaited<ReturnType<typeof db.documentAcknowledgement.findFirst>> = null
  if (target.kind === 'POSITION') {
    const canAssign = actor.owner || hasPermission(actor, 'members.positions', null) && hasPermission(actor, 'members.view', null)
      || member.locationMemberships.some(point => hasPermission(actor, 'members.view', point.locationId) && hasPermission(actor, 'members.positions', point.locationId))
    if (!canAssign) { status = 'BLOCKED'; reason = 'Нет права назначать должности этому сотруднику.' }
    else if (member.positions.some(item => item.positionId === target.targetId)) status = 'ASSIGNED'
    else if (member.positions.length >= 20) { status = 'BLOCKED'; reason = 'У сотрудника уже назначено 20 должностей.' }
  } else if (target.kind === 'LOCATION') {
    const assignment = await db.locationMember.findUnique({ where: { locationId_memberId: { locationId: target.targetId, memberId: member.id } } })
    previousPlacement = assignment
    if (member.role === 'OWNER' || assignment && !assignment.leftAt) status = 'ASSIGNED'
    else if ((member.role === 'ADMIN' || assignment?.role === 'ADMIN') && !actor.owner) { status = 'BLOCKED'; reason = 'Администратора добавляет в точку владелец.' }
  } else {
    acknowledgement = await db.documentAcknowledgement.findUnique({ where: { documentId_memberId: { documentId: target.targetId, memberId: member.id } } })
    if (acknowledgement) {
      status = acknowledgement.cancelledAt ? 'CANCELLED' : acknowledgement.acknowledgedAt ? 'ACKNOWLEDGED' : 'ASSIGNED'
      if (status === 'CANCELLED') reason = 'Назначение отменено. Для нового цикла загрузите новую редакцию документа.'
      if (status === 'ASSIGNED') cancellation = { id: acknowledgement.id, assignedAt: acknowledgement.assignedAt }
    } else {
      const recipient = await getMembership(member.userId, actor.organizationId, db)
      const readable = await db.$queryRaw<Array<{ id: string }>>`SELECT d.id FROM documents d WHERE d.id = ${target.targetId}::uuid AND ${documentReadSql(recipient)}`
      if (!readable.length) { status = 'BLOCKED'; reason = 'Нет доступа к документу или его папке.' }
    }
  }
  const permittedPlacements = member.locationMemberships.filter(point => actor.owner || hasPermission(actor, 'members.view', point.locationId))
  const roleIds = context.target.kind === 'DOCUMENT' ? memberAudienceRoleIds(member, context.roles, context.locationId) : []
  const revision = bulkHash({
    target: context.signature, memberId: member.id, status, reason,
    role: member.role, joinedAt: member.joinedAt, configured: member.accessConfigured, accessRoleId: member.accessRoleId,
    placements: member.locationMemberships.map(point => [point.locationId, point.role]).sort(),
    access: member.accessAssignments.map(item => [item.locationId, item.roleId]).sort(),
    positions: member.positions.map(item => item.positionId).sort(), acknowledgement, previousPlacement,
  })
  return {
    id: member.id, displayName: [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || 'Сотрудник',
    avatarUrl: mediaUrl(member.user.avatarFileId),
    secondary: [
      ...(actor.owner || permittedPlacements.length || hasPermission(actor, 'members.view', null) ? member.positions.map(item => item.position.name) : []),
      ...permittedPlacements.map(point => point.location.name),
    ].join(' · '),
    locationIds: permittedPlacements.map(point => point.locationId), roleIds: [...new Set(roleIds)], status, reason, revision,
    cancelRevision: cancellation ? bulkHash({ target: context.signature, memberId: member.id, cancellation }) : null,
  }
}
