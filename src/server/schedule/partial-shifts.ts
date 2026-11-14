import { requireSubscriptionWritable, requireLocationInPlan } from '../subscriptions/access.ts'
import { checkMonthlyWorkload } from './workload.ts'
import { z } from 'zod'
import { Prisma, type ShiftOffer, type WorkShift } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { hasPermission, requirePermission } from '../organizations/access/access.ts'
import { lockShift, cancelShiftRequests } from '../requests/shift-conflicts.ts'
import { eligible, shiftSnapshot, transaction, notice, closeOffer, publicOffer, offerInclude } from './offer-service.ts'
import { recordShiftNotification } from '../organizations/notification-service.ts'
import { mutatePlannedShift, shiftInclude } from './service.ts'

export const partialOfferBody = z.object({
  sourceShiftId: z.uuid(), creationKey: z.uuid(), expectedUpdatedAt: z.iso.datetime(),
  firstEndAt: z.iso.datetime(), replacementStartAt: z.iso.datetime(),
  firstBreakMinutes: z.number().int().min(0), replacementBreakMinutes: z.number().int().min(0),
  recipientMemberId: z.uuid().nullable().default(null), direct: z.boolean().default(false),
  reason: z.string().trim().min(3).max(500), acknowledgeWorkload: z.boolean().default(false), openingHoursConfirmation: z.string().optional(),
}).strict()

type PartialData = z.infer<typeof partialOfferBody> & { prepared: boolean; sourceVersion: string; sourceState: string; replacementShiftId?: string }
function sourceState(shift: WorkShift) {
  return JSON.stringify([shift.memberId, shift.locationId, shift.scheduledStartAt, shift.scheduledEndAt,
    shift.breakMinutes, shift.actualStartAt, shift.actualEndAt, shift.actualBreakMinutes,
    shift.attendance, shift.positionId, shift.description, shift.status])
}
export function partialData(offer: ShiftOffer): PartialData | null {
  return offer.partial ? offer.partial as unknown as PartialData : null
}
export function offeredShift(offer: ShiftOffer, source: WorkShift): WorkShift {
  const partial = partialData(offer)
  if (!partial) return source
  const snapshot = offer.sourceSnapshot as unknown as ReturnType<typeof shiftSnapshot>
  return { ...source, scheduledStartAt: new Date(partial.replacementStartAt), scheduledEndAt: new Date(snapshot.endAt), breakMinutes: partial.replacementBreakMinutes }
}
function conflict(message: string): never { throw new ApiError(409, 'PARTIAL_SHIFT_CHANGED', message) }

async function prepare(tx: Prisma.TransactionClient, source: WorkShift, data: PartialData, actorId: string) {
  const start = source.actualStartAt ?? source.scheduledStartAt
  const end = new Date(data.firstEndAt)
  if (end <= start || end > new Date() || end >= source.scheduledEndAt || source.attendance === 'NO_SHOW') {
    conflict('Укажите прошедший интервал первого сотрудника внутри начавшейся смены.')
  }
  if (data.firstBreakMinutes >= (+end - +start) / 60000) conflict('Перерыв первого сотрудника должен быть короче его работы.')
  if (source.actualEndAt && source.actualEndAt > end) conflict('Уже учтённое время выходит за границу замены. Сначала проверьте фактическое время.')
  const changed = await tx.workShift.update({ where: { id: source.id }, data: {
    scheduledEndAt: end, breakMinutes: data.firstBreakMinutes,
    actualStartAt: start, actualEndAt: end, actualBreakMinutes: data.firstBreakMinutes,
    attendance: 'PARTIAL', attendanceReason: data.reason, replacementCutoffAt: end,
  }, include: shiftInclude })
  await tx.workShiftAdjustment.create({ data: {
    shiftId: source.id, changedByMemberId: actorId, kind: 'PARTIAL_REPLACEMENT', reason: data.reason,
    previousStartAt: source.scheduledStartAt, previousEndAt: source.scheduledEndAt, previousBreakMinutes: source.breakMinutes,
    newStartAt: changed.scheduledStartAt, newEndAt: end, newBreakMinutes: changed.breakMinutes,
  } })
  const point = await tx.organizationLocation.findUniqueOrThrow({ where: { id: source.locationId } })
  await recordShiftNotification(tx, changed, 'SHIFT_CHANGED', point.timezone, source, actorId)
  await cancelShiftRequests(tx, source.organizationId, [source.id], actorId, 'Часть смены передаётся замене.')
  return changed
}

