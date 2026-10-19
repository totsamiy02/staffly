import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '../../generated/prisma/client.ts'
import type { DeparturePreview, DepartureResult } from '../../app/organizations/departure.ts'
import type { DemandWeek, DemandInterval } from '../../app/schedule/planning/team-planning-types.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from './access/permissions.ts'
import { hasPermission, requirePermission } from './access/access.ts'
import { locationContext } from './location-context.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { eligible, closeOffer } from '../schedule/offer-service.ts'
import { mutatePlannedShift } from '../schedule/service.ts'
import { checkMonthlyWorkload } from '../schedule/workload.ts'
import { calculateCoverage } from '../schedule/planning/coverage.ts'
import { addCalendarDays, startOfZonedDate } from '../schedule/timezone.ts'
import { zonedDateAndTime } from '../../app/schedule/date-utils.ts'

export const departureScope = z.enum(['organization', 'location'])
export const departureBody = z.object({
  scope: departureScope, token: z.string().length(64), reason: z.string().trim().max(500),
  choices: z.array(z.object({ shiftId: z.uuid(), action: z.enum(['cancel', 'reassign']), memberId: z.uuid().optional() })).max(5000),
  keepCurrent: z.boolean().default(false), acknowledgeDrafts: z.boolean().default(false), acknowledgeWorkload: z.boolean().default(false),
})
type DB = Prisma.TransactionClient
const name = (u: { firstName: string | null; lastName: string | null; middleName: string | null; email: string }) => [u.lastName, u.firstName, u.middleName].filter(Boolean).join(' ') || u.email.split('@')[0]
const stale = () => new ApiError(409, 'DEPARTURE_CHANGED', 'Данные изменились. Обновите предпросмотр и проверьте последствия ещё раз.')

async function snapshot(tx: DB, userId: string, organizationId: string, memberId: string, scope: 'organization' | 'location') {
  const actor = await getMembership(userId, organizationId, tx)
  requirePermission(actor, scope === 'organization' ? 'members.exclude' : 'members.remove', scope === 'organization' ? null : actor.locationId)
  const target = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null }, include: { user: true, locationMemberships: { where: { leftAt: null }, include: { location: true }, orderBy: { locationId: 'asc' } }, accessAssignments: { orderBy: { locationId: 'asc' } } } })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
  if (target.role === 'OWNER' || target.id === actor.id) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Владельца и собственную учётную запись нельзя исключить здесь.')
  const placement = target.locationMemberships.find(p => p.locationId === actor.locationId)
  if (scope === 'location' && !placement) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не назначен в эту точку.')
  if (scope === 'location' && actor.organizationRole !== 'OWNER' && placement?.role === 'ADMIN') throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Этого участника нельзя убрать из точки.')
  const where = { organizationId, ...(scope === 'location' ? { locationId: actor.locationId } : {}) }
  const now = new Date()
  const shifts = await tx.workShift.findMany({ where: { ...where, memberId, status: 'SCHEDULED', scheduledEndAt: { gt: now } }, include: { location: true }, orderBy: [{ scheduledStartAt: 'asc' }, { id: 'asc' }] })
  const requests = await tx.organizationRequest.findMany({ where: { ...where, OR: [{ createdByMemberId: memberId }, { relatedShiftId: { in: shifts.filter(s => s.scheduledStartAt > now).map(s => s.id) } }], status: 'PENDING' }, select: { id: true, updatedAt: true, relatedShiftId: true } , orderBy: { id: 'asc' } })
  const offers = await tx.shiftOffer.findMany({ where: { ...where, status: { in: ['PENDING', 'AWAITING_APPROVAL'] }, OR: [{ initiatorMemberId: memberId }, { recipientMemberId: memberId }, { acceptedByMemberId: memberId }, { sourceShiftId: { in: shifts.map(s => s.id) } }, { targetShiftId: { in: shifts.map(s => s.id) } }] }, orderBy: { id: 'asc' } })
  const drafts = await tx.scheduleDraft.findMany({ where: { ...where, status: { in: ['PREPARING', 'OPEN', 'CLOSED'] }, OR: [{ recipients: { some: { memberId } } }, { proposals: { some: { proposed: { path: ['memberId'], equals: memberId } } } }, { proposals: { some: { source: { path: ['memberId'], equals: memberId } } } }] }, select: { id: true, title: true, revision: true, updatedAt: true, locationId: true }, orderBy: { id: 'asc' } })
  const acknowledgements = await tx.documentAcknowledgement.findMany({ where: { memberId, acknowledgedAt: null, cancelledAt: null, document: where }, select: { id: true }, orderBy: { id: 'asc' } })
  const transfers = await tx.locationTransfer.findMany({ where: { organizationId, memberId, temporary: true, revokedAt: null, endAt: { gt: now }, ...(scope === 'location' ? { toLocationId: actor.locationId } : {}) }, orderBy: { id: 'asc' } })
  const coverageLocations = [...new Set(shifts.filter(s => s.location.coverageEnabled && hasPermission(actor, 'coverage.view', s.locationId)).map(s => s.locationId))]
  const coverageState = coverageLocations.length ? {
    versions: await tx.demandVersion.findMany({ where: { locationId: { in: coverageLocations } }, orderBy: { id: 'asc' } }),
    exceptions: await tx.demandException.findMany({ where: { locationId: { in: coverageLocations } }, orderBy: { id: 'asc' } }),
    shifts: await tx.workShift.findMany({ where: { locationId: { in: coverageLocations }, status: 'SCHEDULED', scheduledEndAt: { gt: now } }, select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }),
  } : null
  // The token binds the exact affected state, including time-boundary transitions.
  const token = createHash('sha256').update(JSON.stringify({ scope, locationId: scope === 'location' ? actor.locationId : null, target: { id: target.id, role: target.role, accessRoleId: target.accessRoleId, accessConfigured: target.accessConfigured, placements: target.locationMemberships, access: target.accessAssignments }, shifts: shifts.map(s => ({ ...s, current: s.scheduledStartAt <= now })), requests, offers, drafts, acknowledgements, transfers, coverageState })).digest('hex')
  return { actor, target, shifts, requests, offers, drafts, acknowledgements, transfers, token, now }
}

