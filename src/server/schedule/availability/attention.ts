import type { Prisma } from '../../../generated/prisma/client.ts'
import type { AttentionItem } from '../../../shared/attention.ts'
import { hasPermission, type PermissionActor } from '../../organizations/access/access.ts'
import { issueForAssignment, loadAvailabilityRecords, validAvailabilityOverride } from './checks.ts'

export async function availabilityAttention(db: Prisma.TransactionClient, actor: PermissionActor, pointId?: string): Promise<AttentionItem[]> {
  if (!actor.owner && !actor.permissions?.includes('availability.view')) return []
  const records = await loadAvailabilityRecords(db, actor.organizationId)
  if (!records.size) return []
  const shifts = await db.workShift.findMany({
    where: {
      organizationId: actor.organizationId, memberId: { in: [...records.keys()] }, status: 'SCHEDULED',
      scheduledStartAt: { gt: new Date() }, actualStartAt: null, actualEndAt: null,
      actualBreakMinutes: null, attendance: 'UNCONFIRMED',
      location: { archivedAt: null }, ...(pointId ? { locationId: pointId } : {}),
    },
    include: { location: true, member: { include: { user: { select: { firstName: true, lastName: true, middleName: true } } } } },
    orderBy: [{ scheduledStartAt: 'asc' }, { id: 'asc' }],
  })
  const groups = new Map<string, { first: typeof shifts[number]; count: number }>()
  for (const shift of shifts) {
    if (!hasPermission(actor, 'availability.view', shift.locationId) || !hasPermission(actor, 'schedule.edit', shift.locationId)) continue
    if (validAvailabilityOverride(shift.availabilityOverride, shift.memberId, shift.scheduledStartAt, shift.scheduledEndAt)) continue
    const record = records.get(shift.memberId)!
    if (!issueForAssignment(record, { memberId: shift.memberId, locationId: shift.locationId, start: shift.scheduledStartAt, end: shift.scheduledEndAt })) continue
    const group = groups.get(shift.memberId)
    if (group) group.count++
    else groups.set(shift.memberId, { first: shift, count: 1 })
  }
  return [...groups].map(([memberId, { first, count }]) => ({
    id: `availability:${memberId}`, sourceId: memberId, kind: 'AVAILABILITY', scope: 'control',
    title: [first.member.user.lastName, first.member.user.firstName, first.member.user.middleName].filter(Boolean).join(' ') || 'Сотрудник',
    subtitle: 'Изменилась доступность для смен', locationId: first.locationId, locationName: first.location.name,
    timezone: first.location.timezone, dueAt: first.scheduledStartAt.toISOString(), deadlineDay: null,
    overdue: false, blocked: false, reason: `Смен вне доступности: ${count}`, action: 'Проверить смены',
    href: `/app/organizations/${actor.organizationId}/schedule?availability=${memberId}&availabilityConflicts=1&location=${first.locationId}`,
  }))
}
