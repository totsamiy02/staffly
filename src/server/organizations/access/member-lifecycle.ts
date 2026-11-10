import type { Prisma } from '../../../generated/prisma/client.ts'

// Call within the membership lifecycle transaction and its organization lock.
// Preserve historical records while ending every source of current access.
export async function revokeMemberAccess(db: Prisma.TransactionClient, organizationId: string, memberId: string, now: Date) {
  const member = { organizationId, memberId }
  await db.locationMember.updateMany({ where: { ...member, leftAt: null }, data: { leftAt: now } })
  await db.locationTeamMember.deleteMany({ where: member })
  await db.accessAssignment.deleteMany({ where: member })
  await db.locationTransfer.updateMany({ where: { ...member, temporary: true, revokedAt: null, endAt: { gt: now } }, data: { revokedAt: now } })
  await db.organizationMember.update({ where: { id: memberId, organizationId }, data: { accessRoleId: null, accessConfigured: true } })
}
