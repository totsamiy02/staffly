import type { Prisma } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'

export function assertCustomFolder(folder: { systemKey: string | null }) {
  if (folder.systemKey) throw new ApiError(409, 'SYSTEM_FOLDER', 'Системную папку нельзя удалить, переименовать или переместить.')
}
export async function employeeFolder(tx: Prisma.TransactionClient, organizationId: string, locationId: string | null, memberId: string) {
  const rootKey = 'employees:' + (locationId ?? 'shared')
  const root = await tx.documentFolder.upsert({ where: { organizationId_systemKey: { organizationId, systemKey: rootKey } }, create: { organizationId, locationId, name: 'Документы сотрудников', systemKey: rootKey }, update: {} })
  const member = await tx.organizationMember.findFirstOrThrow({ where: { organizationId, id: memberId }, include: { user: { select: { firstName: true, lastName: true, middleName: true, email: true } } } })
  const name = [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || member.user.email
  const systemKey = 'employee:' + root.id + ':' + member.id
  return tx.documentFolder.upsert({ where: { organizationId_systemKey: { organizationId, systemKey } }, create: { organizationId, locationId, parentId: root.id, name: name.slice(0,160), systemKey, visibility: 'SELECTED', audienceMemberIds: [memberId] }, update: { name: name.slice(0,160) } })
}