async function coverageImpact(tx: DB, data: Awaited<ReturnType<typeof snapshot>>): Promise<DeparturePreview['coverage']> {
  const result: DeparturePreview['coverage'] = []
  for (const locationId of new Set(data.shifts.map(s => s.locationId))) {
    const affected = data.shifts.filter(s => s.locationId === locationId && s.scheduledStartAt > data.now)
    const point = affected[0]?.location
    if (!point?.coverageEnabled || !hasPermission(data.actor, 'coverage.view', locationId)) continue
    const versions = await tx.demandVersion.findMany({ where: { locationId }, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] })
    const exceptions = await tx.demandException.findMany({ where: { locationId } })
    const positions = await tx.organizationPosition.findMany({ where: { organizationId: point.organizationId }, select: { id: true, name: true } })
    const dates = new Set<string>()
    for (const shift of affected) {
      const end = zonedDateAndTime(shift.scheduledEndAt.toISOString(), point.timezone).date
      for (let date = zonedDateAndTime(shift.scheduledStartAt.toISOString(), point.timezone).date; date <= end; date = addCalendarDays(date, 1)) dates.add(date)
    }
    for (const date of dates) {
      const next = addCalendarDays(date, 1)
      const shifts = await tx.workShift.findMany({ where: { locationId, status: 'SCHEDULED', scheduledStartAt: { lt: startOfZonedDate(next, point.timezone) }, scheduledEndAt: { gt: startOfZonedDate(date, point.timezone) } } })
      const [day] = calculateCoverage(date, next, point.timezone, versions.map(v => ({ effectiveFrom: v.effectiveFrom.toISOString().slice(0, 10), days: v.days as DemandWeek })), exceptions.map(e => ({ date: e.date.toISOString().slice(0, 10), intervals: e.intervals as DemandInterval[] })), shifts, positions)
      for (const segment of day.segments) {
        const start = +new Date(segment.startAt), end = +new Date(segment.endAt)
        const candidates = affected.filter(s => s.attendance !== 'NO_SHOW' && s.positionId === segment.positionId && +(s.actualStartAt ?? s.scheduledStartAt) < end && +(s.actualEndAt ?? s.scheduledEndAt) > start)
        const boundaries = [...new Set([start, end, ...candidates.flatMap(s => [Math.max(start, +(s.actualStartAt ?? s.scheduledStartAt)), Math.min(end, +(s.actualEndAt ?? s.scheduledEndAt))])])].sort((a, b) => a - b)
        for (let i = 0; i < boundaries.length - 1; i++) {
          const ids = candidates.filter(s => +(s.actualStartAt ?? s.scheduledStartAt) < boundaries[i + 1] && +(s.actualEndAt ?? s.scheduledEndAt) > boundaries[i]).map(s => s.id)
          if (ids.length && segment.needed >= segment.assigned && segment.needed > 0) result.push({ locationId, locationName: point.name, timezone: point.timezone, date, startAt: new Date(boundaries[i]).toISOString(), endAt: new Date(boundaries[i + 1]).toISOString(), positionName: segment.positionName, needed: segment.needed, assigned: segment.assigned, shiftIds: ids })
        }
      }
    }
  }
  return result
}