export async function validatePartial(tx: Prisma.TransactionClient, offer: ShiftOffer, source: WorkShift) {
  const data = partialData(offer)!
  if (source.status !== 'SCHEDULED' || sourceState(source) !== data.sourceState) conflict('Исходная смена изменена. Проверьте оставшийся интервал.')
  const point = await tx.organizationLocation.findUniqueOrThrow({ where: { id: source.locationId } })
  if (point.archivedAt || point.timezone !== (offer.sourceSnapshot as {timezone:string}).timezone) conflict('Условия точки изменились.')
  if ((offer.acceptedByMemberId ?? offer.recipientMemberId) === source.memberId) conflict('Остаток должен принять другой сотрудник.')
  const result = offeredShift(offer, source)
  if (result.scheduledEndAt <= new Date()) conflict('Оставшаяся часть смены уже завершилась.')
  if (result.scheduledStartAt < new Date(data.firstEndAt) || result.scheduledStartAt >= result.scheduledEndAt) conflict('Проверьте время выхода замены.')
  if (offer.acceptedByMemberId ?? offer.recipientMemberId) await eligible(tx, result, (offer.acceptedByMemberId ?? offer.recipientMemberId)!, [source.id])
  return result
}

export async function completePartial(tx: Prisma.TransactionClient, offer: ShiftOffer, virtual: WorkShift, accepterId: string, reviewerId: string | null, openingHoursConfirmation?: string) {
  const data = partialData(offer)!
  const actorMemberId = reviewerId ?? offer.initiatorMemberId
  const member = await tx.organizationMember.findUniqueOrThrow({ where: { id: actorMemberId } })
  const actor = await getMembership(member.userId, offer.organizationId, tx)
  if (!data.prepared) {
    requirePermission(actor, 'schedule.actual', offer.locationId)
    requirePermission(actor, 'schedule.edit', offer.locationId)
  }
  const source = await tx.workShift.findUniqueOrThrow({ where: { id: offer.sourceShiftId } })
  await closeOffer(tx, offer, 'COMPLETED', 'Оставшаяся часть смены назначена замене.', {
    acceptedByMemberId: accepterId, acceptedAt: offer.acceptedAt ?? new Date(),
    ...(reviewerId ? { reviewedByMemberId: reviewerId, reviewedAt: new Date() } : {}),
  })
  const preparedSource = data.prepared ? source : await prepare(tx, source, data, actor.id)
  // Common mutation checks point quotas, opening hours, absence, position and emits assignment notices.
  const { changed } = await mutatePlannedShift(tx, actor, {
    input: { memberId: accepterId, startDate: '', startTime: '', endDate: '', endTime: '',
      openingHoursConfirmation, breakMinutes: virtual.breakMinutes, positionId: virtual.positionId, description: virtual.description },
    startAt: virtual.scheduledStartAt, endAt: virtual.scheduledEndAt,
  })
  await tx.workShift.update({ where: { id: changed.id }, data: { replacementOfId: source.id, replacementFloorAt: new Date(data.firstEndAt) } })
  await tx.workShiftAdjustment.create({ data: {
    shiftId: changed.id, changedByMemberId: actor.id, kind: 'PARTIAL_REPLACEMENT', reason: data.reason,
    previousStartAt: virtual.scheduledStartAt, previousEndAt: virtual.scheduledEndAt, previousBreakMinutes: virtual.breakMinutes,
    newStartAt: changed.scheduledStartAt, newEndAt: changed.scheduledEndAt, newBreakMinutes: changed.breakMinutes,
  } })
  await tx.shiftOffer.update({ where: { id: offer.id }, data: { partial: { ...data, prepared: true, sourceVersion: preparedSource.updatedAt.toISOString(), sourceState: sourceState(preparedSource), replacementShiftId: changed.id } } })
}

