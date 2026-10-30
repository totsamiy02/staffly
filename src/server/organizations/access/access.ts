import { browsePermissionKeys, crossPointPermissionKeys, permissionCatalog, permissionKeys, recommendedPermissions, systemRoleNames, type Permission } from '../../../app/access/catalog.ts'
import type { Prisma } from '../../../generated/prisma/client.ts'
import { ApiError } from '../../api-error.ts'

export type DB = Prisma.TransactionClient
export type PermissionActor = { id: string; organizationId: string; organizationRole?: string; role: string; locationId?: string; permissions?: string[]; organizationPermissions?: string[]; permissionLocations?: Record<string, string[]>; accessRoleId?: string | null; accessAssignments?: Array<{ locationId: string; roleId: string }>; owner?: boolean; accessSystemCode?: string | null }
export async function ensureAccessRoles(db: DB, organizationId: string) {
  const query = { where: { organizationId }, orderBy: [{ systemCode: 'asc' as const }, { createdAt: 'asc' as const }] }
  let roles = await db.accessRole.findMany(query)
  if (!roles.length) {
    await db.accessRole.createMany({ data: (['OWNER','ADMIN','MEMBER'] as const).map(systemCode => ({ organizationId, systemCode, name: systemRoleNames[systemCode], permissions: recommendedPermissions[systemCode] })), skipDuplicates: true })
    roles = await db.accessRole.findMany(query)
  }
  return roles.map(role => ({ ...role, permissions: role.permissions.filter(key => (permissionKeys as readonly string[]).includes(key)) }))
}
export function hasPermission(actor: PermissionActor, key: Permission, locationId: string | null | undefined = actor.locationId) {
  if (actor.owner || actor.organizationRole === 'OWNER' || actor.role === 'OWNER') return true
  if (locationId === null) return actor.organizationPermissions?.includes(key) ?? false
  if (locationId) return actor.permissionLocations?.[key]?.includes(locationId) ?? actor.permissions?.includes(key) ?? false
  return actor.permissions?.includes(key) ?? false
}
export function requirePermission(actor: PermissionActor, key: Permission, locationId: string | null | undefined = actor.locationId) {
  if (!hasPermission(actor, key, locationId)) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для этого действия.')
}
export function locationsFor(actor: PermissionActor, key: Permission) { return actor.permissionLocations?.[key] ?? [] }
export function resolveAccess(member: { role: 'OWNER'|'ADMIN'|'MEMBER'; accessConfigured: boolean; _count?: { locationMemberships: number }; accessRoleId: string | null; locationMemberships: Array<{ locationId: string; role: 'ADMIN'|'MEMBER' }>; accessAssignments: Array<{ locationId: string; roleId: string }> }, roles: Array<{ id: string; name: string; systemCode: string | null; permissions: string[] }>, locationIds: string[], selected?: string) {
  const owner = member.role === 'OWNER', global = roles.find(r => r.id === member.accessRoleId)
  const organizationPermissions = owner ? [...permissionKeys] : (global?.permissions ?? [])
  const localRoles = (member.accessConfigured ? member.accessAssignments : []).map(a => roles.find(r => r.id === a.roleId)).filter(Boolean)
  const legacyRoles = !member.accessConfigured ? member.locationMemberships.map(l => roles.find(r => r.systemCode === l.role)) : []
  const browse = organizationPermissions.includes('locations.browse') || [...localRoles,...legacyRoles].some(r => r?.permissions.includes('locations.browse'))
  const crossPointKeys = crossPointPermissionKeys
  const browseKeys = browsePermissionKeys
  const map: Record<string, string[]> = {}
  for (const key of permissionKeys) map[key] = []
  for (const locationId of locationIds) {
    const explicit = member.accessConfigured ? member.accessAssignments.find(a => a.locationId === locationId) : undefined
    const legacy = !member.accessConfigured ? roles.find(r => r.systemCode === (member.locationMemberships.find(m => m.locationId === locationId)?.role ?? (!(member._count?.locationMemberships ?? member.locationMemberships.length) && !selected ? member.role : undefined))) : undefined
    const local = roles.find(r => r.id === explicit?.roleId) ?? legacy
    for (const item of permissionCatalog) if (owner || organizationPermissions.includes(item.key) || item.scope === 'location' && local?.permissions.includes(item.key) || browse && browseKeys.includes(item.key) && [...localRoles,...legacyRoles].some(r => r?.permissions.includes(item.key)) || item.key === 'locations.browse' && local?.permissions.includes(item.key) || crossPointKeys.includes(item.key) && [...localRoles,...legacyRoles].some(r=>r?.permissions.includes(item.key))) map[item.key].push(locationId)
  }
  const permissions = owner ? [...permissionKeys] : permissionKeys.filter(key => selected ? map[key].includes(selected) || organizationPermissions.includes(key) : map[key].length || organizationPermissions.includes(key))
  const current = member.accessConfigured ? roles.find(r => r.id === member.accessAssignments.find(a => a.locationId === selected)?.roleId) : roles.find(r => r.systemCode === member.locationMemberships.find(a => a.locationId === selected)?.role)
  const fallback = roles.find(r => r.systemCode === member.role)
  return { owner, accessSystemCode:global?.systemCode, permissions, organizationPermissions, permissionLocations: map, roleName: owner ? 'Владелец' : current?.name ?? global?.name ?? (!member.accessConfigured ? fallback?.name : undefined) ?? 'Без роли' }
}
export async function auditAccess(db: DB, actor: { id: string; organizationId: string }, action: string, details: Prisma.InputJsonValue) {
  await db.accessAudit.create({ data: { organizationId: actor.organizationId, actorMemberId: actor.id, action, details } })
}
export async function loadPermissionMembers(db: DB, organizationId: string) {
  const members = await db.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null }, organization: { deletedAt: null } }, include: { _count: {select:{locationMemberships:true}}, locationMemberships: { where: { leftAt: null } }, accessAssignments: true } })
  const roles = await ensureAccessRoles(db, organizationId), locations = await db.organizationLocation.findMany({ where: { organizationId, archivedAt: null }, select: { id: true } })
  const locationIds = locations.map(l => l.id)
  return { organizationId, roles, members: members.map(member => ({ ...member, ...resolveAccess(member, roles, locationIds) })) }
}
export async function permissionRecipients(db: DB, organizationId: string, key: Permission, locationId?: string) {
  return permissionRecipientsFromContext(await loadPermissionMembers(db, organizationId), key, locationId)
}
export function permissionRecipientsFromContext({ members }: Awaited<ReturnType<typeof loadPermissionMembers>>, key: Permission, locationId?: string) {
  return members.filter(m => locationId ? m.permissionLocations[key]?.includes(locationId) : m.permissions.includes(key)).map(m => ({ userId: m.userId, id: m.id }))
}
export { permissionCatalog, permissionKeys, recommendedPermissions }
