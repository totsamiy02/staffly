import { prisma } from './db.ts'
import { listSchedule } from './schedule/service.ts'

// Warm the query compiler and calendar projection before the instance becomes
// ready. No fixture accounts, tokens, mail or business mutations are created.
export async function warmReadPaths() {
  const organizations = await prisma.organization.findMany({ where: { deletedAt: null }, take: 3,
    select: { id: true, members: { where: { leftAt: null, user: { deletedAt: null, emailVerifiedAt: { not: null } } },
      orderBy: { role: 'asc' }, take: 1, select: { userId: true } }, accessRoles: { take: 1, select: { id: true } } } })
  const from = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
  const to = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10)
  for (let round = 0; round < 30; round++) {
    for (const org of organizations) {
      if (!org.members[0] || !org.accessRoles.length) continue
      try { await listSchedule(org.members[0].userId, org.id, from, to) }
      catch (error) { if (error && typeof error === 'object' && 'status' in error && [403,404].includes(Number(error.status))) continue; throw error }
    }
  }
}