export async function previewDeparture(userId: string, organizationId: string, memberId: string, scope: 'organization' | 'location'): Promise<DeparturePreview> {
  return prisma.$transaction(async tx => {
    const data = await snapshot(tx, userId, organizationId, memberId, scope)
    const { actor, target, shifts, now } = data
    const futureIds = new Set(shifts.filter(s => s.scheduledStartAt > now).map(s => s.id))
    return {
      token: data.token, scope, locationId: actor.locationId, locationName: actor.location.name,
      member: { id: target.id, name: name(target.user), avatarUrl: mediaUrl(target.user.avatarFileId) },
      shifts: shifts.map(s => ({ id: s.id, locationId: s.locationId, locationName: s.location.name, timezone: s.location.timezone, startAt: s.scheduledStartAt.toISOString(), endAt: s.scheduledEndAt.toISOString(), positionName: s.positionNameSnapshot, minutes: Math.floor((+s.scheduledEndAt - +s.scheduledStartAt) / 60000), canCancel: hasPermission(actor, 'schedule.cancel', s.locationId), canReassign: hasPermission(actor, 'schedule.edit', s.locationId), hasActual: !!(s.actualStartAt || s.actualEndAt || s.actualBreakMinutes !== null || s.attendance !== 'UNCONFIRMED'), current: s.scheduledStartAt <= now })),
      pendingRequests: data.requests.filter(r => !r.relatedShiftId || !futureIds.has(r.relatedShiftId)).length,
      closingRequests: data.requests.filter(r => r.relatedShiftId && futureIds.has(r.relatedShiftId)).length,
      offers: data.offers.length, acknowledgements: data.acknowledgements.length,
      drafts: data.drafts.map(d => ({ id: d.id, title: d.title, locationId: d.locationId, canOpen: hasPermission(actor, 'drafts.edit', d.locationId) })),
      remainingLocations: target.locationMemberships.filter(p => p.locationId !== actor.locationId && !p.location.archivedAt).map(p => p.location.name),
      globalAccessRemains: scope === 'location' && !!target.accessRoleId,
      coverage: await coverageImpact(tx, data),
    }
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 })
}

