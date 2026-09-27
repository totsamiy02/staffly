import type { Prisma } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { startOfZonedDate, zonedParts } from './timezone.ts'

// Month attribution follows existing statistics: scheduled start; actual time takes precedence.
export async function checkMonthlyWorkload(tx: Prisma.TransactionClient, organizationId: string, memberId: string, timezone: string, limit: number | null, additions: Array<{ start: Date; end: Date }>, excludedIds: string[] = [], acknowledged = false) {
  limit = (await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { monthlyWorkMinutes: true } })).monthlyWorkMinutes
  if (!limit) return []
  const warnings: Array<{ month: string; minutes: number; limit: number }> = []
  const monthOf = (date: Date) => { const p = zonedParts(date, timezone); return String(p.year) + '-' + String(p.month).padStart(2, '0') }
  for (const month of new Set(additions.map(item => monthOf(item.start)))) {
    const from = startOfZonedDate(month + '-01', timezone)
    const [year, number] = month.split('-').map(Number)
    const next = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10)
    const shifts = await tx.workShift.findMany({ where: { organizationId, memberId, status: 'SCHEDULED', id: { notIn: excludedIds }, scheduledStartAt: { gte: from, lt: startOfZonedDate(next, timezone) } } })
    const minutes = shifts.reduce((sum, shift) => sum + Math.floor(((shift.actualEndAt ?? shift.scheduledEndAt).getTime() - (shift.actualStartAt ?? shift.scheduledStartAt).getTime()) / 60000), 0)
      + additions.filter(item => monthOf(item.start) === month).reduce((sum, item) => sum + Math.floor((item.end.getTime() - item.start.getTime()) / 60000), 0)
    if (minutes > limit) warnings.push({ month, minutes, limit })
  }
  if (warnings.length && !acknowledged) throw new ApiError(409, 'WORKLOAD_WARNING', warnings.map(item => item.month + ': ' + (item.minutes / 60).toFixed(1) + ' ч при норме ' + (item.limit / 60).toFixed(1) + ' ч.').join(' ') + ' Подтвердите превышение нормы.', { warnings })
  return warnings
}
