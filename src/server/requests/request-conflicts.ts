import { Prisma } from '../../generated/prisma/client.ts'

import type { RequestSystemCode } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'

import { addCalendarDays,startOfZonedDate } from '../schedule/timezone.ts'

import { absenceCodes,dateText } from './request-input.ts'

export async function conflictsFor(item: { organizationId: string; createdByMemberId: string; startDate: Date | null; endDate: Date | null; systemCodeSnapshot: RequestSystemCode | null }, timezone: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  if (!item.systemCodeSnapshot || !absenceCodes.includes(item.systemCodeSnapshot) || !item.startDate || !item.endDate) return []
  const from = startOfZonedDate(dateText(item.startDate)!, timezone)
  const to = startOfZonedDate(addCalendarDays(dateText(item.endDate)!, 1), timezone)
  return client.workShift.findMany({ where: { organizationId: item.organizationId, memberId: item.createdByMemberId, status: 'SCHEDULED', scheduledStartAt: { lt: to }, scheduledEndAt: { gt: from }, AND: [{ scheduledEndAt: { gt: new Date() } }] }, orderBy: { scheduledStartAt: 'asc' }, select: { id: true, locationId: true, scheduledStartAt: true, scheduledEndAt: true } })
}
