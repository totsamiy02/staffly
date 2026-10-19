import { hasPermission, requirePermission, locationsFor, ensureAccessRoles, auditAccess, type PermissionActor } from '../organizations/access/access.ts'
import type { Permission } from '../../app/access/catalog.ts'
import { scopedLocationId, locationMemberWhere } from '../organizations/location-context.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { Document, DocumentAcknowledgement, OrganizationMember } from '../../generated/prisma/client.ts'
import { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { deletePendingFile, mediaUrl, stageStoredFile } from '../storage/image-service.ts'
import { storage } from '../storage/provider.ts'
import { MAX_DOCUMENT_BYTES, supportsPreview, validateDocumentFile } from './file-validation.ts'
import type { Assignment, ListOptions, Metadata } from './schemas.ts'

const missing = () => new ApiError(404, 'DOCUMENT_NOT_FOUND', 'Документ не найден или недоступен.')
type DocumentActor = OrganizationMember & Partial<PermissionActor> & { readableLocationIds?: string[]; managedLocationIds?: string[] }
export const isManager = (actor: Pick<OrganizationMember, 'role'> & Partial<PermissionActor>) => actor.permissions ? actor.role === 'OWNER' || ['documents.upload','documents.edit','documents.delete','documents.assign','documents.control','documents.folders','documents.access'].some(key => (actor.permissions!.includes(key) || !!actor.permissionLocations?.[key]?.length)) : actor.role === 'OWNER' || actor.role === 'ADMIN'
async function documentActor(userId: string, organizationId: string) { return getMembership(userId, organizationId) }
function documentManager(actor: DocumentActor, locationId: string | null | undefined) {
  return actor.permissions ? ['documents.upload','documents.edit','documents.delete','documents.assign','documents.control','documents.folders','documents.access'].some(key => docPermission(actor, key as Permission, locationId)) : actor.role === 'OWNER' || actor.role === 'ADMIN' && !!locationId && !!actor.managedLocationIds?.includes(locationId)
}
function docPermission(actor: DocumentActor, key: Permission, locationId: string | null | undefined) {
  if (actor.role === 'OWNER') return true
  if (!scopedLocationId(actor.organizationId) && !actor.accessConfigured && actor.role === 'ADMIN' && '_count' in actor && (actor._count as {locationMemberships:number}).locationMemberships === 0) return true
  if (locationId && !actor.accessConfigured && !actor.readableLocationIds?.includes(locationId)) return false
  if (locationId == null) return key === 'documents.view' || key === 'documents.download' ? !!actor.permissions?.includes(key) || !!actor.permissionLocations?.[key]?.length : hasPermission(actor, 'documents.shared', null) && !!actor.organizationPermissions?.includes(key)
  return hasPermission(actor, key, locationId)
}
function assertDocumentManager(actor: DocumentActor, locationId: string | null | undefined, key: Permission = 'documents.edit') {
  if (!docPermission(actor, key, locationId)) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для действия с документом в этой области.')
}
function libraryWhere(actor: DocumentActor) {
  if (actor.role === 'OWNER') return {}
  return { OR: [{ locationId: { in: actor.permissionLocations ? locationsFor(actor, 'documents.view').filter(id => actor.accessConfigured || actor.readableLocationIds?.includes(id)) : actor.readableLocationIds ?? [] } }, ...((actor.permissions?.includes('documents.view') || locationsFor(actor,'documents.view').length) ? [{ locationId: null }] : [])] }
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
function folderReadable(actor: DocumentActor, folder: { locationId: string | null; visibility: string; audienceRoleIds?: string[]; audienceMemberIds?: string[]; inheritAccess?: boolean }) {
  return actor.role === 'OWNER' || docPermission(actor, 'documents.view', folder.locationId) && audienceReadable(actor, folder)
}
async function allowedFolders(tx: Prisma.TransactionClient | typeof prisma, actor: DocumentActor) {
  const folders = await tx.documentFolder.findMany({ where: { organizationId: actor.organizationId, ...libraryWhere(actor) }, orderBy: { name: 'asc' }, include: { location: { select: { name: true } } } })
  const denied = new Set(folders.filter(folder => !folderReadable(actor, folder)).map(folder => folder.id))
  let changed = true
  while (changed) { changed = false; for (const folder of folders) if (folder.parentId && denied.has(folder.parentId) && !denied.has(folder.id)) { denied.add(folder.id); changed = true } }
  return folders.filter(folder => !denied.has(folder.id))
}
function accessVisibility(visibility: Document['visibility'], folderId: string | null, folders: Array<{ id: string; parentId: string | null; visibility: string }>) {
  if (visibility !== 'ORGANIZATION') return visibility
  const tree = new Map(folders.map(folder => [folder.id, folder])), seen = new Set<string>()
  while (folderId && !seen.has(folderId)) { seen.add(folderId); const folder = tree.get(folderId); if (!folder) break; if (folder.visibility === 'ADMINS') return 'ADMINS'; folderId = folder.parentId }
  return visibility
}
function metadataLocation(org: string, data: { pointId?: string | null; shared?: boolean }) { return data.pointId !== undefined ? data.pointId : data.shared ? null : scopedLocationId(org) ?? null }
const include = { location: { select: { name: true } }, storedFile: { select: { mimeType: true, size: true } }, uploadedBy: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } }, targetMember: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } } } satisfies Prisma.DocumentInclude
const memberName = (user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email
export function acknowledgementState(item: Pick<DocumentAcknowledgement, 'cancelledAt' | 'acknowledgedAt' | 'openedAt' | 'deadline'>, timezone: string, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const day = ['year', 'month', 'day'].map(type => today.find(part => part.type === type)?.value).join('-')
  const overdue = !item.cancelledAt && !item.acknowledgedAt && Boolean(item.deadline && day > item.deadline.toISOString().slice(0, 10))
  return { state: item.cancelledAt ? 'CANCELLED' : item.acknowledgedAt ? 'ACKNOWLEDGED' : item.openedAt ? 'OPENED' : 'UNOPENED', overdue }
}
const acknowledgementInclude = { assignedBy: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } } } satisfies Prisma.DocumentAcknowledgementInclude
function ackDto(item: DocumentAcknowledgement & { assignedBy?: { user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null } } }, timezone: string) { return { id: item.id, assignedBy: item.assignedBy ? memberName(item.assignedBy.user) : null, assignedAt: item.assignedAt, openedAt: item.openedAt, acknowledgedAt: item.acknowledgedAt, cancelledAt: item.cancelledAt, deadline: item.deadline?.toISOString().slice(0, 10) ?? null, comment: item.comment, ...acknowledgementState(item, timezone) } }
function documentDto(item: Prisma.DocumentGetPayload<{ include: typeof include }> & { acknowledgements: Array<DocumentAcknowledgement & { assignedBy?: { user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null } } }> }, actor: DocumentActor, timezone: string, folders: Array<{ id: string; parentId: string | null; visibility: string }> = []) {
  const own = item.acknowledgements.find(ack => ack.memberId === actor.id)
  const result = { id: item.id, organizationId: item.organizationId, locationId: item.locationId, locationName: item.location?.name ?? null, canManage: documentManager(actor, item.locationId), canEdit: docPermission(actor, 'documents.edit', item.locationId), canDelete: docPermission(actor, 'documents.delete', item.locationId), canAssign: docPermission(actor, 'documents.assign', item.locationId), canControl: docPermission(actor, 'documents.control', item.locationId), canDownload: docPermission(actor, 'documents.download', item.locationId), canAccess: docPermission(actor, 'documents.access', item.locationId), canUpload: docPermission(actor, 'documents.upload', item.locationId), audienceRoleIds: item.audienceRoleIds, audienceMemberIds: item.audienceMemberIds, inheritAccess: item.inheritAccess, folderId: item.folderId, displayName: item.displayName, fileName: item.fileName, visibility: item.visibility, accessVisibility: accessVisibility(item.visibility, item.folderId, folders), targetMemberId: item.targetMemberId, createdAt: item.createdAt, updatedAt: item.updatedAt, deletedAt: item.deletedAt, mimeType: item.storedFile.mimeType, size: item.storedFile.size, previewable: supportsPreview(item.storedFile.mimeType, item.storedFile.size), uploadedBy: { name: memberName(item.uploadedBy.user), avatarUrl: mediaUrl(item.uploadedBy.user.avatarFileId) }, targetMember: item.targetMember ? { id: item.targetMember.id, name: memberName(item.targetMember.user), avatarUrl: mediaUrl(item.targetMember.user.avatarFileId), former: Boolean(item.targetMember.leftAt) } : null, acknowledgement: own ? ackDto(own, timezone) : null }
  if (!docPermission(actor, 'documents.control', item.locationId)) return result
  const active = item.acknowledgements.filter(ack => !ack.cancelledAt)
  return { ...result, progress: { total: active.length, acknowledged: active.filter(ack => ack.acknowledgedAt).length, unopened: active.filter(ack => !ack.openedAt && !ack.acknowledgedAt).length, opened: active.filter(ack => ack.openedAt && !ack.acknowledgedAt).length, overdue: active.filter(ack => acknowledgementState(ack, timezone).overdue).length, cancelled: item.acknowledgements.length - active.length } }
}
function visibleWhere(actor: DocumentActor): Prisma.DocumentWhereInput {
  if (actor.role === 'OWNER') return {}
  const selected: Prisma.DocumentWhereInput[] = [{ audienceMemberIds: { has: actor.id } }]
  if (actor.accessRoleId) selected.push({ audienceRoleIds: { has: actor.accessRoleId } })
  for (const a of actor.accessAssignments ?? []) selected.push({ locationId: a.locationId, audienceRoleIds: { has: a.roleId } })
  return { OR: [{ visibility: 'ORGANIZATION' }, { inheritAccess: true, folderId: { not: null }, visibility: { not: 'PRIVATE_MEMBER' } }, { visibility: 'SELECTED', OR: selected }, { visibility: 'ADMINS', OR: [{ locationId: { in: actor.managedLocationIds ?? [] } }, ...(actor.accessSystemCode === 'ADMIN' || !actor.accessConfigured && actor.organizationRole === 'ADMIN' ? [{ locationId: null }] : [])] }, { visibility: 'PRIVATE_MEMBER', OR: [{ targetMemberId: actor.id }, { locationId: { in: locationsFor(actor, 'documents.personal.view') } }, ...(actor.organizationPermissions?.includes('documents.personal.view') ? [{ locationId: null }] : [])] }] }
}
async function transaction<T>(userId: string, organizationId: string, run: (tx: Prisma.TransactionClient, actor: DocumentActor & { organization: { timezone: string } }) => Promise<T>) {
  return prisma.$transaction(async tx => {
    // Serializes the folder tree, document lifecycle and membership transitions.
    // ReadCommitted reads current permissions after waiting for this lock, rather
    // than using a snapshot taken before a concurrent demotion/removal committed.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    let current: Awaited<ReturnType<typeof getMembership>>
    try { current = await getMembership(userId, organizationId, tx) } catch (error) { if (error instanceof ApiError && error.code === 'ORGANIZATION_NOT_FOUND') throw missing(); throw error }
    return run(tx, current)
  }, { isolationLevel: 'ReadCommitted', timeout: 15000 })
}
async function accessible(tx: Prisma.TransactionClient, actor: DocumentActor, documentId: string) {
  const doc = await tx.document.findFirst({ where: { id: documentId, organizationId: actor.organizationId } })
  if (!doc || !canReadDocument(actor, doc)) throw missing()
  if (doc.folderId && !(await allowedFolders(tx, actor)).some(folder => folder.id === doc.folderId)) throw missing()
  return doc
}
async function folderAncestorsReadable(tx: Prisma.TransactionClient | typeof prisma, actor: DocumentActor, folderId: string) {
  let id: string | null = folderId; const seen = new Set<string>()
  while (id) { if (seen.has(id)) return false; seen.add(id); const folder: { parentId: string | null; locationId: string | null; visibility: string } | null = await tx.documentFolder.findFirst({ where: { id, organizationId: actor.organizationId } }); if (!folder || !folderReadable(actor, folder)) return false; id = folder.parentId }
  return true
}
async function validateAudience(tx: Prisma.TransactionClient, org: string, data: { audienceRoleIds?: string[]; audienceMemberIds?: string[] }) {
  const roles = [...new Set(data.audienceRoleIds ?? [])], members = [...new Set(data.audienceMemberIds ?? [])]
  if (await tx.accessRole.count({ where: { organizationId: org, id: { in: roles } } }) !== roles.length || await tx.organizationMember.count({ where: { organizationId: org, id: { in: members }, leftAt: null } }) !== members.length) throw new ApiError(400, 'INVALID_AUDIENCE', 'Роли или сотрудники из другой организации.')
}
async function validateMetadata(tx: Prisma.TransactionClient, org: string, data: Metadata) {
  await validateAudience(tx, org, data)
  const locationId = metadataLocation(org, data)
  if (locationId && !await tx.organizationLocation.findFirst({ where: { id: locationId, organizationId: org, archivedAt: null } })) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
  if (data.folderId && !await tx.documentFolder.findFirst({ where: { id: data.folderId, organizationId: org, locationId } })) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
  if (data.targetMemberId) {
    const target = await tx.organizationMember.findFirst({ where: { id: data.targetMemberId, organizationId: org, ...(locationId ? { locationMemberships: { some: { locationId, leftAt: null } } } : {}) }, include: { locationMemberships: { where: { leftAt: null } } } })
    if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
    const recipient = await getMembership(target.userId, org, tx)
    if (data.folderId && !await folderAncestorsReadable(tx, recipient, data.folderId)) throw new ApiError(409, 'RECIPIENT_ACCESS_DENIED', 'Получатель не имеет доступа к выбранной папке.')
  }
}
export async function listDocuments(userId: string, organizationId: string, options: ListOptions) {
  const actor = await documentActor(userId, organizationId), manager = isManager(actor)
  const scopePermission: Permission | undefined = options.scope === 'control' ? 'documents.control' : options.scope === 'history' ? 'documents.delete' : options.targetMemberId && options.targetMemberId !== actor.id ? 'documents.personal.view' : undefined
  if (scopePermission && !actor.owner && !locationsFor(actor,scopePermission).length && !docPermission(actor,scopePermission,null)) requirePermission(actor,scopePermission)
  if (!actor.owner && !locationsFor(actor,'documents.view').length && !actor.permissions.includes('documents.view')) requirePermission(actor,'documents.view')
  const permittedFolders = await allowedFolders(prisma, actor)
  const folderIds = permittedFolders.map(folder => folder.id)
  const where: Prisma.DocumentWhereInput = { organizationId, AND: [libraryWhere(actor), visibleWhere(actor), { OR: [{ folderId: null }, { folderId: { in: folderIds } }] }, ...(options.pointId && options.pointId !== 'all' ? [{ locationId: options.pointId === 'shared' ? null : options.pointId }] : [])], deletedAt: options.scope === 'history' ? { not: null } : null, displayName: options.search ? { contains: options.search, mode: 'insensitive' } : undefined, visibility: options.visibility }
  if (scopePermission && !actor.owner) (where.AND as Prisma.DocumentWhereInput[]).push({ OR: [{locationId:{in:locationsFor(actor,scopePermission)}}, ...(docPermission(actor,scopePermission,null) ? [{locationId:null}] : [])] })
  if (options.scope === 'mine') { where.visibility = 'PRIVATE_MEMBER'; where.targetMemberId = actor.id }
  else if (options.scope === 'personal') { where.visibility = 'PRIVATE_MEMBER'; where.targetMemberId = options.targetMemberId ?? (manager ? undefined : actor.id) }
  else if (options.targetMemberId) { where.visibility = 'PRIVATE_MEMBER'; where.targetMemberId = options.targetMemberId }
  else if (!manager && !options.visibility && options.scope === 'workspace') where.visibility = {not:'PRIVATE_MEMBER'}

  if (options.fileType) {
    const types = { pdf: ['application/pdf'], office: ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], image: ['image/jpeg', 'image/png', 'image/webp'], text: ['text/plain', 'text/csv', 'text/markdown'] }
    where.storedFile = { mimeType: { in: types[options.fileType] } }
  }
  if (options.scope === 'acknowledgements') where.acknowledgements = { some: { memberId: actor.id, cancelledAt: null } }
  if (options.scope === 'required') where.acknowledgements = { some: { memberId: actor.id, acknowledgedAt: null, cancelledAt: null } }
  if (options.scope === 'control') where.acknowledgements = { some: { acknowledgedAt: null, cancelledAt: null } }
  if (options.scope === 'workspace' && !options.search) where.folderId = options.folderId ?? null
  const [items, total] = await prisma.$transaction([prisma.document.findMany({ where, include: { ...include, acknowledgements: manager ? { include: acknowledgementInclude } : { where: { memberId: actor.id }, include: acknowledgementInclude } }, orderBy: [options.sort === 'name' ? { displayName: 'asc' } : options.sort === 'created' ? { createdAt: 'desc' } : { updatedAt: 'desc' }, { id: 'desc' }], skip: (options.page - 1) * options.pageSize, take: options.pageSize }), prisma.document.count({ where })])
  const allFolders = permittedFolders.filter(folder => !options.pointId || options.pointId === 'all' || folder.locationId === (options.pointId === 'shared' ? null : options.pointId))
  const pins = await prisma.documentFolderPin.findMany({ where: { userId, folder: { organizationId } }, select: { folderId: true } })
  const pinnedIds = new Set(pins.map(pin => pin.folderId))
  // Counts use the same library permissions, never private files visible only in another scope.
  const grouped = await prisma.document.groupBy({ by: ['folderId'], where: { organizationId, AND: [libraryWhere(actor), visibleWhere(actor), { folderId: { in: folderIds } }], deletedAt: null, ...(!manager ? {visibility:{not:'PRIVATE_MEMBER' as const}} : {}), folderId: { not: null } }, _count: { _all: true } })
  const counts = new Map<string, number>(), parents = new Map(allFolders.map(folder => [folder.id, folder.parentId]))
  for (const group of grouped) {
    let id = group.folderId; const seen = new Set<string>()
    while (id && !seen.has(id)) { seen.add(id); counts.set(id, (counts.get(id) ?? 0) + group._count._all); id = parents.get(id) ?? null }
  }
  return { documents: items.map(item => documentDto(item, actor, actor.organization.timezone, permittedFolders)), folders: allFolders.map(folder => ({ ...folder, accessVisibility: accessVisibility(folder.visibility, folder.parentId, permittedFolders), locationName: folder.location?.name ?? null, canManage: documentManager(actor, folder.locationId), canEdit:docPermission(actor,'documents.edit',folder.locationId),canDelete:docPermission(actor,'documents.delete',folder.locationId),canAccess:docPermission(actor,'documents.access',folder.locationId), pinned: pinnedIds.has(folder.id), documentCount: counts.get(folder.id) ?? 0 })), uploadMaxBytes: MAX_DOCUMENT_BYTES, pagination: { page: options.page, pageSize: options.pageSize, total, pages: Math.max(1, Math.ceil(total / options.pageSize)) } }
}
export async function getDocument(userId: string, organizationId: string, documentId: string) {
  return transaction(userId, organizationId, async (tx, actor) => {
    await accessible(tx, actor, documentId)
    const item = await tx.document.findUniqueOrThrow({ where: { id: documentId }, include: { ...include, acknowledgements: isManager(actor) ? { include: acknowledgementInclude } : { where: { memberId: actor.id }, include: acknowledgementInclude } } })
    return documentDto(item, actor, actor.organization.timezone, await allowedFolders(tx, actor))
  })
}
export async function uploadDocument(userId: string, organizationId: string, input: unknown, mime: string, name: string | undefined, data: Metadata) {
  const actor = await documentActor(userId, organizationId);
  assertDocumentManager(actor, metadataLocation(organizationId, data), 'documents.upload')
  const file = await validateDocumentFile(input, mime, name)
  const staged = await stageStoredFile({ objectKey: `organizations/${organizationId}/documents/${randomUUID()}.${file.extension}`, mimeType: file.mimeType, size: file.contents.length, checksumSha256: createHash('sha256').update(file.contents).digest('hex'), purpose: 'DOCUMENT', uploadedByUserId: userId, organizationId }, file.contents)
  try {
    return await transaction(userId, organizationId, async (tx, current) => {
       assertDocumentManager(current, metadataLocation(organizationId, data), 'documents.upload'); if (data.visibility === 'PRIVATE_MEMBER') assertDocumentManager(current, metadataLocation(organizationId,data),'documents.personal.edit'); await validateMetadata(tx, organizationId, data); if (data.folderId && !await folderAncestorsReadable(tx,current,data.folderId)) throw new ApiError(404,'FOLDER_NOT_FOUND','Папка не найдена.')
      if (data.visibility === 'PRIVATE_MEMBER' && data.targetMemberId && !data.folderId) {
        let root = await tx.documentFolder.findFirst({ where: { organizationId, locationId: metadataLocation(organizationId, data), parentId: null, name: 'Документы сотрудников' } })
        if (!root) root = await tx.documentFolder.create({ data: { organizationId, locationId: metadataLocation(organizationId, data), name: 'Документы сотрудников' } })
        const employee = await tx.organizationMember.findFirstOrThrow({ where: { organizationId, id: data.targetMemberId }, include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } })
        const employeeName = memberName(employee.user)
        let employeeFolder = await tx.documentFolder.findFirst({ where: { organizationId, locationId: root.locationId, parentId: root.id, name: employeeName } })
        if (!employeeFolder) employeeFolder = await tx.documentFolder.create({ data: { organizationId, locationId: root.locationId, parentId: root.id, name: employeeName } })
        data = { ...data, folderId: employeeFolder.id }
      }
      await tx.storedFile.update({ where: { id: staged.id }, data: { pendingDeletionAt: null } })
      const { shared: _shared, pointId: _pointId, ...metadata } = data
      return tx.document.create({ data: { ...metadata, locationId: metadataLocation(organizationId, data), organizationId, storedFileId: staged.id, uploadedByMemberId: current.id, fileName: file.fileName }, select: { id: true } })
    })
  } catch (error) { await deletePendingFile(staged.id); throw error }
}
export async function updateDocument(userId: string, organizationId: string, documentId: string, data: Metadata) {
  return transaction(userId, organizationId, async (tx, actor) => {
     const doc = await accessible(tx, actor, documentId)
    const contentChanged = doc.displayName!==data.displayName || doc.folderId!==(data.folderId??null) || data.pointId!==undefined && data.pointId!==doc.locationId
    assertDocumentManager(actor,doc.locationId,contentChanged || !docPermission(actor,'documents.access',doc.locationId) ? 'documents.edit':'documents.access')
    if (doc.targetMemberId !== (data.targetMemberId??null) || doc.folderId !== (data.folderId??null) || doc.visibility !== data.visibility || doc.inheritAccess !== data.inheritAccess || doc.audienceRoleIds.join() !== (data.audienceRoleIds ?? []).join() || doc.audienceMemberIds.join() !== (data.audienceMemberIds ?? []).join()) assertDocumentManager(actor, doc.locationId, 'documents.access')
    if (data.visibility === 'PRIVATE_MEMBER') assertDocumentManager(actor, doc.locationId, 'documents.personal.edit')
    if (doc.deletedAt) throw missing()
    const locationId = data.pointId !== undefined || data.shared !== undefined ? metadataLocation(organizationId, data) : doc.locationId
    await validateMetadata(tx, organizationId, { ...data, pointId: locationId })
    if (data.folderId && !await folderAncestorsReadable(tx,actor,data.folderId)) throw new ApiError(404,'FOLDER_NOT_FOUND','Папка не найдена.')
    const pending = await tx.documentAcknowledgement.findMany({ where: { documentId, acknowledgedAt: null, cancelledAt: null }, include: { member: { include: { locationMemberships: { where: { leftAt: null } } } } } })
    for (const ack of pending) {
      const recipient = await getMembership(ack.member.userId, organizationId, tx)
      if (!canReadDocument(recipient, { ...doc, ...data, locationId }) || data.folderId && !await folderAncestorsReadable(tx, recipient, data.folderId)) throw new ApiError(409, 'ACKNOWLEDGEMENT_ACCESS_CONFLICT', 'Сначала отмените незавершённые требования для сотрудников, которые потеряют доступ.')
    }
    assertDocumentManager(actor,locationId,contentChanged || !docPermission(actor,'documents.access',locationId) ? 'documents.edit':'documents.access')
    const { shared: _shared, pointId: _pointId, ...metadata } = data
    await tx.document.update({ where: { id: documentId }, data: { ...metadata, locationId } })
    await auditAccess(tx,actor,'DOCUMENT_ACCESS',{documentId,name:data.displayName,before:{visibility:doc.visibility,folderId:doc.folderId,roleIds:doc.audienceRoleIds,memberIds:doc.audienceMemberIds},after:{visibility:data.visibility,folderId:data.folderId??null,roleIds:data.audienceRoleIds??[],memberIds:data.audienceMemberIds??[]}})
  })
}
export async function deleteDocument(userId: string, organizationId: string, documentId: string) {
  return transaction(userId, organizationId, async (tx, actor) => {
     const doc = await accessible(tx, actor, documentId)
    assertDocumentManager(actor, doc.locationId, 'documents.delete')
    if (doc.deletedAt) return
    const now = new Date()
    await tx.documentAcknowledgement.updateMany({ where: { documentId, cancelledAt: null, acknowledgedAt: null }, data: { cancelledAt: now } })
    await tx.document.update({ where: { id: documentId }, data: { deletedAt: now } })
    // Bytes and file binding remain retained for manager history. Cleanup is separate.
  })
}
export async function assignAcknowledgements(userId: string, organizationId: string, documentId: string, data: Assignment) {
  return transaction(userId, organizationId, async (tx, actor) => {
     const doc = await accessible(tx, actor, documentId)
    assertDocumentManager(actor, doc.locationId, 'documents.assign')
    if (doc.deletedAt) throw missing()
    const candidates = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null }, ...(data.recipients === 'members' ? { id: { in: data.memberIds } } : {}) }, include: { locationMemberships: { where: { locationId: doc.locationId ?? undefined, leftAt: null } } } })
    await validateAudience(tx, organizationId, {audienceRoleIds:data.accessRoleIds})
    const hydrated = await Promise.all(candidates.map(m => getMembership(m.userId, organizationId, tx)))
    const members = hydrated.filter(member => data.recipients !== 'roles' || data.roles.includes(member.organizationRole) || (data.accessRoleIds ?? []).some(id => member.accessRoleId === id || member.accessAssignments.some(a => a.roleId === id && a.locationId === doc.locationId)))
    if (!members.length || (data.recipients === 'members' && members.length !== new Set(data.memberIds).size)) throw new ApiError(400, 'INVALID_RECIPIENTS', 'Выберите действующих сотрудников этой организации.')
    if (members.some(member => !canReadDocument(member, doc)) || doc.folderId && (await Promise.all(members.map(member => folderAncestorsReadable(tx, member, doc.folderId!)))).some(allowed => !allowed)) throw new ApiError(409, 'RECIPIENT_ACCESS_DENIED', 'Некоторые получатели не имеют доступа к документу. Измените доступ или список получателей.')
    const existing = await tx.documentAcknowledgement.findMany({ where: { documentId, memberId: { in: members.map(member => member.id) } }, select: { memberId: true } })
    const seen = new Set(existing.map(item => item.memberId)); const added = members.filter(member => !seen.has(member.id))
    if (!added.length) throw new ApiError(409, 'ALREADY_ASSIGNED', 'Этим сотрудникам уже назначено ознакомление. Для нового цикла загрузите новую редакцию документа.')
    await tx.documentAcknowledgement.createMany({ data: added.map(member => ({ documentId, memberId: member.id, assignedByMemberId: actor.id, deadline: data.deadline ? new Date(data.deadline) : null, comment: data.comment })) })
    await tx.accountNotification.createMany({ data: added.map(member => ({ userId: member.userId, organizationId, documentId, type: 'DOCUMENT_ASSIGNED', title: 'Требуется ознакомление', message: doc.displayName })) })
    return { assigned: added.length, skipped: seen.size }
  })
}
export async function acknowledgeDocument(userId: string, organizationId: string, documentId: string) {
  return transaction(userId, organizationId, async (tx, actor) => {
    const doc = await accessible(tx, actor, documentId); if (doc.deletedAt) throw missing()
    const ack = await tx.documentAcknowledgement.findUnique({ where: { documentId_memberId: { documentId, memberId: actor.id } } })
    if (!ack || ack.cancelledAt) throw new ApiError(409, 'ACKNOWLEDGEMENT_NOT_ACTIVE', 'Ознакомление не назначено или отменено.')
    if (ack.acknowledgedAt) throw new ApiError(409, 'ALREADY_ACKNOWLEDGED', 'Ознакомление уже подтверждено.')
    await tx.documentAcknowledgement.update({ where: { id: ack.id }, data: { acknowledgedAt: new Date() } })
  })
}
export async function cancelAcknowledgement(userId: string, organizationId: string, documentId: string, acknowledgementId?: string) {
  return transaction(userId, organizationId, async (tx, actor) => {
     const doc = await accessible(tx, actor, documentId); assertDocumentManager(actor, doc.locationId, 'documents.assign')
    const result = await tx.documentAcknowledgement.updateMany({ where: { documentId, id: acknowledgementId, acknowledgedAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } })
    if (!result.count) throw new ApiError(409, 'NO_ACTIVE_ACKNOWLEDGEMENT', 'Незавершённых ознакомлений не найдено.')
  })
}
export async function documentProgress(userId: string, organizationId: string, documentId: string, page = 1) {
  return transaction(userId, organizationId, async (tx, actor) => {
     const doc = await accessible(tx, actor, documentId); assertDocumentManager(actor, doc.locationId, 'documents.control')
    const items = await tx.documentAcknowledgement.findMany({ where: { documentId }, include: { ...acknowledgementInclude, member: { include: { user: true } } }, orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }], take: 50, skip: (page - 1) * 50 })
    const total = await tx.documentAcknowledgement.count({ where: { documentId } })
    return { recipients: items.map(item => ({ ...ackDto(item, actor.organization.timezone), member: { id: item.memberId, name: memberName(item.member.user), avatarUrl: mediaUrl(item.member.user.avatarFileId), former: Boolean(item.member.leftAt) } })), pagination: { page, pages: Math.max(1, Math.ceil(total / 50)), total } }
  })
}
export async function deliverDocument(userId: string, organizationId: string, documentId: string, action: 'preview' | 'download') {
  return transaction(userId, organizationId, async (tx, actor) => {
    const doc = await accessible(tx, actor, documentId)
    if (action === 'download') assertDocumentManager(actor, doc.locationId, 'documents.download')
    const file = await tx.storedFile.findFirst({ where: { id: doc.storedFileId, organizationId, purpose: 'DOCUMENT', pendingDeletionAt: null } })
    if (!file) throw missing()
    if (action === 'preview' && !supportsPreview(file.mimeType, file.size)) throw new ApiError(415, 'PREVIEW_UNSUPPORTED', 'Предпросмотр недоступен. Скачайте документ.')
    let object: Awaited<ReturnType<typeof storage.stream>>
    try { object = await storage.stream(file.objectKey) } catch { throw new ApiError(404, 'DOCUMENT_FILE_MISSING', 'Файл временно недоступен. Обратитесь к администратору.') }
    if (object.size !== file.size) { object.stream.destroy(); throw new ApiError(409, 'DOCUMENT_FILE_INVALID', 'Файл повреждён.') }
    return { ...object, mimeType: file.mimeType, fileName: doc.fileName, actorId: actor.id }
  })
}
// Called only after a successful, explicit content response; metadata and HEAD never enter here.
export async function recordDocumentOpened(userId: string, organizationId: string, documentId: string) {
  return transaction(userId, organizationId, async (tx, actor) => {
    const doc = await accessible(tx, actor, documentId); if (doc.deletedAt) return
    await tx.documentAcknowledgement.updateMany({ where: { documentId, memberId: actor.id, openedAt: null, cancelledAt: null, acknowledgedAt: null }, data: { openedAt: new Date() } })
  })
}
export async function setFolderPinned(userId: string, organizationId: string, folderId: string, pinned: boolean) {
  return transaction(userId, organizationId, async (tx, actor) => {
    const folder = await tx.documentFolder.findFirst({ where: { id: folderId, organizationId, ...libraryWhere(actor) } })
    if (!folder || !(await allowedFolders(tx, actor)).some(item => item.id === folderId)) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
    if (!isManager(actor)) {
      const folders = await tx.documentFolder.findMany({ where: { organizationId, ...libraryWhere(actor) }, select: { id: true, parentId: true } })
      const descendants = new Set([folderId])
      let previous = -1
      while (previous !== descendants.size) {
        previous = descendants.size
        for (const child of folders) if (child.parentId && descendants.has(child.parentId)) descendants.add(child.id)
      }
      const visible = await tx.document.count({ where: { organizationId, folderId: { in: [...descendants] }, deletedAt: null, visibility: 'ORGANIZATION' } })
      if (!visible) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
    }
    if (pinned) await tx.documentFolderPin.upsert({ where: { userId_folderId: { userId, folderId } }, create: { userId, folderId }, update: {} })
    else await tx.documentFolderPin.deleteMany({ where: { userId, folderId } })
  })
}
export async function saveFolder(userId: string, organizationId: string, folderId: string | undefined, data: { name: string; parentId: string | null; shared?: boolean; pointId?: string | null; visibility?: 'ORGANIZATION' | 'ADMINS' | 'SELECTED'; audienceRoleIds?: string[]; audienceMemberIds?: string[]; inheritAccess?: boolean }) {
  return transaction(userId, organizationId, async (tx, actor) => {

    const current = folderId ? await tx.documentFolder.findFirst({ where: { id: folderId, organizationId, ...libraryWhere(actor) } }) : null
    if (folderId && (!current || !await folderAncestorsReadable(tx,actor,folderId))) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
    const locationId = current && data.pointId === undefined && data.shared === undefined ? current.locationId : metadataLocation(organizationId, data)
    if (locationId && !await tx.organizationLocation.findFirst({ where: { id: locationId, organizationId, archivedAt: null } })) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
    if (current && (current.visibility !== data.visibility || current.audienceRoleIds.join() !== (data.audienceRoleIds ?? []).join() || current.audienceMemberIds.join() !== (data.audienceMemberIds ?? []).join() || current.inheritAccess !== !!data.inheritAccess)) assertDocumentManager(actor, current.locationId, 'documents.access')
    await validateAudience(tx, organizationId, data)
    const structuralChange = !current || current.name !== data.name || current.parentId !== data.parentId || current.locationId !== locationId
    if (current && structuralChange) assertDocumentManager(actor, current.locationId, 'documents.edit')
    assertDocumentManager(actor, locationId, current ? structuralChange || docPermission(actor,'documents.edit',locationId) ? 'documents.edit' : 'documents.access' : 'documents.folders')
    if (data.parentId && !await folderAncestorsReadable(tx,actor,data.parentId)) throw new ApiError(404,'FOLDER_NOT_FOUND','Папка не найдена.')
    let parent = data.parentId; const visited = new Set<string>()
    while (parent) {
      if (parent === folderId || visited.has(parent)) throw new ApiError(409, 'FOLDER_CYCLE', 'Нельзя переместить папку в себя или в дочернюю папку.')
      visited.add(parent); const item = await tx.documentFolder.findFirst({ where: { id: parent, organizationId, locationId } })
      if (!item) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
      parent = item.parentId
    }
    const metadata = { audienceRoleIds: data.audienceRoleIds ?? [], audienceMemberIds: data.audienceMemberIds ?? [], inheritAccess: !!data.parentId && !!data.inheritAccess, name: data.name, parentId: data.parentId, locationId, visibility: data.visibility ?? current?.visibility ?? 'ORGANIZATION' as const }
    if (current) {
      const descendants = new Set([current.id])
      const tree = await tx.documentFolder.findMany({ where: { organizationId }, select: { id: true, parentId: true } })
      let changed = true
      while (changed) { changed = false; for (const folder of tree) if (folder.parentId && descendants.has(folder.parentId) && !descendants.has(folder.id)) { descendants.add(folder.id); changed = true } }
      if (locationId !== current.locationId) {
        const personal = await tx.document.findMany({ where: { organizationId, folderId: { in: [...descendants] }, targetMemberId: { not: null } }, select: { targetMemberId: true } })
        if (locationId && await tx.locationMember.count({ where: { locationId, leftAt: null, memberId: { in: [...new Set(personal.map(doc => doc.targetMemberId!))] } } }) !== new Set(personal.map(doc => doc.targetMemberId)).size) throw new ApiError(409, 'FOLDER_MEMBER_SCOPE', 'Личные документы в папке адресованы сотрудникам другой точки.')
        if (locationId) await tx.documentAcknowledgement.updateMany({ where: { acknowledgedAt: null, cancelledAt: null, member: { role: { not: 'OWNER' }, locationMemberships: { none: { locationId, leftAt: null } } }, document: { organizationId, folderId: { in: [...descendants] } } }, data: { cancelledAt: new Date() } })
        await tx.documentFolder.updateMany({ where: { id: { in: [...descendants] } }, data: { locationId } })
        await tx.document.updateMany({ where: { organizationId, folderId: { in: [...descendants] } }, data: { locationId } })
      }
      await tx.documentFolder.update({ where: { id: current.id }, data: metadata })
      await auditAccess(tx,actor,'FOLDER_ACCESS',{folderId:current.id,name:data.name,before:{visibility:current.visibility,roleIds:current.audienceRoleIds,memberIds:current.audienceMemberIds},after:{visibility:metadata.visibility,roleIds:metadata.audienceRoleIds,memberIds:metadata.audienceMemberIds}})
      const pending = await tx.documentAcknowledgement.findMany({ where: { acknowledgedAt: null, cancelledAt: null, document: { organizationId, folderId: { in: [...descendants] } } }, include: { document: true, member: { include: { locationMemberships: { where: { leftAt: null } } } } } })
      const lostAccess: string[] = []
      for (const ack of pending) {
        const recipient = await getMembership(ack.member.userId, organizationId, tx)
        if (!canReadDocument(recipient, ack.document) || ack.document.folderId && !await folderAncestorsReadable(tx, recipient, ack.document.folderId)) lostAccess.push(ack.id)
      }
      if (lostAccess.length) await tx.documentAcknowledgement.updateMany({ where: { id: { in: lostAccess } }, data: { cancelledAt: new Date() } })
      return tx.documentFolder.findUniqueOrThrow({ where: { id: current.id } })
    }
    return tx.documentFolder.create({ data: { ...metadata, organizationId, locationId } })
  })
}
export async function deleteFolder(userId: string, organizationId: string, folderId: string) {
  return transaction(userId, organizationId, async (tx, actor) => {

    const folder = await tx.documentFolder.findFirst({ where: { id: folderId, organizationId, ...libraryWhere(actor) }, include: { _count: { select: { children: true, documents: { where: { deletedAt: null } } } } } })
    if (!folder || !await folderAncestorsReadable(tx,actor,folderId)) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
    assertDocumentManager(actor, folder.locationId, 'documents.delete')
    if (folder._count.children || folder._count.documents) throw new ApiError(409, 'FOLDER_NOT_EMPTY', 'Сначала переместите документы и вложенные папки.')
    await tx.document.updateMany({ where: { folderId, organizationId }, data: { folderId: null } })
    await tx.documentFolder.delete({ where: { id: folderId } })
  })
}
export async function personalDocuments(userId: string, page = 1, search = '', organizationId?: string) {
  if (organizationId) await getMembership(userId, organizationId)
  const where: Prisma.DocumentWhereInput = { organizationId, deletedAt: null, visibility: 'PRIVATE_MEMBER', displayName: search ? { contains: search, mode: 'insensitive' } : undefined, targetMember: { userId, leftAt: null }, organization: { deletedAt: null } }
  const candidates = await prisma.document.findMany({ where, select: { id: true, organizationId: true, locationId: true, folderId: true, visibility: true, targetMemberId: true, deletedAt: true } })
  const actors = new Map<string, Awaited<ReturnType<typeof documentActor>>>()
  const readableIds: string[] = []
  for (const doc of candidates) {
    let actor = actors.get(doc.organizationId)
    if (!actor) { actor = await documentActor(userId, doc.organizationId); actors.set(doc.organizationId, actor) }
    if (canReadDocument(actor, doc) && (!doc.folderId || await folderAncestorsReadable(prisma, actor, doc.folderId))) readableIds.push(doc.id)
  }
  where.id = { in: readableIds }
  const [items, total] = await prisma.$transaction([prisma.document.findMany({ where, include: { ...include, organization: true, acknowledgements: { where: { member: { userId } }, include: acknowledgementInclude } }, take: 25, skip: (page - 1) * 25, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }), prisma.document.count({ where })])
  return { documents: items.map(item => ({ ...documentDto(item, actors.get(item.organizationId)!, item.organization.timezone), organization: { id: item.organization.id, name: item.organization.name, logoUrl: mediaUrl(item.organization.logoFileId) } })), pagination: { page, pages: Math.max(1, Math.ceil(total / 25)), total } }
}
export async function documentMembers(userId: string, organizationId: string, all = false) {
  const actor = await documentActor(userId, organizationId);
  if (all && !actor.owner && !hasPermission(actor,'documents.shared',null)) throw new ApiError(403,'INSUFFICIENT_PERMISSIONS','Недостаточно прав для общих документов.')
  if (!actor.owner && !['documents.upload','documents.assign','documents.access','documents.personal.edit','documents.folders','documents.edit'].some(key=>actor.permissions.includes(key as Permission) || !!actor.permissionLocations[key]?.length)) throw new ApiError(403,'INSUFFICIENT_PERMISSIONS','Недостаточно прав для списка получателей.')
  const locationId=scopedLocationId(organizationId)
  const roles=await ensureAccessRoles(prisma,organizationId)
  const items = await prisma.organizationMember.findMany({ where: { organizationId, ...(all || !locationId ? {} : {OR:[locationMemberWhere(organizationId),{accessRoleId:{not:null}},{accessAssignments:{some:{locationId}}}]}) }, include: {accessAssignments:true,locationMemberships:{where:{leftAt:null}}, user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } }, orderBy: { joinedAt: 'asc' } })
  return items.map(item => ({ id: item.id, accessRoleIds:[...(item.role === 'OWNER' ? [roles.find(r=>r.systemCode==='OWNER')!.id] : []),...(item.accessRoleId?[item.accessRoleId]:[]),...(item.accessConfigured ? item.accessAssignments.filter(a=>all || !locationId || a.locationId===locationId).map(a=>a.roleId) : item.locationMemberships.filter(l=>all || !locationId || l.locationId===locationId).map(l=>roles.find(r=>r.systemCode===l.role)!.id))], name: memberName(item.user), email: hasPermission(actor,'members.contacts') ? item.user.email : '', role: item.role, former: Boolean(item.leftAt), avatarUrl: mediaUrl(item.user.avatarFileId) }))
}

