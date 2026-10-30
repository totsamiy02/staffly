import type { Document, OrganizationMember } from '../../generated/prisma/client.ts'
import { Prisma } from '../../generated/prisma/client.ts'
import type { Permission } from '../../app/access/catalog.ts'
import { hasPermission, type PermissionActor } from '../organizations/access/access.ts'
import { scopedLocationId } from '../organizations/location-context.ts'
export type DocumentActor = OrganizationMember & Partial<PermissionActor> & { readableLocationIds?: string[]; managedLocationIds?: string[] }
export function docPermission(actor: DocumentActor, key: Permission, locationId: string | null | undefined) {
  if (actor.role === 'OWNER') return true
  if (!scopedLocationId(actor.organizationId) && !actor.accessConfigured && actor.role === 'ADMIN' && '_count' in actor && (actor._count as {locationMemberships:number}).locationMemberships === 0) return true
  if (locationId && !actor.accessConfigured && !actor.readableLocationIds?.includes(locationId)) return false
  if (locationId == null) return key === 'documents.view' || key === 'documents.download' ? !!actor.permissions?.includes(key) || !!actor.permissionLocations?.[key]?.length : hasPermission(actor, 'documents.shared', null) && !!actor.organizationPermissions?.includes(key)
  return hasPermission(actor, key, locationId)
}
function audienceReadable(actor: DocumentActor, doc: { locationId?: string | null; visibility: string; audienceRoleIds?: string[]; audienceMemberIds?: string[]; inheritAccess?: boolean }) {
  if (actor.role === 'OWNER') return true
  if (doc.inheritAccess) return true
  if (doc.visibility === 'SELECTED') return !!doc.audienceMemberIds?.includes(actor.id) || !!doc.audienceRoleIds?.some(id => actor.accessRoleId === id || !!doc.locationId && actor.accessAssignments?.some(a => a.locationId === doc.locationId && a.roleId === id))
  if (doc.visibility === 'ADMINS') return doc.locationId ? !!actor.managedLocationIds?.includes(doc.locationId) : actor.accessSystemCode === 'ADMIN' || !actor.accessConfigured && actor.organizationRole === 'ADMIN'
  return doc.visibility === 'ORGANIZATION'
}
export function canReadDocument(actor: DocumentActor, doc: Pick<Document, 'organizationId' | 'visibility' | 'targetMemberId' | 'deletedAt'> & { locationId?: string | null; audienceRoleIds?: string[]; audienceMemberIds?: string[]; inheritAccess?: boolean }) {
  if (actor.organizationId !== doc.organizationId) return false
  if (actor.role === 'OWNER') return true
  if (doc.deletedAt && !docPermission(actor, 'documents.delete', doc.locationId)) return false
  if (!actor.permissions) { // Legacy pure callers; server paths hydrate current access first.
    if (doc.locationId && actor.readableLocationIds && !actor.readableLocationIds.includes(doc.locationId)) return false
    return doc.visibility === 'PRIVATE_MEMBER' ? doc.targetMemberId === actor.id || actor.role === 'ADMIN' && (!doc.locationId || !!actor.managedLocationIds?.includes(doc.locationId)) : audienceReadable(actor, doc)
  }
  if (!docPermission(actor, 'documents.view', doc.locationId)) return false
  if (doc.visibility === 'PRIVATE_MEMBER') return doc.targetMemberId === actor.id || docPermission(actor, 'documents.personal.view', doc.locationId)
  return audienceReadable(actor, doc)
}
export function folderReadable(actor: DocumentActor, folder: { locationId: string | null; visibility: string; audienceRoleIds?: string[]; audienceMemberIds?: string[]; inheritAccess?: boolean }) {
  return actor.role === 'OWNER' || docPermission(actor, 'documents.view', folder.locationId) && audienceReadable(actor, folder)
}

function permissionSql(actor: DocumentActor, key: Permission, location: Prisma.Sql) {
  if (actor.role === 'OWNER' || !scopedLocationId(actor.organizationId) && !actor.accessConfigured && actor.role === 'ADMIN' && '_count' in actor && (actor._count as {locationMemberships:number}).locationMemberships === 0) return Prisma.sql`TRUE`
  const ids = (actor.permissionLocations?.[key] ?? []).filter(id => docPermission(actor, key, id))
  return Prisma.sql`(CASE WHEN ${location} IS NULL THEN ${docPermission(actor,key,null)} ELSE ${location} = ANY(${ids}::uuid[]) END)`
}
function audienceSql(actor: DocumentActor, alias: string) {
  const d = Prisma.raw(alias)
  const roleBindings = (actor.accessAssignments ?? []).map(a => Prisma.sql`(${d}.location_id = ${a.locationId}::uuid AND ${a.roleId}::uuid = ANY(${d}.audience_role_ids))`)
  return Prisma.sql`(${d}.inherit_access OR ${d}.visibility = 'ORGANIZATION' OR
    (${d}.visibility = 'SELECTED' AND (${actor.id}::uuid = ANY(${d}.audience_member_ids) OR ${actor.accessRoleId ?? null}::uuid = ANY(${d}.audience_role_ids) ${roleBindings.length ? Prisma.sql`OR ${Prisma.join(roleBindings,' OR ')}` : Prisma.empty})) OR
    (${d}.visibility = 'ADMINS' AND (CASE WHEN ${d}.location_id IS NULL THEN ${actor.accessSystemCode === 'ADMIN' || !actor.accessConfigured && actor.organizationRole === 'ADMIN'} ELSE ${d}.location_id = ANY(${actor.managedLocationIds ?? []}::uuid[]) END)))`
}
// The same predicate is used for object reads and notification rows. Ancestors
// are checked in SQL; no document archive or folder ID deny-list is materialized.
export function documentReadSql(actor: DocumentActor, alias = 'd'): Prisma.Sql {
  if (!/^[a-z][a-z_]*$/.test(alias)) throw new Error('Invalid policy alias')
  const d = Prisma.raw(alias)
  if (actor.role === 'OWNER') return Prisma.sql`${d}.organization_id = ${actor.organizationId}::uuid`
  return Prisma.sql`(${d}.organization_id = ${actor.organizationId}::uuid
    AND (${d}.deleted_at IS NULL OR ${permissionSql(actor,'documents.delete',Prisma.sql`${d}.location_id`)})
    AND ${permissionSql(actor,'documents.view',Prisma.sql`${d}.location_id`)}
    AND (CASE WHEN ${d}.visibility = 'PRIVATE_MEMBER' THEN (${d}.target_member_id = ${actor.id}::uuid OR ${permissionSql(actor,'documents.personal.view',Prisma.sql`${d}.location_id`)}) ELSE ${audienceSql(actor,alias)} END)
    AND NOT EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT f.*, ARRAY[f.id] AS path, FALSE AS cycle FROM document_folders f WHERE f.id = ${d}.folder_id
        UNION ALL SELECT f.*, a.path || f.id, f.id = ANY(a.path) FROM document_folders f JOIN ancestors a ON f.id = a.parent_id WHERE NOT a.cycle
      ) SELECT 1 FROM ancestors f WHERE f.cycle OR f.organization_id <> ${actor.organizationId}::uuid OR NOT COALESCE((${permissionSql(actor,'documents.view',Prisma.sql`f.location_id`)} AND ${audienceSql(actor,'f')}), FALSE)
    ))`
}
