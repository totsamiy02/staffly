import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { memberIdentityWhere } from '../access/member-policy.ts'
import { ApiError } from '../api-error.ts'

export async function canReadAvatar(userId: string, fileId: string) {
  const owner = await prisma.user.findFirst({ where: { avatarFileId: fileId, deletedAt: null }, select: { id: true } })
  if (!owner) return false
  if (owner.id === userId) return true
  const memberships = await prisma.organizationMember.findMany({ where: { userId, leftAt: null, organization: { deletedAt: null, members: { some: { userId: owner.id, leftAt: null } } } }, select: { organizationId: true } })
  for (const membership of memberships) {
    let actor
    try { actor = await getMembership(userId, membership.organizationId) }
    catch (error) { if (error instanceof ApiError && error.status === 404) continue; throw error }
    if (await prisma.organizationMember.count({ where: { AND: [memberIdentityWhere(actor, undefined, false), { userId: owner.id, leftAt: null }] } })) return true
  }
  return false
}