export async function previewDocumentAudience(userId: string, organizationId: string, data: Metadata) {
  return transaction(userId, organizationId, async (tx, actor) => {
    const locationId = metadataLocation(organizationId, data)
    if (!docPermission(actor, 'documents.access', locationId) && !docPermission(actor, 'documents.upload', locationId) && !docPermission(actor, 'documents.folders', locationId) && !docPermission(actor,'documents.assign',locationId) && !docPermission(actor,'documents.edit',locationId)) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для проверки аудитории.')
    await validateAudience(tx, organizationId, data)
    const members = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null }, ...(!actor.owner && locationId ? {OR:[{role:'OWNER' as const},{accessRoleId:{not:null}},{locationMemberships:{some:{locationId,leftAt:null}}},{accessAssignments:{some:{locationId}}}]} : {}) }, include: { user: { select: { firstName: true, lastName: true, middleName: true, email: true, avatarFileId: true } } } })
    const result = await Promise.all(members.map(async m => {
      const recipient = await getMembership(m.userId, organizationId, tx)
      const allowed = canReadDocument(recipient, { ...data, targetMemberId:data.targetMemberId??null, organizationId, locationId, deletedAt: null }) && (!data.folderId || await folderAncestorsReadable(tx, recipient, data.folderId))
      return { id: m.id, name: memberName(m.user), avatarUrl: mediaUrl(m.user.avatarFileId), allowed }
    }))
    return { members: result }
  })
}

