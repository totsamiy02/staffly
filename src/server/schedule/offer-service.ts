import { z } from 'zod'
import type { Prisma, ShiftOffer, WorkShift } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/permissions.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { cancelShiftRequests, lockShift } from '../requests/shift-conflicts.ts'
import { assertNoApprovedAbsence } from './service.ts'

export const offerModesBody = z.object({ transferMode: z.enum(['DISABLED', 'AUTO', 'APPROVAL']), swapMode: z.enum(['DISABLED', 'AUTO', 'APPROVAL']) })
export const offerBody = z.object({ sourceShiftId: z.string().uuid(), kind: z.enum(['TRANSFER', 'SWAP']), recipientMemberId: z.string().uuid().nullable().default(null), targetShiftId: z.string().uuid().nullable().default(null), comment: z.string().trim().max(500).nullable().default(null) }).refine(v => v.kind === 'SWAP' ? !!v.recipientMemberId && !!v.targetShiftId && v.targetShiftId !== v.sourceShiftId : !v.targetShiftId, 'Выберите коллегу и его смену для обмена.')
export const offerListQuery = z.object({ tab: z.enum(['mine', 'available', 'sent', 'approval']).default('mine'), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) })
export const offerActionBody = z.object({ action: z.enum(['accept', 'reject', 'cancel', 'approve', 'decline']) })
const active = ['PENDING', 'AWAITING_APPROVAL'] as const
const isActive = (offer: ShiftOffer) => active.some(s => s === offer.status)
const personInclude = { user: { select: { firstName: true, lastName: true, middleName: true, email: true, avatarFileId: true } } } as const
const include = { initiator: { include: personInclude }, recipient: { include: personInclude }, acceptedBy: { include: personInclude }, reviewedBy: { include: personInclude }, location: true } as const
function fail(code: string, message: string): never { throw new ApiError(409, code, message) }
const name = (user: { firstName: string | null; lastName: string | null; middleName: string | null; email: string }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email.split('@')[0]

// Same lock as schedule/location writes; SERIALIZABLE also protects absence and
// position writes that do not acquire that lock. Retry starts a fresh snapshot.
async function transaction<T>(organizationId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
        return work(tx)
      }, { isolationLevel: 'Serializable', timeout: 20000 })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'P2034' && attempt < 3) continue
      if (code === 'P2002' || code === 'P2034') fail('OFFER_CONFLICT', 'Расписание или предложение изменилось. Данные обновлены, повторите действие.')
      if (String(error).includes('work_shifts_no_overlap')) fail('SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена. Обновите расписание.')
      throw error
    }
  }
}

