import { createHash, randomUUID } from 'node:crypto'
import type { Document, DocumentAcknowledgement, OrganizationMember } from '../../generated/prisma/client.ts'
import { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from '../organizations/permissions.ts'
import { deletePendingFile, mediaUrl, stageStoredFile } from '../storage/image-service.ts'
import { storage } from '../storage/provider.ts'
import { MAX_DOCUMENT_BYTES, supportsPreview, validateDocumentFile } from './file-validation.ts'
import type { Assignment, ListOptions, Metadata } from './schemas.ts'

const missing = () => new ApiError(404, 'DOCUMENT_NOT_FOUND', 'Документ не найден или недоступен.')
export const isManager = (actor: Pick<OrganizationMember, 'role'>) => actor.role === 'OWNER' || actor.role === 'ADMIN'
export function canReadDocument(actor: Pick<OrganizationMember, 'role' | 'id' | 'organizationId'>, doc: Pick<Document, 'organizationId' | 'visibility' | 'targetMemberId' | 'deletedAt'>) {
  return actor.organizationId === doc.organizationId && (isManager(actor) || (!doc.deletedAt && (doc.visibility === 'ORGANIZATION' || (doc.visibility === 'PRIVATE_MEMBER' && doc.targetMemberId === actor.id))))
}
const include = { storedFile: { select: { mimeType: true, size: true } }, uploadedBy: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } }, targetMember: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } } } } satisfies Prisma.DocumentInclude
const memberName = (user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email
export function acknowledgementState(item: Pick<DocumentAcknowledgement, 'cancelledAt' | 'acknowledgedAt' | 'openedAt' | 'deadline'>, timezone: string, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const day = ['year', 'month', 'day'].map(type => today.find(part => part.type === type)?.value).join('-')
  const overdue = !item.cancelledAt && !item.acknowledgedAt && Boolean(item.deadline && day > item.deadline.toISOString().slice(0, 10))
  return { state: item.cancelledAt ? 'CANCELLED' : item.acknowledgedAt ? 'ACKNOWLEDGED' : item.openedAt ? 'OPENED' : 'UNOPENED', overdue }
}
const acknowledgementInclude = { assignedBy: { include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } } } satisfies Prisma.DocumentAcknowledgementInclude
function ackDto(item: DocumentAcknowledgement & { assignedBy?: { user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null } } }, timezone: string) { return { id: item.id, assignedBy: item.assignedBy ? memberName(item.assignedBy.user) : null, assignedAt: item.assignedAt, openedAt: item.openedAt, acknowledgedAt: item.acknowledgedAt, cancelledAt: item.cancelledAt, deadline: item.deadline?.toISOString().slice(0, 10) ?? null, comment: item.comment, ...acknowledgementState(item, timezone) } }
function documentDto(item: Prisma.DocumentGetPayload<{ include: typeof include }> & { acknowledgements: Array<DocumentAcknowledgement & { assignedBy?: { user: { email: string; firstName: string | null; lastName: string | null; middleName: string | null } } }> }, actor: OrganizationMember, timezone: string) {
  const own = item.acknowledgements.find(ack => ack.memberId === actor.id)
  const result = { id: item.id, organizationId: item.organizationId, folderId: item.folderId, displayName: item.displayName, fileName: item.fileName, visibility: item.visibility, targetMemberId: item.targetMemberId, createdAt: item.createdAt, updatedAt: item.updatedAt, deletedAt: item.deletedAt, mimeType: item.storedFile.mimeType, size: item.storedFile.size, previewable: supportsPreview(item.storedFile.mimeType, item.storedFile.size), uploadedBy: { name: memberName(item.uploadedBy.user), avatarUrl: mediaUrl(item.uploadedBy.user.avatarFileId) }, targetMember: item.targetMember ? { id: item.targetMember.id, name: memberName(item.targetMember.user), avatarUrl: mediaUrl(item.targetMember.user.avatarFileId), former: Boolean(item.targetMember.leftAt) } : null, acknowledgement: own ? ackDto(own, timezone) : null }
  if (!isManager(actor)) return result
  const active = item.acknowledgements.filter(ack => !ack.cancelledAt)
  return { ...result, progress: { total: active.length, acknowledged: active.filter(ack => ack.acknowledgedAt).length, unopened: active.filter(ack => !ack.openedAt && !ack.acknowledgedAt).length, opened: active.filter(ack => ack.openedAt && !ack.acknowledgedAt).length, overdue: active.filter(ack => acknowledgementState(ack, timezone).overdue).length, cancelled: item.acknowledgements.length - active.length } }
}
function visibleWhere(actor: OrganizationMember): Prisma.DocumentWhereInput {
  return isManager(actor) ? {} : { OR: [{ visibility: 'ORGANIZATION' }, { visibility: 'PRIVATE_MEMBER', targetMemberId: actor.id }] }
}
async function transaction<T>(userId: string, organizationId: string, run: (tx: Prisma.TransactionClient, actor: OrganizationMember & { organization: { timezone: string } }) => Promise<T>) {
  return prisma.$transaction(async tx => {
    // Serializes the folder tree, document lifecycle and membership transitions.
    // ReadCommitted reads current permissions after waiting for this lock, rather
    // than using a snapshot taken before a concurrent demotion/removal committed.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const actor = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } }, include: { organization: true } })
    if (!actor || actor.leftAt || actor.organization.deletedAt) throw missing()
    return run(tx, actor)
  }, { isolationLevel: 'ReadCommitted', timeout: 15000 })
}
async function accessible(tx: Prisma.TransactionClient, actor: OrganizationMember, documentId: string) {
  const doc = await tx.document.findFirst({ where: { id: documentId, organizationId: actor.organizationId } })
  if (!doc || !canReadDocument(actor, doc)) throw missing()
  return doc
}
async function validateMetadata(tx: Prisma.TransactionClient, org: string, data: Metadata) {
  if (data.folderId && !await tx.documentFolder.findFirst({ where: { id: data.folderId, organizationId: org } })) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
  if (data.targetMemberId && !await tx.organizationMember.findFirst({ where: { id: data.targetMemberId, organizationId: org } })) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
}
export async function listDocuments(userId: string, organizationId: string, options: ListOptions) {
  const actor = await getMembership(userId, organizationId), manager = isManager(actor)
  if (['control', 'history'].includes(options.scope) || (options.targetMemberId && options.targetMemberId !== actor.id)) requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const where: Prisma.DocumentWhereInput = { organizationId, ...visibleWhere(actor), deletedAt: options.scope === 'history' ? { not: null } : null, displayName: options.search ? { contains: options.search, mode: 'insensitive' } : undefined, visibility: options.visibility }
  if (options.scope === 'mine') { where.visibility = 'PRIVATE_MEMBER'; where.targetMemberId = actor.id }
  else if (options.scope === 'personal') { where.visibility = 'PRIVATE_MEMBER'; where.targetMemberId = options.targetMemberId ?? (manager ? undefined : actor.id) }
  else if (options.targetMemberId) { where.visibility = 'PRIVATE_MEMBER'; where.targetMemberId = options.targetMemberId }
  else if (!manager && options.scope === 'workspace') where.visibility = 'ORGANIZATION'
  if (options.fileType) {
    const types = { pdf: ['application/pdf'], office: ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], image: ['image/jpeg', 'image/png', 'image/webp'], text: ['text/plain', 'text/csv'] }
    where.storedFile = { mimeType: { in: types[options.fileType] } }
  }
  if (options.scope === 'acknowledgements') where.acknowledgements = { some: { memberId: actor.id, cancelledAt: null } }
  if (options.scope === 'required') where.acknowledgements = { some: { memberId: actor.id, acknowledgedAt: null, cancelledAt: null } }
  if (options.scope === 'control') where.acknowledgements = { some: { acknowledgedAt: null, cancelledAt: null } }
  if (options.scope === 'workspace' && !options.search) where.folderId = options.folderId ?? null
  const [items, total] = await prisma.$transaction([prisma.document.findMany({ where, include: { ...include, acknowledgements: manager ? { include: acknowledgementInclude } : { where: { memberId: actor.id }, include: acknowledgementInclude } }, orderBy: [options.sort === 'name' ? { displayName: 'asc' } : options.sort === 'created' ? { createdAt: 'desc' } : { updatedAt: 'desc' }, { id: 'desc' }], skip: (options.page - 1) * options.pageSize, take: options.pageSize }), prisma.document.count({ where })])
  const [allFolders, pins] = await Promise.all([prisma.documentFolder.findMany({ where: { organizationId }, orderBy: { name: 'asc' }, select: { id: true, parentId: true, name: true } }), prisma.documentFolderPin.findMany({ where: { userId, folder: { organizationId } }, select: { folderId: true } })])
  const pinnedIds = new Set(pins.map(pin => pin.folderId))
  // Counts use the same library permissions, never private files visible only in another scope.
  const grouped = await prisma.document.groupBy({ by: ['folderId'], where: { organizationId, deletedAt: null, ...(manager ? {} : { visibility: 'ORGANIZATION' }), folderId: { not: null } }, _count: { _all: true } })
  const counts = new Map<string, number>(), parents = new Map(allFolders.map(folder => [folder.id, folder.parentId]))
  for (const group of grouped) {
    let id = group.folderId; const seen = new Set<string>()
    while (id && !seen.has(id)) { seen.add(id); counts.set(id, (counts.get(id) ?? 0) + group._count._all); id = parents.get(id) ?? null }
  }
  return { documents: items.map(item => documentDto(item, actor, actor.organization.timezone)), folders: allFolders.filter(folder => manager || counts.has(folder.id)).map(folder => ({ ...folder, pinned: pinnedIds.has(folder.id), documentCount: counts.get(folder.id) ?? 0 })), uploadMaxBytes: MAX_DOCUMENT_BYTES, pagination: { page: options.page, pageSize: options.pageSize, total, pages: Math.max(1, Math.ceil(total / options.pageSize)) } }
}
export async function getDocument(userId: string, organizationId: string, documentId: string) {
  return transaction(userId, organizationId, async (tx, actor) => {
    await accessible(tx, actor, documentId)
    const item = await tx.document.findUniqueOrThrow({ where: { id: documentId }, include: { ...include, acknowledgements: isManager(actor) ? { include: acknowledgementInclude } : { where: { memberId: actor.id }, include: acknowledgementInclude } } })
    return documentDto(item, actor, actor.organization.timezone)
  })
}
export async function uploadDocument(userId: string, organizationId: string, input: unknown, mime: string, name: string | undefined, data: Metadata) {
  const actor = await getMembership(userId, organizationId); requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const file = await validateDocumentFile(input, mime, name)
  const staged = await stageStoredFile({ objectKey: `organizations/${organizationId}/documents/${randomUUID()}.${file.extension}`, mimeType: file.mimeType, size: file.contents.length, checksumSha256: createHash('sha256').update(file.contents).digest('hex'), purpose: 'DOCUMENT', uploadedByUserId: userId, organizationId }, file.contents)
  try {
    return await transaction(userId, organizationId, async (tx, current) => {
      requireOrganizationRole(current.role, ['OWNER', 'ADMIN']); await validateMetadata(tx, organizationId, data)
      if (data.visibility === 'PRIVATE_MEMBER' && data.targetMemberId && !data.folderId) {
        let root = await tx.documentFolder.findFirst({ where: { organizationId, parentId: null, name: 'Документы сотрудников' } })
        if (!root) root = await tx.documentFolder.create({ data: { organizationId, name: 'Документы сотрудников' } })
        const employee = await tx.organizationMember.findFirstOrThrow({ where: { organizationId, id: data.targetMemberId }, include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true } } } })
        const employeeName = memberName(employee.user)
        let employeeFolder = await tx.documentFolder.findFirst({ where: { organizationId, parentId: root.id, name: employeeName } })
        if (!employeeFolder) employeeFolder = await tx.documentFolder.create({ data: { organizationId, parentId: root.id, name: employeeName } })
        data = { ...data, folderId: employeeFolder.id }
      }
      await tx.storedFile.update({ where: { id: staged.id }, data: { pendingDeletionAt: null } })
      return tx.document.create({ data: { ...data, organizationId, storedFileId: staged.id, uploadedByMemberId: current.id, fileName: file.fileName }, select: { id: true } })
    })
  } catch (error) { await deletePendingFile(staged.id); throw error }
}
export async function updateDocument(userId: string, organizationId: string, documentId: string, data: Metadata) {
  return transaction(userId, organizationId, async (tx, actor) => {
    requireOrganizationRole(actor.role, ['OWNER', 'ADMIN']); const doc = await accessible(tx, actor, documentId)
    if (doc.deletedAt) throw missing()
    await validateMetadata(tx, organizationId, data)
    const pending = await tx.documentAcknowledgement.findMany({ where: { documentId, acknowledgedAt: null, cancelledAt: null }, include: { member: true } })
    if (pending.some(ack => !canReadDocument(ack.member, { ...doc, ...data }))) throw new ApiError(409, 'ACKNOWLEDGEMENT_ACCESS_CONFLICT', 'Сначала отмените незавершённые требования для сотрудников, которые потеряют доступ.')
    await tx.document.update({ where: { id: documentId }, data })
  })
}
export async function deleteDocument(userId: string, organizationId: string, documentId: string) {
  return transaction(userId, organizationId, async (tx, actor) => {
    requireOrganizationRole(actor.role, ['OWNER', 'ADMIN']); const doc = await accessible(tx, actor, documentId)
    if (doc.deletedAt) return
    const now = new Date()
    await tx.documentAcknowledgement.updateMany({ where: { documentId, cancelledAt: null, acknowledgedAt: null }, data: { cancelledAt: now } })
    await tx.document.update({ where: { id: documentId }, data: { deletedAt: now } })
    // Bytes and file binding remain retained for manager history. Cleanup is separate.
  })
}
export async function assignAcknowledgements(userId: string, organizationId: string, documentId: string, data: Assignment) {
  return transaction(userId, organizationId, async (tx, actor) => {
    requireOrganizationRole(actor.role, ['OWNER', 'ADMIN']); const doc = await accessible(tx, actor, documentId)
    if (doc.deletedAt) throw missing()
    const members = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null }, ...(data.recipients === 'roles' ? { role: { in: data.roles } } : data.recipients === 'members' ? { id: { in: data.memberIds } } : {}) } })
    if (!members.length || (data.recipients === 'members' && members.length !== new Set(data.memberIds).size)) throw new ApiError(400, 'INVALID_RECIPIENTS', 'Выберите действующих сотрудников этой организации.')
    if (members.some(member => !canReadDocument(member, doc))) throw new ApiError(409, 'RECIPIENT_ACCESS_DENIED', 'Некоторые получатели не имеют доступа к документу. Измените доступ или список получателей.')
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
    requireOrganizationRole(actor.role, ['OWNER', 'ADMIN']); await accessible(tx, actor, documentId)
    const result = await tx.documentAcknowledgement.updateMany({ where: { documentId, id: acknowledgementId, acknowledgedAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } })
    if (!result.count) throw new ApiError(409, 'NO_ACTIVE_ACKNOWLEDGEMENT', 'Незавершённых ознакомлений не найдено.')
  })
}
export async function documentProgress(userId: string, organizationId: string, documentId: string, page = 1) {
  return transaction(userId, organizationId, async (tx, actor) => {
    requireOrganizationRole(actor.role, ['OWNER', 'ADMIN']); await accessible(tx, actor, documentId)
    const items = await tx.documentAcknowledgement.findMany({ where: { documentId }, include: { ...acknowledgementInclude, member: { include: { user: true } } }, orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }], take: 50, skip: (page - 1) * 50 })
    const total = await tx.documentAcknowledgement.count({ where: { documentId } })
    return { recipients: items.map(item => ({ ...ackDto(item, actor.organization.timezone), member: { id: item.memberId, name: memberName(item.member.user), avatarUrl: mediaUrl(item.member.user.avatarFileId), former: Boolean(item.member.leftAt) } })), pagination: { page, pages: Math.max(1, Math.ceil(total / 50)), total } }
  })
}
export async function deliverDocument(userId: string, organizationId: string, documentId: string, action: 'preview' | 'download') {
  return transaction(userId, organizationId, async (tx, actor) => {
    const doc = await accessible(tx, actor, documentId)
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
    const folder = await tx.documentFolder.findFirst({ where: { id: folderId, organizationId } })
    if (!folder) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
    if (!isManager(actor)) {
      const folders = await tx.documentFolder.findMany({ where: { organizationId }, select: { id: true, parentId: true } })
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
export async function saveFolder(userId: string, organizationId: string, folderId: string | undefined, data: { name: string; parentId: string | null }) {
  return transaction(userId, organizationId, async (tx, actor) => {
    requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
    if (folderId && !await tx.documentFolder.findFirst({ where: { id: folderId, organizationId } })) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
    let parent = data.parentId; const visited = new Set<string>()
    while (parent) {
      if (parent === folderId || visited.has(parent)) throw new ApiError(409, 'FOLDER_CYCLE', 'Нельзя переместить папку в себя или в дочернюю папку.')
      visited.add(parent); const item = await tx.documentFolder.findFirst({ where: { id: parent, organizationId } })
      if (!item) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
      parent = item.parentId
    }
    return folderId ? tx.documentFolder.update({ where: { id: folderId }, data }) : tx.documentFolder.create({ data: { ...data, organizationId } })
  })
}
export async function deleteFolder(userId: string, organizationId: string, folderId: string) {
  return transaction(userId, organizationId, async (tx, actor) => {
    requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
    const folder = await tx.documentFolder.findFirst({ where: { id: folderId, organizationId }, include: { _count: { select: { children: true, documents: { where: { deletedAt: null } } } } } })
    if (!folder) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Папка не найдена.')
    if (folder._count.children || folder._count.documents) throw new ApiError(409, 'FOLDER_NOT_EMPTY', 'Сначала переместите документы и вложенные папки.')
    await tx.document.updateMany({ where: { folderId, organizationId }, data: { folderId: null } })
    await tx.documentFolder.delete({ where: { id: folderId } })
  })
}
export async function personalDocuments(userId: string, page = 1, search = '', organizationId?: string) {
  if (organizationId) await getMembership(userId, organizationId)
  const where: Prisma.DocumentWhereInput = { organizationId, deletedAt: null, visibility: 'PRIVATE_MEMBER', displayName: search ? { contains: search, mode: 'insensitive' } : undefined, targetMember: { userId, leftAt: null }, organization: { deletedAt: null } }
  const [items, total] = await prisma.$transaction([prisma.document.findMany({ where, include: { ...include, organization: true, acknowledgements: { where: { member: { userId } }, include: acknowledgementInclude } }, take: 25, skip: (page - 1) * 25, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }), prisma.document.count({ where })])
  return { documents: items.map(item => ({ ...documentDto(item, item.targetMember!, item.organization.timezone), organization: { id: item.organization.id, name: item.organization.name, logoUrl: mediaUrl(item.organization.logoFileId) } })), pagination: { page, pages: Math.max(1, Math.ceil(total / 25)), total } }
}
export async function documentMembers(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId); requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const items = await prisma.organizationMember.findMany({ where: { organizationId }, include: { user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } } }, orderBy: { joinedAt: 'asc' } })
  return items.map(item => ({ id: item.id, name: memberName(item.user), email: item.user.email, role: item.role, former: Boolean(item.leftAt), avatarUrl: mediaUrl(item.user.avatarFileId) }))
}