export async function createPartialOffer(userId: string, organizationId: string, input: z.infer<typeof partialOfferBody>) {
  return transaction(organizationId, async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    const prior = await tx.shiftOffer.findUnique({ where: { creationKey: input.creationKey }, include: offerInclude })
    if (prior) {
      const old = partialData(prior)!
      if (prior.organizationId !== organizationId || prior.initiatorMemberId !== actor.id || Object.keys(input).some(key => input[key as keyof typeof input] !== old[key as keyof typeof input])) conflict('Ключ запроса уже использован с другими данными.')
      return publicOffer(prior, actor)
    }
    await requireSubscriptionWritable(tx, organizationId)
    await requireLocationInPlan(tx, organizationId, actor.locationId)
    await lockShift(tx, input.sourceShiftId)
    const source = await tx.workShift.findFirst({ where: { id: input.sourceShiftId, organizationId, locationId: actor.locationId, status: 'SCHEDULED' } })
    if (!source) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
    const manager = hasPermission(actor, 'schedule.actual', source.locationId) && hasPermission(actor, 'schedule.edit', source.locationId)
    if (!manager) {
      requirePermission(actor, 'offers.transfer', source.locationId)
      if (source.memberId !== actor.id || input.direct) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Можно предложить только остаток своей смены.')
    }
    if (actor.organization.shiftTransferMode === 'DISABLED') throw new ApiError(403, 'OFFERS_DISABLED', 'Передача смен выключена владельцем.')
    if (source.updatedAt.toISOString() !== input.expectedUpdatedAt) conflict('Смена уже изменилась. Обновите карточку.')
    const previous = source.replacementCutoffAt ? await tx.shiftOffer.findFirst({ where: { sourceShiftId: source.id, partial: { not: Prisma.DbNull } }, orderBy: { createdAt: 'desc' } }) : null
    const originalEnd = previous ? new Date((previous.sourceSnapshot as { endAt: string }).endAt) : source.scheduledEndAt
    if (source.scheduledStartAt >= new Date() || originalEnd <= new Date()) conflict('Выберите начавшуюся незавершённую смену.')
    if (source.replacementCutoffAt && source.replacementCutoffAt.toISOString() !== input.firstEndAt) conflict('Время завершённой части уже зафиксировано.')
    if (await tx.workShift.count({ where: { replacementOfId: source.id, status: 'SCHEDULED' } })) conflict('Остаток уже назначен. Откройте смену замены.')
    if (await tx.shiftOfferReservation.findUnique({ where: { shiftId: source.id } })) conflict('Смена уже участвует в предложении.')
    const start = new Date(input.replacementStartAt), end = originalEnd
    if (new Date(input.firstEndAt) <= (source.actualStartAt ?? source.scheduledStartAt) || new Date(input.firstEndAt) > new Date() || start < new Date(input.firstEndAt) || start >= end || input.replacementBreakMinutes >= (+end - +start) / 60000) conflict('Проверьте границы частей смены и перерывы.')
    if (input.firstBreakMinutes >= (+new Date(input.firstEndAt) - +(source.actualStartAt ?? source.scheduledStartAt)) / 60000) conflict('Проверьте перерыв первого сотрудника.')
    if (input.recipientMemberId === source.memberId) conflict('Выберите другого сотрудника.')
    if (input.direct && !input.recipientMemberId) conflict('Выберите замену.')
    const virtual = { ...source, scheduledStartAt: start, scheduledEndAt: end, breakMinutes: input.replacementBreakMinutes }
    if (input.recipientMemberId) await eligible(tx, virtual, input.recipientMemberId, [source.id])
    if (source.replacementCutoffAt && !manager) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Повторный поиск после фиксации ухода выполняет руководитель.')
    if (source.replacementCutoffAt && source.actualBreakMinutes !== input.firstBreakMinutes) conflict('Перерыв завершённой части уже зафиксирован.')
    const data: PartialData = { ...input, prepared: manager, sourceVersion: source.updatedAt.toISOString(), sourceState: sourceState(source) }
    if (manager && !source.replacementCutoffAt) {
      const prepared = await prepare(tx, source, data, actor.id)
      data.sourceVersion = prepared.updatedAt.toISOString()
      data.sourceState = sourceState(prepared)
    }
    const offer = await tx.shiftOffer.create({ data: {
      organizationId, locationId: source.locationId, initiatorMemberId: actor.id,
      sourceShiftId: source.id, recipientMemberId: input.recipientMemberId, kind: 'TRANSFER',
      mode: manager ? actor.organization.shiftTransferMode : 'APPROVAL',
      sourceSnapshot: shiftSnapshot(virtual, actor.location.timezone), partial: data,
      creationKey: input.creationKey, comment: input.reason,
    } })
    await tx.shiftOfferReservation.create({ data: { organizationId, shiftId: source.id, offerId: offer.id } })
    if (input.direct) {
      await checkMonthlyWorkload(tx, organizationId, input.recipientMemberId!, actor.location.timezone, actor.location.monthlyWorkMinutes, [{ start, end }], [], input.acknowledgeWorkload)
      await completePartial(tx, offer, virtual, input.recipientMemberId!, actor.id, input.openingHoursConfirmation)
    }
    else {
      const candidates = await tx.organizationMember.findMany({ where: { organizationId, leftAt: null, id: input.recipientMemberId ? input.recipientMemberId : { notIn: [source.memberId, actor.id] } }, select: { id: true } })
      const recipients: string[] = []
      for (const candidate of candidates) {
        try { await eligible(tx, virtual, candidate.id, [source.id]); recipients.push(candidate.id) }
        catch (error) { if (!(error instanceof ApiError)) throw error }
      }
      await notice(tx, offer, 'SHIFT_OFFER_CREATED', recipients, 'Нужна замена на остаток смены', input.reason)
    }
    return publicOffer(await tx.shiftOffer.findUniqueOrThrow({ where: { id: offer.id }, include: offerInclude }), actor)
  })
}
