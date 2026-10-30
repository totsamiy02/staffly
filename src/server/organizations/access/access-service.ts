import { requireLocationInPlan, requirePlanFeature } from '../../subscriptions/access.ts'
import { mediaUrl } from '../../storage/image-service.ts'
import { normalizePermissions } from '../../../app/access/catalog.ts'
import { z } from 'zod'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { getMembership } from './permissions.ts'
import { auditAccess, ensureAccessRoles, permissionKeys, recommendedPermissions, resolveAccess } from './access.ts'
export const accessRoleBody = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).default(''), permissions: z.array(z.enum(permissionKeys as [typeof permissionKeys[number], ...typeof permissionKeys[number][]])).max(100), revision: z.number().int().positive().optional() }).strict()
export const accessAssignmentBody = z.object({ organizationRoleId: z.uuid().nullable(), assignments: z.array(z.object({ locationId: z.uuid(), roleId: z.uuid() }).strict()).max(50) }).strict()
async function owner(db: Parameters<typeof getMembership>[2], userId: string, org: string) {
  const actor = await getMembership(userId, org, db)
  if (!actor.owner) throw new ApiError(403, 'OWNER_REQUIRED', 'Ролями и назначениями управляет владелец.')
  return actor
}
export async function listAccessRoles(userId: string, org: string) {
  const actor = await getMembership(userId, org), roles = await ensureAccessRoles(prisma, org)
  const members = await prisma.organizationMember.findMany({ where: { organizationId: org, leftAt: null }, include: { accessAssignments: true, locationMemberships: { where: { leftAt: null } } } })
  return { roles: roles.map(role => ({ ...role, memberCount: members.filter(m => role.systemCode === 'OWNER' ? m.role === 'OWNER' : m.accessRoleId === role.id || m.accessConfigured && m.accessAssignments.some(a => a.roleId === role.id) || !m.accessConfigured && m.role !== 'OWNER' && m.locationMemberships.some(l => l.role === role.systemCode)).length })), canManage: actor.owner, recommended: recommendedPermissions }
}
export async function saveAccessRole(userId: string, org: string, id: string | null, data: z.infer<typeof accessRoleBody>) {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${org}, 1))::text`
    const actor = await owner(db, userId, org), roles = await ensureAccessRoles(db, org), current = roles.find(r => r.id === id)
    if (id && !current) throw new ApiError(404, 'ROLE_NOT_FOUND', 'Роль не найдена.')
    if (!current?.systemCode) await requirePlanFeature(org, 'customRoles', db)
    if (current?.systemCode === 'OWNER') throw new ApiError(403, 'PROTECTED_ROLE', 'Владелец сохраняет полный доступ.')
    if (current && data.revision !== current.revision) throw new ApiError(409, 'ROLE_CHANGED', 'Роль уже изменена. Откройте её заново.')
    if (!id && roles.length >= 100) throw new ApiError(400, 'ROLE_LIMIT', 'Можно создать до 100 ролей.')
    const name = current?.systemCode ? current.name : data.name
    if (roles.some(r => r.id !== id && r.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) throw new ApiError(409, 'ROLE_DUPLICATE', 'Роль с таким названием уже существует.')
    const fields = { name, description: data.description, permissions: normalizePermissions(data.permissions) }
    const result = id ? await db.accessRole.update({ where: { id }, data: { ...fields, revision: { increment: 1 } } }) : await db.accessRole.create({ data: { ...fields, organizationId: org } })
    await auditAccess(db, actor, id ? 'ROLE_UPDATED' : 'ROLE_CREATED', { roleId: result.id, name, before: current?.permissions ?? [], after: result.permissions })
    return result
  })
}
export async function deleteAccessRole(userId: string, org: string, id: string, replacementId: string) {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${org}, 1))::text`
    const actor = await owner(db, userId, org), roles = await ensureAccessRoles(db, org), current = roles.find(r => r.id === id), replacement = roles.find(r => r.id === replacementId)
    if (!current || !replacement || id === replacementId || replacement.systemCode === 'OWNER') throw new ApiError(400, 'INVALID_ROLE', 'Выберите действующую роль для замены.')
    if (current.systemCode) throw new ApiError(403, 'PROTECTED_ROLE', 'Стандартную роль нельзя удалить.')
    const references = await db.document.count({ where: { organizationId: org, audienceRoleIds: { has: id } } }) + await db.documentFolder.count({ where: { organizationId: org, audienceRoleIds: { has: id } } }) + await db.organizationEvent.count({ where: { organizationId: org, audienceAccessRoleIds: { has: id }, cancelledAt: null } })
    const workflows=await db.requestType.findMany({where:{organizationId:org,systemCode:null,deletedAt:null},select:{definition:true}})
    const activeRoutes=await db.organizationRequest.findMany({where:{organizationId:org,status:{in:['DRAFT','RETURNED','PENDING']}},select:{formSnapshot:true}})
    if(workflows.some(t=>JSON.stringify(t.definition).includes(id))||activeRoutes.some(r=>JSON.stringify(r.formSnapshot).includes(id)))throw new ApiError(409,'ROLE_IN_WORKFLOW','Роль используется в конструкторе обращений. Сначала измените маршрут и аудиторию.')
    if (references) throw new ApiError(409, 'ROLE_IN_AUDIENCE', 'Роль используется в доступе к документам или аудитории событий. Сначала измените эти аудитории.')
    await db.organizationMember.updateMany({ where: { organizationId: org, accessRoleId: id }, data: { accessRoleId: replacementId } })
    await db.accessAssignment.updateMany({ where: { organizationId: org, roleId: id }, data: { roleId: replacementId } })
    await db.accessRole.delete({ where: { id } })
    await auditAccess(db, actor, 'ROLE_DELETED', { roleId: id, name: current.name, replacementId })
  })
}
export async function memberAccess(userId: string, org: string, memberId: string) {
  const actor = await getMembership(userId, org)
  if (!actor.owner && actor.id !== memberId) throw new ApiError(403, 'OWNER_REQUIRED', 'Итоговый доступ сотрудников видит владелец.')
  const target = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId: org, leftAt: null }, include: { _count:{select:{locationMemberships:true}}, accessAssignments: true, locationMemberships: { where: { leftAt: null } }, user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true, email: true } } } })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
  const roles = await ensureAccessRoles(prisma, org), locations = await prisma.organizationLocation.findMany({ where: { organizationId: org, archivedAt: null }, select: { id: true, name: true } })
  const assignments = target.accessConfigured ? target.accessAssignments : target.locationMemberships.map(l => ({ locationId: l.locationId, roleId: roles.find(r => r.systemCode === l.role)!.id }))
  return { organizationRoleId: target.accessRoleId, assignments, owner: target.role === 'OWNER', member: { firstName: target.user.firstName, lastName: target.user.lastName, middleName: target.user.middleName, email: target.user.email, avatarUrl: mediaUrl(target.user.avatarFileId) }, locations, access: resolveAccess(target, roles, locations.map(l => l.id)), roles }
}
export async function saveMemberAccess(userId: string, org: string, memberId: string, data: z.infer<typeof accessAssignmentBody>) {
  await prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${org}, 1))::text`
    const actor = await owner(db, userId, org), roles = await ensureAccessRoles(db, org)
    const target = await db.organizationMember.findFirst({ where: { id: memberId, organizationId: org, leftAt: null } })
    if (!target || target.role === 'OWNER') throw new ApiError(400, 'PROTECTED_MEMBER', 'Доступ владельца изменяется через передачу владения.')
    const ids = [...data.assignments.map(a => a.roleId), ...(data.organizationRoleId ? [data.organizationRoleId] : [])]
    if (ids.some(id => !roles.some(r => r.id === id && r.systemCode !== 'OWNER')) || new Set(data.assignments.map(a => a.locationId)).size !== data.assignments.length) throw new ApiError(400, 'INVALID_ROLE', 'Проверьте роли и точки.')
    if (await db.organizationLocation.count({ where: { organizationId: org, id: { in: data.assignments.map(a => a.locationId) }, archivedAt: null } }) !== data.assignments.length) throw new ApiError(400, 'INVALID_LOCATION', 'Точка недоступна.')
    if (ids.some(id => roles.some(role => role.id === id && !role.systemCode))) await requirePlanFeature(org, 'customRoles', db)
    const before = await db.accessAssignment.findMany({ where: { memberId, organizationId: org } })
    const existingLocations = new Set(before.map(assignment => assignment.locationId))
    if (!target.accessConfigured) for (const membership of await db.locationMember.findMany({ where: { organizationId: org, memberId, leftAt: null }, select: { locationId: true } })) existingLocations.add(membership.locationId)
    for (const assignment of data.assignments) if (!existingLocations.has(assignment.locationId)) await requireLocationInPlan(db, org, assignment.locationId)
    await db.organizationMember.update({ where: { id: memberId }, data: { accessConfigured: true, accessRoleId: data.organizationRoleId } })
    await db.accessAssignment.deleteMany({ where: { organizationId: org, memberId } })
    if (data.assignments.length) await db.accessAssignment.createMany({ data: data.assignments.map(a => ({ ...a, memberId, organizationId: org })) })
    await auditAccess(db, actor, 'ASSIGNMENTS_UPDATED', { memberId, before, after: data.assignments, organizationRoleId: data.organizationRoleId })
    await db.accountNotification.create({ data: { organizationId: org, userId: target.userId, type: 'ROLE_CHANGED', title: 'Доступ изменён', message: 'Владелец обновил ваши роли и области доступа.' } })
  })
  return memberAccess(userId, org, memberId)
}
export async function accessAudit(userId: string, org: string) { await owner(prisma, userId, org); return prisma.accessAudit.findMany({ where: { organizationId: org }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 }) }