export function shiftSnapshot(shift: WorkShift, timezone: string) {
  return { id: shift.id, memberId: shift.memberId, locationId: shift.locationId, startAt: shift.scheduledStartAt.toISOString(), endAt: shift.scheduledEndAt.toISOString(), timezone, positionId: shift.positionId, positionName: shift.positionNameSnapshot, breakMinutes: shift.breakMinutes, description: shift.description }
}
function shiftReady(shift: WorkShift) {
  if (shift.status !== 'SCHEDULED' || shift.cancelledAt) fail('SHIFT_CANCELLED', 'Смена отменена и больше недоступна для передачи.')
  if (shift.scheduledStartAt <= new Date()) fail('SHIFT_STARTED', 'Смена уже началась. Передача и обмен недоступны.')
  if (shift.actualStartAt || shift.actualEndAt || shift.actualBreakMinutes !== null) fail('SHIFT_HAS_ACTUAL', 'У смены есть учтённое рабочее время. Передача недоступна.')
}
async function memberAccess(tx: Prisma.TransactionClient, shift: WorkShift, memberId: string) {
  const member = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId: shift.organizationId, leftAt: null, user: { deletedAt: null } }, include: personInclude })
  if (!member) fail('MEMBER_LEFT', 'Участник больше не состоит в организации.')
  const point = await tx.organizationLocation.findFirst({ where: { id: shift.locationId, organizationId: shift.organizationId, archivedAt: null } })
  if (!point) fail('LOCATION_UNAVAILABLE', 'Точка закрыта или недоступна.')
  if (member.role !== 'OWNER') {
    const permanent = await tx.locationMember.findFirst({ where: { locationId: point.id, memberId, leftAt: null } })
    const temporary = await tx.locationTransfer.findFirst({ where: { organizationId: shift.organizationId, memberId, toLocationId: point.id, temporary: true, startAt: { lte: new Date() }, endAt: { gt: new Date(), gte: shift.scheduledEndAt } } })
    if (!permanent && !temporary) fail('MEMBER_NOT_IN_LOCATION', 'Сотрудник не имеет действующего доступа к этой точке на период смены.')
  }
  return { member, point }
}
async function eligible(tx: Prisma.TransactionClient, shift: WorkShift, memberId: string, excluded: string[] = []) {
  const { member, point } = await memberAccess(tx, shift, memberId)
  if (shift.positionId && !await tx.memberPosition.findFirst({ where: { memberId, positionId: shift.positionId, position: { organizationId: shift.organizationId, isActive: true } } })) fail('POSITION_NOT_ASSIGNED', 'Сотруднику не назначена активная должность этой смены.')
  await assertNoApprovedAbsence(shift.organizationId, memberId, shift.scheduledStartAt, shift.scheduledEndAt, point.timezone, tx)
  if (await tx.workShift.findFirst({ where: { organizationId: shift.organizationId, memberId, id: { notIn: excluded }, status: 'SCHEDULED', scheduledStartAt: { lt: shift.scheduledEndAt }, scheduledEndAt: { gt: shift.scheduledStartAt } } })) fail('SHIFT_OVERLAP', 'У сотрудника уже есть пересекающаяся смена.')
  return member
}
function mode(organization: { shiftTransferMode: ShiftOffer['mode']; shiftSwapMode: ShiftOffer['mode'] }, kind: ShiftOffer['kind']) { return kind === 'TRANSFER' ? organization.shiftTransferMode : organization.shiftSwapMode }
async function notice(tx: Prisma.TransactionClient, offer: ShiftOffer, type: 'SHIFT_OFFER_CREATED' | 'SHIFT_OFFER_APPROVAL' | 'SHIFT_OFFER_RESULT', memberIds: string[], title: string, message: string) {
  const members = await tx.organizationMember.findMany({ where: { id: { in: [...new Set(memberIds)] }, organizationId: offer.organizationId, leftAt: null, user: { deletedAt: null } }, select: { id: true, userId: true } })
  if (members.length) await tx.accountNotification.createMany({ data: members.map(member => ({ organizationId: offer.organizationId, userId: member.userId, shiftOfferId: offer.id, type, title, message: message.slice(0, 500), shiftOfferDeliveryKey: `${offer.id}:${type}:${member.id}` })), skipDuplicates: true })
}
async function closeOffer(tx: Prisma.TransactionClient, offer: ShiftOffer, status: 'COMPLETED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'INVALID', reason: string, patch: Prisma.ShiftOfferUncheckedUpdateInput = {}) {
  if (!isActive(offer)) return offer
  const updated = await tx.shiftOffer.update({ where: { id: offer.id }, data: { ...patch, status, resolutionReason: reason, closedAt: new Date() } })
  await tx.shiftOfferReservation.deleteMany({ where: { offerId: offer.id } })
  await tx.accountNotification.updateMany({ where: { shiftOfferId: offer.id, readAt: null }, data: { readAt: new Date() } })
  await notice(tx, updated, 'SHIFT_OFFER_RESULT', [offer.initiatorMemberId, offer.recipientMemberId, updated.acceptedByMemberId].filter((id): id is string => !!id), status === 'COMPLETED' ? offer.kind === 'SWAP' ? 'Обмен сменами завершён' : 'Смена передана' : 'Предложение смены закрыто', reason)
  return updated
}
async function validateOffer(tx: Prisma.TransactionClient, offer: ShiftOffer) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: offer.organizationId } })
  if (mode(org, offer.kind) === 'DISABLED' || mode(org, offer.kind) !== offer.mode) fail('OFFER_MODE_CHANGED', 'Режим передачи или обмена изменён. Создайте новое предложение.')
  const ids = [offer.sourceShiftId, offer.targetShiftId].filter((id): id is string => !!id).sort()
  for (const id of ids) await lockShift(tx, id)
  const source = await tx.workShift.findUniqueOrThrow({ where: { id: offer.sourceShiftId } })
  const target = offer.targetShiftId ? await tx.workShift.findUniqueOrThrow({ where: { id: offer.targetShiftId } }) : null
  for (const [shift, snapshot] of [[source, offer.sourceSnapshot], ...(target ? [[target, offer.targetSnapshot]] : [])] as Array<[WorkShift, Prisma.JsonValue | null]>) {
    shiftReady(shift)
    const point = await tx.organizationLocation.findUniqueOrThrow({ where: { id: shift.locationId } })
    if (JSON.stringify(shiftSnapshot(shift, point.timezone)) !== JSON.stringify(normalizeSnapshot(snapshot))) fail('SHIFT_CHANGED', 'Условия или сотрудник смены изменились. Предложение больше неактуально.')
  }
  await memberAccess(tx, source, offer.initiatorMemberId)
  const recipientId = offer.acceptedByMemberId ?? offer.recipientMemberId
  if (recipientId) {
    await eligible(tx, source, recipientId, ids)
    if (target) await eligible(tx, target, offer.initiatorMemberId, ids)
  }
  return { source, target }
}
// JSONB has a different key order from JS; compare values in the canonical order.
function normalizeSnapshot(value: Prisma.JsonValue | null) {
  const s = value as ReturnType<typeof shiftSnapshot>
  return s && { id: s.id, memberId: s.memberId, locationId: s.locationId, startAt: s.startAt, endAt: s.endAt, timezone: s.timezone, positionId: s.positionId, positionName: s.positionName, breakMinutes: s.breakMinutes, description: s.description }
}
async function reconcile(tx: Prisma.TransactionClient, organizationId: string, locationId: string) {
  const pending = await tx.shiftOffer.findMany({ where: { organizationId, locationId, status: { in: [...active] } }, orderBy: { id: 'asc' } })
  for (const offer of pending) {
    try { await validateOffer(tx, offer) }
    catch (error) { if (!(error instanceof ApiError)) throw error; await closeOffer(tx, offer, error.code === 'SHIFT_STARTED' ? 'EXPIRED' : 'INVALID', error.message) }
  }
}
async function managers(tx: Prisma.TransactionClient, organizationId: string, locationId: string) {
  return tx.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null }, OR: [{ role: 'OWNER' }, { locationMemberships: { some: { locationId, role: 'ADMIN', leftAt: null } } }] } })
}
function canManage(actor: Awaited<ReturnType<typeof getMembership>>, locationId: string) { return actor.organizationRole === 'OWNER' || actor.managedLocationIds.includes(locationId) }
function publicOffer(offer: Prisma.ShiftOfferGetPayload<{ include: typeof include }>, actor: Awaited<ReturnType<typeof getMembership>>) {
  const person = (member: typeof offer.initiator | null) => member ? { id: member.id, name: name(member.user), avatarUrl: mediaUrl(member.user.avatarFileId) } : null
  const current = isActive(offer)
  const mine = offer.initiatorMemberId === actor.id
  return { id: offer.id, kind: offer.kind, mode: offer.mode, status: offer.status, comment: offer.comment, resolutionReason: offer.resolutionReason, createdAt: offer.createdAt, acceptedAt: offer.acceptedAt, reviewedAt: offer.reviewedAt, closedAt: offer.closedAt, location: { id: offer.location.id, name: offer.location.name }, source: normalizeSnapshot(offer.sourceSnapshot), target: normalizeSnapshot(offer.targetSnapshot), initiator: person(offer.initiator)!, recipient: person(offer.recipient), acceptedBy: person(offer.acceptedBy), reviewedBy: person(offer.reviewedBy), canCancel: current && mine, canAccept: offer.status === 'PENDING' && !mine && (!offer.recipientMemberId || offer.recipientMemberId === actor.id), canReject: offer.status === 'PENDING' && offer.recipientMemberId === actor.id, canApprove: offer.status === 'AWAITING_APPROVAL' && canManage(actor, offer.locationId) && actor.id !== offer.initiatorMemberId && actor.id !== offer.acceptedByMemberId }
}
async function visible(tx: Prisma.TransactionClient, actor: Awaited<ReturnType<typeof getMembership>>, offer: ShiftOffer) {
  if (actor.locationId !== offer.locationId) return false
  if ([offer.initiatorMemberId, offer.recipientMemberId, offer.acceptedByMemberId].includes(actor.id)) return true
  if (canManage(actor, offer.locationId)) return true
  if (offer.recipientMemberId) return false
  if (offer.status !== 'PENDING') {
    const shift = await tx.workShift.findUniqueOrThrow({ where: { id: offer.sourceShiftId } })
    try { await memberAccess(tx, shift, actor.id) } catch (error) { if (error instanceof ApiError) return false; throw error }
    return !!await tx.accountNotification.findFirst({ where: { shiftOfferId: offer.id, userId: actor.userId } })
  }
  try { await eligible(tx, await tx.workShift.findUniqueOrThrow({ where: { id: offer.sourceShiftId } }), actor.id); return true } catch (error) { if (error instanceof ApiError) return false; throw error }
}
export async function getOfferModes(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  return { transferMode: actor.organization.shiftTransferMode, swapMode: actor.organization.shiftSwapMode }
}
export async function saveOfferModes(userId: string, organizationId: string, input: z.infer<typeof offerModesBody>) {
  return transaction(organizationId, async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    if (actor.organizationRole !== 'OWNER') throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Настройки передачи и обмена меняет владелец.')
    await tx.organization.update({ where: { id: organizationId }, data: { shiftTransferMode: input.transferMode, shiftSwapMode: input.swapMode } })
    const offers = await tx.shiftOffer.findMany({ where: { organizationId, status: { in: [...active] } } })
    for (const offer of offers) if (offer.mode !== (offer.kind === 'TRANSFER' ? input.transferMode : input.swapMode)) await closeOffer(tx, offer, 'INVALID', 'Владелец изменил режим передачи или обмена. Создайте новое предложение.')
    return input
  })
}
export async function offerCandidates(userId: string, organizationId: string, sourceShiftId: string) {
  return transaction(organizationId, async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    const source = await tx.workShift.findFirst({ where: { id: sourceShiftId, organizationId, locationId: actor.locationId, memberId: actor.id } })
    if (!source) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Ваша смена не найдена.')
    shiftReady(source); await memberAccess(tx, source, actor.id)
    await reconcile(tx, organizationId, actor.locationId)
    const members = await tx.organizationMember.findMany({ where: { organizationId, id: { not: actor.id }, leftAt: null, user: { deletedAt: null } }, include: personInclude })
    const candidates = []
    for (const member of members) {
      try { await memberAccess(tx, source, member.id) } catch (error) { if (error instanceof ApiError) continue; throw error }
      let transferReason: string | null = null
      try { await eligible(tx, source, member.id) } catch (error) { if (!(error instanceof ApiError)) throw error; transferReason = error.message }
      const future = await tx.workShift.findMany({ where: { organizationId, locationId: source.locationId, memberId: member.id, status: 'SCHEDULED', scheduledStartAt: { gt: new Date() }, offerReservation: null }, orderBy: { scheduledStartAt: 'asc' } })
      const shifts = []
      for (const shift of future) {
        let reason: string | null = null
        try { shiftReady(shift); await eligible(tx, source, member.id, [source.id, shift.id]); await eligible(tx, shift, actor.id, [source.id, shift.id]) } catch (error) { if (!(error instanceof ApiError)) throw error; reason = error.message }
        shifts.push({ ...shiftSnapshot(shift, actor.location.timezone), reason })
      }
      candidates.push({ id: member.id, name: name(member.user), email: member.user.email, avatarUrl: mediaUrl(member.user.avatarFileId), transferReason, shifts })
    }
    return { candidates, transferMode: actor.organization.shiftTransferMode, swapMode: actor.organization.shiftSwapMode }
  })
}
export async function createOffer(userId: string, organizationId: string, input: z.infer<typeof offerBody>) {
  return transaction(organizationId, async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    const selectedMode = mode(actor.organization, input.kind)
    if (selectedMode === 'DISABLED') throw new ApiError(403, 'OFFERS_DISABLED', 'Этот способ передачи смен выключен владельцем.')
    await reconcile(tx, organizationId, actor.locationId)
    const ids = [input.sourceShiftId, input.targetShiftId].filter((id): id is string => !!id).sort()
    for (const id of ids) await lockShift(tx, id)
    const source = await tx.workShift.findFirst({ where: { id: input.sourceShiftId, organizationId, locationId: actor.locationId, memberId: actor.id } })
    if (!source) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Можно предложить только свою смену в выбранной точке.')
    shiftReady(source); await memberAccess(tx, source, actor.id)
    if (input.recipientMemberId === actor.id) fail('INVALID_RECIPIENT', 'Выберите другого сотрудника.')
    const target = input.targetShiftId ? await tx.workShift.findFirst({ where: { id: input.targetShiftId, organizationId, locationId: source.locationId, memberId: input.recipientMemberId! } }) : null
    if (input.kind === 'SWAP' && !target) fail('INVALID_SWAP_SHIFT', 'Выберите будущую смену коллеги в этой же точке.')
    if (target) { shiftReady(target); await eligible(tx, target, actor.id, ids) }
    if (await tx.shiftOfferReservation.count({ where: { shiftId: { in: ids } } })) fail('SHIFT_RESERVED', 'Одна из смен уже участвует в незавершённом предложении.')
    const recipients: string[] = []
    if (input.recipientMemberId) { await eligible(tx, source, input.recipientMemberId, ids); recipients.push(input.recipientMemberId) }
    else {
      const members = await tx.organizationMember.findMany({ where: { organizationId, id: { not: actor.id }, leftAt: null }, select: { id: true } })
      for (const member of members) { try { await eligible(tx, source, member.id); recipients.push(member.id) } catch (error) { if (!(error instanceof ApiError)) throw error } }
      if (!recipients.length) fail('NO_ELIGIBLE_MEMBERS', 'В точке пока нет подходящих сотрудников для этой смены.')
    }
    const offer = await tx.shiftOffer.create({ data: { organizationId, locationId: source.locationId, initiatorMemberId: actor.id, ...input, mode: selectedMode, sourceSnapshot: shiftSnapshot(source, actor.location.timezone), ...(target ? { targetSnapshot: shiftSnapshot(target, actor.location.timezone) } : {}) } })
    await tx.shiftOfferReservation.createMany({ data: ids.map(shiftId => ({ organizationId, shiftId, offerId: offer.id })) })
    await notice(tx, offer, 'SHIFT_OFFER_CREATED', recipients, input.kind === 'SWAP' ? 'Предложение обмена сменами' : input.recipientMemberId ? 'Вам предлагают смену' : 'Доступная смена', `${name((await tx.organizationMember.findUniqueOrThrow({ where: { id: actor.id }, include: personInclude })).user)} · ${new Intl.DateTimeFormat('ru-RU', { timeZone: actor.location.timezone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(source.scheduledStartAt)} · ${actor.location.name}`)
    return publicOffer(await tx.shiftOffer.findUniqueOrThrow({ where: { id: offer.id }, include }), actor)
  })
}
export async function listOffers(userId: string, organizationId: string, query: z.infer<typeof offerListQuery>) {
  return transaction(organizationId, async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    if (query.tab === 'approval' && !canManage(actor, actor.locationId)) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Согласование доступно администратору точки или владельцу.')
    await reconcile(tx, organizationId, actor.locationId)
    const rows = await tx.shiftOffer.findMany({ where: { organizationId, locationId: actor.locationId, OR: [{ initiatorMemberId: actor.id }, { recipientMemberId: actor.id }, { acceptedByMemberId: actor.id }, { recipientMemberId: null, status: 'PENDING' }, ...(canManage(actor, actor.locationId) ? [{ status: 'AWAITING_APPROVAL' as const }] : [])] }, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const buckets: Record<string, typeof rows> = { mine: [], available: [], sent: [], approval: [] }
    for (const offer of rows) {
      if (offer.initiatorMemberId === actor.id) buckets.sent.push(offer)
      if (offer.recipientMemberId === actor.id || offer.acceptedByMemberId === actor.id) buckets.mine.push(offer)
      if (offer.status === 'AWAITING_APPROVAL' && canManage(actor, offer.locationId) && actor.id !== offer.initiatorMemberId && actor.id !== offer.acceptedByMemberId) buckets.approval.push(offer)
      if (!offer.recipientMemberId && offer.initiatorMemberId !== actor.id && offer.status === 'PENDING') {
        try { await eligible(tx, await tx.workShift.findUniqueOrThrow({ where: { id: offer.sourceShiftId } }), actor.id); buckets.available.push(offer) }
        catch (error) { if (!(error instanceof ApiError)) throw error }
      }
    }
    const filtered = buckets[query.tab], total = filtered.length
    return { offers: filtered.slice((query.page - 1) * query.limit, query.page * query.limit).map(offer => publicOffer(offer, actor)), counts: { mine: buckets.mine.filter(o => o.status === 'PENDING').length, available: buckets.available.length, approval: buckets.approval.length }, pagination: { page: query.page, pages: Math.max(1, Math.ceil(total / query.limit)), total } }
  })
}
export async function getOffer(userId: string, organizationId: string, offerId: string) {
  return transaction(organizationId, async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    await reconcile(tx, organizationId, actor.locationId)
    const offer = await tx.shiftOffer.findFirst({ where: { id: offerId, organizationId }, include })
    if (!offer || !await visible(tx, actor, offer)) throw new ApiError(404, 'OFFER_NOT_FOUND', 'Предложение не найдено или больше недоступно.')
    const response = publicOffer(offer, actor)
    let acceptanceReason: string | null = null
    if (response.canAccept) {
      try { await eligible(tx, await tx.workShift.findUniqueOrThrow({ where: { id: offer.sourceShiftId } }), actor.id, [offer.sourceShiftId, ...(offer.targetShiftId ? [offer.targetShiftId] : [])]) }
      catch (error) { if (!(error instanceof ApiError)) throw error; response.canAccept = false; acceptanceReason = error.message }
    }
    return { ...response, acceptanceReason }
  })
}
async function complete(tx: Prisma.TransactionClient, offer: ShiftOffer, source: WorkShift, target: WorkShift | null, accepterId: string, reviewerId: string | null) {
  const participants = await tx.organizationMember.findMany({ where: { id: { in: [offer.initiatorMemberId, accepterId, ...(reviewerId ? [reviewerId] : [])] } }, include: personInclude })
  const participantName = (id: string) => name(participants.find(member => member.id === id)!.user)
  // Close before shift UPDATE so the invalidation trigger ignores our own operation.
  const updated = await closeOffer(tx, offer, 'COMPLETED', offer.kind === 'SWAP' ? 'Сотрудники обменялись сменами. Новые назначения уже в расписании.' : 'Смена передана и уже в расписании нового сотрудника.', { acceptedByMemberId: accepterId, acceptedAt: offer.acceptedAt ?? new Date(), ...(reviewerId ? { reviewedByMemberId: reviewerId, reviewedAt: new Date() } : {}) })
  // The exclusion constraint is deferred only within this transaction, allowing
  // swaps whose two original time ranges overlap. Final state still must be valid.
  await tx.$executeRaw`SET CONSTRAINTS work_shifts_no_overlap DEFERRED`
  for (const [shift, newMemberId] of [[source, accepterId], ...(target ? [[target, offer.initiatorMemberId]] : [])] as Array<[WorkShift, string]>) {
    await tx.workShift.update({ where: { id: shift.id }, data: { memberId: newMemberId, assignmentReadAt: null } })
    const previous = await tx.organizationMember.findUniqueOrThrow({ where: { id: shift.memberId }, include: personInclude })
    const next = await tx.organizationMember.findUniqueOrThrow({ where: { id: newMemberId }, include: personInclude })
    await tx.workShiftAdjustment.create({ data: { shiftId: shift.id, changedByMemberId: reviewerId ?? accepterId, kind: offer.kind, previousStartAt: shift.scheduledStartAt, previousEndAt: shift.scheduledEndAt, previousBreakMinutes: shift.breakMinutes, newStartAt: shift.scheduledStartAt, newEndAt: shift.scheduledEndAt, newBreakMinutes: shift.breakMinutes, reason: offer.kind === 'SWAP' ? 'Взаимный обмен сменами' : 'Передача смены', assignmentChange: { offerId: offer.id, initiatorMemberId: offer.initiatorMemberId, initiatorMemberName: participantName(offer.initiatorMemberId), acceptedByMemberId: accepterId, acceptedByMemberName: participantName(accepterId), reviewedByMemberId: reviewerId, reviewedByMemberName: reviewerId ? participantName(reviewerId) : null, previousMemberId: shift.memberId, previousMemberName: name(previous.user), newMemberId, newMemberName: name(next.user) } } })
    await cancelShiftRequests(tx, offer.organizationId, [shift.id], reviewerId ?? accepterId, 'Назначенный сотрудник изменён после передачи или обмена смены.')
  }
  await tx.$executeRaw`SET CONSTRAINTS work_shifts_no_overlap IMMEDIATE`
  return updated
}
export async function actOnOffer(userId: string, organizationId: string, offerId: string, action: z.infer<typeof offerActionBody>['action']) {
  const result = await transaction(organizationId, async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    const offer = await tx.shiftOffer.findFirst({ where: { id: offerId, organizationId } })
    if (!offer || !await visible(tx, actor, offer)) throw new ApiError(404, 'OFFER_NOT_FOUND', 'Предложение не найдено или больше недоступно.')
    const isInitiator = actor.id === offer.initiatorMemberId
    const isRecipient = !isInitiator && (!offer.recipientMemberId || actor.id === offer.recipientMemberId)
    const isReviewer = canManage(actor, offer.locationId) && actor.id !== offer.initiatorMemberId && actor.id !== offer.acceptedByMemberId
    if ((action === 'cancel' && !isInitiator) || (action === 'reject' && actor.id !== offer.recipientMemberId) || (action === 'accept' && !isRecipient) || (['approve', 'decline'].includes(action) && !isReviewer)) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'У вас нет прав на это действие с предложением.')
    if (!isActive(offer)) {
      if (offer.status === 'COMPLETED' && (action === 'accept' && offer.acceptedByMemberId === actor.id || action === 'approve' && offer.reviewedByMemberId === actor.id) || offer.status === 'CANCELLED' && action === 'cancel' || offer.status === 'REJECTED' && ['reject', 'decline'].includes(action)) return { id: offer.id }
      fail('OFFER_CLOSED', offer.resolutionReason ?? 'Предложение уже закрыто. Обновите список.')
    }
    let source: WorkShift, target: WorkShift | null
    try { ({ source, target } = await validateOffer(tx, offer)) }
    catch (error) {
      if (!(error instanceof ApiError)) throw error
      await closeOffer(tx, offer, error.code === 'SHIFT_STARTED' ? 'EXPIRED' : 'INVALID', error.message)
      return { id: offer.id, error }
    }
    if (action === 'decline' && offer.status !== 'AWAITING_APPROVAL') fail('OFFER_NOT_ACCEPTED', 'Сначала дождитесь согласия коллеги.')
    if (action === 'cancel' || action === 'reject' || action === 'decline') {
      await closeOffer(tx, offer, action === 'cancel' ? 'CANCELLED' : 'REJECTED', action === 'cancel' ? 'Инициатор отменил предложение.' : action === 'decline' ? 'Администратор отклонил предложение.' : 'Коллега отказался от предложения.', action === 'decline' ? { reviewedByMemberId: actor.id, reviewedAt: new Date() } : {})
    } else if (action === 'accept') {
      if (offer.status === 'AWAITING_APPROVAL' && offer.acceptedByMemberId === actor.id) return { id: offer.id }
      if (offer.status !== 'PENDING') fail('OFFER_TAKEN', 'Предложение уже принял другой сотрудник.')
      await eligible(tx, source, actor.id, [source.id, ...(target ? [target.id] : [])])
      if (offer.mode === 'APPROVAL') {
        const reviewers = (await managers(tx, organizationId, offer.locationId)).filter(m => m.id !== offer.initiatorMemberId && m.id !== actor.id)
        if (!reviewers.length) fail('NO_REVIEWER', 'В точке нет независимого администратора для согласования. Обратитесь к владельцу.')
        const pending = await tx.shiftOffer.update({ where: { id: offer.id }, data: { status: 'AWAITING_APPROVAL', acceptedByMemberId: actor.id, acceptedAt: new Date() } })
        await tx.accountNotification.updateMany({ where: { shiftOfferId: offer.id, type: 'SHIFT_OFFER_CREATED', readAt: null }, data: { readAt: new Date() } })
        await notice(tx, pending, 'SHIFT_OFFER_APPROVAL', reviewers.map(m => m.id), 'Нужно согласовать смены', 'Коллега принял предложение. До согласования назначения остаются прежними.')
      } else await complete(tx, offer, source, target, actor.id, null)
    } else {
      if (offer.status !== 'AWAITING_APPROVAL' || !offer.acceptedByMemberId) fail('OFFER_NOT_ACCEPTED', 'Сначала дождитесь согласия коллеги.')
      await complete(tx, offer, source, target, offer.acceptedByMemberId, actor.id)
    }
    return { id: offer.id }
  })
  if ('error' in result) throw result.error
  // A losing claimant may no longer see an open offer: do not require visibility
  // again after the atomic transition, only return the final state to this actor.
  const actor = await getMembership(userId, organizationId)
  return publicOffer(await prisma.shiftOffer.findUniqueOrThrow({ where: { id: result.id }, include }), actor)
}