export async function departureCandidates(userId: string, organizationId: string, memberId: string, scope: 'organization' | 'location', shiftId: string, search: string, page: number) {
  return prisma.$transaction(async tx => {
    const data = await snapshot(tx, userId, organizationId, memberId, scope)
    const shift = data.shifts.find(s => s.id === shiftId && s.scheduledStartAt > data.now)
    if (!shift) throw stale()
    requirePermission(data.actor, 'schedule.edit', shift.locationId)
    const people = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, id: { not: memberId }, user: { deletedAt: null, ...(search ? { OR: ['firstName', 'lastName', 'middleName', 'email'].map(key => ({ [key]: { contains: search, mode: 'insensitive' as const } })) } : {}) }, OR: [{ role: 'OWNER' }, { locationMemberships: { some: { locationId: shift.locationId, leftAt: null } } }, { locationTransfers: { some: { toLocationId: shift.locationId, temporary: true, revokedAt: null, startAt: { lte: data.now }, endAt: { gte: shift.scheduledEndAt } } } }] }, include: { user: true }, orderBy: { id: 'asc' }, skip: (page - 1) * 20, take: 21 })
    const candidates = []
    for (const person of people.slice(0, 20)) {
      let reason: string | null = null
      try { await eligible(tx, shift, person.id) } catch (error) { if (error instanceof ApiError) reason = error.message; else throw error }
      candidates.push({ id: person.id, name: name(person.user), reason })
    }
    return { candidates, hasMore: people.length > 20 }
  }, { timeout: 30000 })
}

