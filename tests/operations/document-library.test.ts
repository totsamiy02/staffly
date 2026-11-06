import assert from 'node:assert/strict'
import { before, after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { saveFolder, deleteFolder, setFolderPinned, uploadDocument, getDocument, listDocuments, deleteDocument, restoreDocument, purgeDocumentFile } from '../../src/server/documents/service.ts'
import { listSchema } from '../../src/server/documents/schemas.ts'

let owner: string, employee: string, outsider: string, org: string, member: string, otherMember: string
const pdf = Buffer.from('%PDF-1.4\n%%EOF')
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected
const list = (user: string) => listDocuments(user, org, listSchema.parse({}))
before(async () => {
  const users = await Promise.all(['owner','employee','outsider'].map(name => prisma.user.create({ data: { email: name + randomUUID() + '@example.test', emailVerifiedAt: new Date(), firstName: 'Одно имя' } })))
  ;[owner, employee, outsider] = users.map(user => user.id)
  org = (await createBusinessOrganization(owner, { name: 'Unified library', description: null, timezone: 'Europe/Moscow' })).id
  const location = await prisma.organizationLocation.findFirstOrThrow({ where: { organizationId: org } })
  for (const userId of [employee, outsider]) {
    const target = await prisma.organizationMember.create({ data: { organizationId: org, userId } })
    await prisma.locationMember.create({ data: { organizationId: org, locationId: location.id, memberId: target.id } })
    if (userId === employee) member = target.id; else otherMember = target.id
  }
})
after(() => prisma.$disconnect())

it('protects system structure while retaining access settings and keeping custom namesakes removable', async () => {
  const system = (await list(owner)).folders.find(folder => folder.systemKey === 'employees:shared')!
  assert.ok(system); assert.equal(system.canDelete, false); assert.equal(system.canEdit, false); assert.equal(system.canAccess, true)
  await assert.rejects(deleteFolder(owner, org, system.id), code('SYSTEM_FOLDER'))
  await assert.rejects(saveFolder(owner, org, system.id, { name: 'Renamed', parentId: null }), code('SYSTEM_FOLDER'))
  await assert.rejects(setFolderPinned(owner, org, system.id, true), code('SYSTEM_FOLDER'))
  await saveFolder(owner, org, system.id, { name: system.name, parentId: null, visibility: 'ORGANIZATION' })
  const custom = await saveFolder(owner, org, undefined, { name: system.name, parentId: null })
  await deleteFolder(owner, org, custom.id)
  assert.ok((await list(owner)).folders.some(folder => folder.id === system.id))
})

it('reveals a closed folder only to selected employees and revokes both rows and direct file links', async () => {
  const folder = await saveFolder(owner, org, undefined, { name: 'Закрытая папка', parentId: null, visibility: 'SELECTED', audienceMemberIds: [member] })
  const doc = await uploadDocument(owner, org, pdf, 'application/pdf', 'selected.pdf', { displayName: 'Адресованный документ', visibility: 'ORGANIZATION', folderId: folder.id, inheritAccess: true })
  assert.ok((await list(employee)).folders.some(value => value.id === folder.id))
  assert.ok(!(await list(outsider)).folders.some(value => value.id === folder.id))
  assert.equal((await getDocument(employee, org, doc.id)).accessVisibility, 'SELECTED')
  await assert.rejects(getDocument(outsider, org, doc.id), code('DOCUMENT_NOT_FOUND'))
  await saveFolder(owner, org, folder.id, { name: folder.name, parentId: null, visibility: 'SELECTED', audienceMemberIds: [] })
  await assert.rejects(getDocument(employee, org, doc.id), code('DOCUMENT_NOT_FOUND'))
  assert.ok(!(await list(employee)).folders.some(value => value.id === folder.id))
  await saveFolder(owner, org, folder.id, { name: folder.name, parentId: null, visibility: 'SELECTED', audienceMemberIds: [member] })
  assert.equal((await getDocument(employee, org, doc.id)).id, doc.id)
})

it('restores an accidentally removed document without dropping its folder access boundaries', async () => {
  const folder = await saveFolder(owner, org, undefined, { name: 'Сохранить историю доступа', parentId: null, visibility: 'SELECTED', audienceMemberIds: [member] })
  const doc = await uploadDocument(owner, org, pdf, 'application/pdf', 'restore.pdf', { displayName: 'Восстановление', visibility: 'ORGANIZATION', folderId: folder.id, inheritAccess: true })
  await deleteDocument(owner, org, doc.id)
  await assert.rejects(deleteFolder(owner, org, folder.id), code('FOLDER_NOT_EMPTY'))
  await assert.rejects(restoreDocument(outsider, org, doc.id), code('DOCUMENT_NOT_FOUND'))
  await restoreDocument(owner, org, doc.id)
  assert.equal((await getDocument(employee, org, doc.id)).folderId, folder.id)
  await assert.rejects(getDocument(outsider, org, doc.id), code('DOCUMENT_NOT_FOUND'))
  await deleteDocument(owner, org, doc.id); await purgeDocumentFile(owner, org, doc.id)
  await assert.rejects(restoreDocument(owner, org, doc.id), code('DOCUMENT_FILE_REMOVED'))
})

it('keeps legacy private files in the same library without disclosing other employees folders or mixing namesakes', async () => {
  const own = await uploadDocument(owner, org, pdf, 'application/pdf', 'one.pdf', { displayName: 'Первый', visibility: 'PRIVATE_MEMBER', targetMemberId: member, folderId: null })
  const other = await uploadDocument(owner, org, pdf, 'application/pdf', 'two.pdf', { displayName: 'Второй', visibility: 'PRIVATE_MEMBER', targetMemberId: otherMember, folderId: null })
  const [first, second] = await Promise.all([prisma.document.findUniqueOrThrow({ where: { id: own.id } }), prisma.document.findUniqueOrThrow({ where: { id: other.id } })])
  assert.notEqual(first.folderId, second.folderId)
  const child = await prisma.documentFolder.findUniqueOrThrow({ where: { id: first.folderId! } })
  // System child ACL remains editable without attempting to move it into its system parent.
  await saveFolder(owner, org, child.id, { name: child.name, parentId: child.parentId, visibility: 'SELECTED', audienceMemberIds: [member] })
  await assert.rejects(saveFolder(owner, org, undefined, { name: 'Ручная подпапка', parentId: child.parentId }), code('SYSTEM_FOLDER'))

  const folders = (await list(employee)).folders
  assert.ok(folders.some(folder => folder.id === first.folderId)); assert.ok(!folders.some(folder => folder.id === second.folderId))
  assert.equal((await getDocument(employee, org, own.id)).id, own.id)
  await assert.rejects(getDocument(employee, org, other.id), code('DOCUMENT_NOT_FOUND'))
})