/** Member profile uses exactly the library's current audience and ancestor-folder checks. */
export async function listMemberProfileDocuments(userId: string, organizationId: string, memberId: string, kind: 'personal' | 'acknowledgements', page = 1, pendingOnly = false) {
  return transaction(userId, organizationId, async (tx, actor) => {
    if (!await tx.organizationMember.findFirst({ where: { organizationId, id: memberId, user: { deletedAt: null } }, select: { id: true } })) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
    const own = actor.id === memberId
    const folders = await allowedFolders(tx, actor)
    const permission: Permission = kind === 'personal' ? 'documents.personal.view' : 'documents.control'
    const scope = scopedLocationId(organizationId)
    const points = [scope, null].filter((id): id is string | null => id !== undefined).filter(id => docPermission(actor, 'documents.view', id) && (own || docPermission(actor, permission, id)))
    const where: Prisma.DocumentWhereInput = { organizationId, deletedAt: null, AND: [libraryWhere(actor), visibleWhere(actor), { OR: [{ folderId: null }, { folderId: { in: folders.map(folder => folder.id) } }] }, { OR: points.map(locationId => ({ locationId })) }],
      ...(kind === 'personal' ? { visibility: 'PRIVATE_MEMBER', targetMemberId: memberId } : { acknowledgements: { some: { memberId, cancelledAt: null, ...(pendingOnly ? { acknowledgedAt: null } : {}) } } }) }
    const total = await tx.document.count({ where })
    const items = await tx.document.findMany({ where, include: { ...include, acknowledgements: { where: { memberId }, include: acknowledgementInclude } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 15, take: 15 })
    return { documents: items.map(item => ({ ...documentDto(item, actor, actor.organization.timezone, folders), profileAcknowledgement: kind === 'acknowledgements' ? item.acknowledgements.map(ack => ({ openedAt: ack.openedAt, acknowledgedAt: ack.acknowledgedAt, deadline: ack.deadline }))[0] ?? null : null })), pagination: { page, total, pages: Math.max(1, Math.ceil(total / 15)) } }
  })
}