export async function confirmDeparture(userId: string, organizationId: string, memberId: string, input: z.infer<typeof departureBody>): Promise<DepartureResult> {
  try {
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
      const data = await snapshot(tx, userId, organizationId, memberId, input.scope)
      if (data.token !== input.token) throw stale()
      const future = data.shifts.filter(s => s.scheduledStartAt > data.now), current = data.shifts.filter(s => s.scheduledStartAt <= data.now)
      if (current.length && !input.keepCurrent) throw new ApiError(409, 'CURRENT_SHIFT', 'Проверьте текущую смену и подтвердите сохранение учтённого времени.')
      if (data.drafts.length && !input.acknowledgeDrafts) throw new ApiError(409, 'DRAFTS_REVIEW', 'Проверьте назначения в предварительных графиках.')
      if (input.choices.length !== future.length || new Set(input.choices.map(c => c.shiftId)).size !== future.length || input.choices.some(c => !future.some(s => s.id === c.shiftId))) throw stale()
      if (input.choices.some(c => c.action === 'cancel') && input.reason.length < 3) throw new ApiError(400, 'REASON_REQUIRED', 'Укажите причину отмены смен (от 3 символов).')
      for (const shift of future) {
        const choice = input.choices.find(c => c.shiftId === shift.id)!
        requirePermission(data.actor, choice.action === 'cancel' ? 'schedule.cancel' : 'schedule.edit', shift.locationId)
        if (shift.actualStartAt || shift.actualEndAt || shift.actualBreakMinutes !== null || shift.attendance !== 'UNCONFIRMED') throw new ApiError(409, 'SHIFT_HAS_ACTUAL', 'У будущей смены есть учтённое время. Проверьте её в расписании перед исключением.')
        if (choice.action === 'reassign') {
          if (!choice.memberId || choice.memberId === memberId) throw new ApiError(400, 'REPLACEMENT_REQUIRED', 'Выберите другого сотрудника для каждой передаваемой смены.')
          await eligible(tx, shift, choice.memberId)
          const sibling = future.find(s => s.id !== shift.id && s.scheduledStartAt < shift.scheduledEndAt && s.scheduledEndAt > shift.scheduledStartAt && input.choices.some(c => c.shiftId === s.id && c.action === 'reassign' && c.memberId === choice.memberId))
          if (sibling) throw new ApiError(409, 'SHIFT_OVERLAP', 'Выбранному сотруднику передаются пересекающиеся смены.')
        }
      }
      for (const locationId of new Set(future.map(s => s.locationId))) {
        const point = future.find(s => s.locationId === locationId)!.location
        for (const replacement of new Set(input.choices.filter(c => c.action === 'reassign').map(c => c.memberId!))) {
          const additions = future.filter(s => input.choices.some(c => c.shiftId === s.id && c.memberId === replacement && c.action === 'reassign')).map(s => ({ start: s.scheduledStartAt, end: s.scheduledEndAt }))
          if (additions.length) await locationContext.run({ organizationId, locationId }, () => checkMonthlyWorkload(tx, organizationId, replacement, point.timezone, point.monthlyWorkMinutes, additions, [], input.acknowledgeWorkload))
        }
      }
      const reviewer = await tx.user.findUniqueOrThrow({ where: { id: userId } })
      const reason = input.reason || (input.scope === 'organization' ? 'Сотрудник исключён из организации' : 'Сотрудник убран из точки')
      for (const offer of data.offers) await closeOffer(tx, offer, 'CANCELLED', reason, { reviewedByMemberId: data.actor.id, reviewedAt: data.now })
      for (const shift of future) {
        const choice = input.choices.find(c => c.shiftId === shift.id)!
        await locationContext.run({ organizationId, locationId: shift.locationId }, async () => {
          const actor = await getMembership(userId, organizationId, tx)
          if (choice.action === 'reassign') {
            const replacement = await tx.organizationMember.findUniqueOrThrow({ where: { id: choice.memberId! }, include: { user: true } })
            await tx.workShiftAdjustment.create({ data: { shiftId: shift.id, changedByMemberId: actor.id, kind: 'TRANSFER', previousStartAt: shift.scheduledStartAt, previousEndAt: shift.scheduledEndAt, previousBreakMinutes: shift.breakMinutes, newStartAt: shift.scheduledStartAt, newEndAt: shift.scheduledEndAt, newBreakMinutes: shift.breakMinutes, reason: 'Переназначение при исключении сотрудника', assignmentChange: { previousMemberId: memberId, previousMemberName: name(data.target.user), newMemberId: replacement.id, newMemberName: name(replacement.user), initiatorMemberId: actor.id, reviewedByMemberId: actor.id, reviewedByMemberName: name(reviewer) } } })
          }
          await mutatePlannedShift(tx, actor, choice.action === 'cancel' ? { current: shift, reason } : { current: shift, startAt: shift.scheduledStartAt, endAt: shift.scheduledEndAt, input: { memberId: choice.memberId!, startDate: '', startTime: '', endDate: '', endTime: '', breakMinutes: shift.breakMinutes, positionId: shift.positionId, description: shift.description } })
        })
      }
      const scopeWhere = { organizationId, memberId, ...(input.scope === 'location' ? { locationId: data.actor.locationId } : {}) }
      await tx.locationMember.updateMany({ where: { ...scopeWhere, leftAt: null }, data: { leftAt: data.now } })
      await tx.locationTeamMember.deleteMany({ where: { organizationId, memberId, ...(input.scope === 'location' ? { team: { locationId: data.actor.locationId } } : {}) } })
      await tx.accessAssignment.deleteMany({ where: scopeWhere })
      // End temporary access too, without destroying transfer history.
      if (data.transfers.length) await tx.locationTransfer.updateMany({ where: { id: { in: data.transfers.map(t => t.id) } }, data: { revokedAt: data.now } })
      if (input.scope === 'organization') {
        await tx.organizationMember.update({ where: { id: memberId }, data: { leftAt: data.now } })
        await tx.documentAcknowledgement.updateMany({ where: { memberId, acknowledgedAt: null, cancelledAt: null, document: { organizationId } }, data: { cancelledAt: data.now } })
      }
      const result: DepartureResult = { scope: input.scope, locationId: data.actor.locationId, cancelled: input.choices.filter(c => c.action === 'cancel').length, reassigned: input.choices.filter(c => c.action === 'reassign').length, retainedCurrent: current.length }
      await tx.accessAudit.create({ data: { organizationId, actorMemberId: data.actor.id, action: input.scope === 'organization' ? 'MEMBER_EXCLUDED' : 'MEMBER_LOCATION_REMOVED', details: { memberId, name: name(data.target.user), actorName: name(reviewer), ...result, reason, choices: input.choices, keepCurrent: input.keepCurrent, drafts: data.drafts.map(d => d.id), revokedTransfers: data.transfers.map(t => t.id), previousShifts: future.map(s => ({ id: s.id, memberId: s.memberId, startAt: s.scheduledStartAt.toISOString(), endAt: s.scheduledEndAt.toISOString() })) } } })
      return result
    }, { isolationLevel: 'Serializable', timeout: 30000 })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2034') throw stale()
    if (String(error).includes('work_shifts_no_overlap')) throw new ApiError(409, 'SHIFT_OVERLAP', 'У выбранного сотрудника появилась пересекающаяся смена. Проверьте замену.')
    throw error
  }
}
