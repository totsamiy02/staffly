import { Prisma, type OrganizationEvent } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/permissions.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { zonedDateTimeToUtc } from '../schedule/timezone.ts'
import { eventTimezoneLabel } from '../../app/events/format.ts'
import { formatNotificationPeriod } from '../../app/organizations/notification-format.ts'
import { zonedDateAndTime } from '../../app/schedule/date-utils.ts'
import type { EventInput, EventListOptions } from './schemas.ts'

type Actor = Awaited<ReturnType<typeof getMembership>>
const include = {
  locations: { include: { location: true }, orderBy: { locationId: 'asc' as const } },
  recipients: { where: { removedAt: null }, include: { member: { include: { user: true } } }, orderBy: { addedAt: 'asc' as const } },
  createdBy: { include: { user: true } }, updatedBy: { include: { user: true } },
} satisfies Prisma.OrganizationEventInclude
type LoadedEvent = Prisma.OrganizationEventGetPayload<{ include: typeof include }>
const name = (user: { firstName: string | null; lastName: string | null; middleName: string | null; email: string }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email
const manager = (actor: Actor, shared: boolean, ids: string[]) => actor.organizationRole === 'OWNER' || !shared && ids.length > 0 && ids.every(id => actor.managedLocationIds.includes(id))
export function eventVisibility(actor: Actor): Prisma.OrganizationEventWhereInput {
  if (actor.organizationRole === 'OWNER') return {}
  return { OR: [
    { recipients: { some: { memberId: actor.id, removedAt: null } } },
    ...(actor.managedLocationIds.length ? [{ shared: true }, { locations: { some: { locationId: { in: actor.managedLocationIds } } } }] : []),
  ] }
}
function dto(event: LoadedEvent, actor: Actor, now = new Date()) {
  const active = event.recipients.filter(row => !row.member.leftAt && !row.member.user.deletedAt)
  return {
    id: event.id, organizationId: event.organizationId, title: event.title, description: event.description, typeLabel: event.typeLabel,
    startAt: event.startAt, endAt: event.endAt, timezone: event.timezone, place: event.place, meetingUrl: event.meetingUrl,
    shared: event.shared, locations: event.locations.map(({ location }) => ({ id: location.id, name: location.name, timezone: location.timezone, archivedAt: location.archivedAt })),
    audienceMode: event.audienceMode, audienceRoles: event.audienceRoles,
    recipients: active.map(({ member }) => ({ id: member.id, name: name(member.user), avatarUrl: mediaUrl(member.user.avatarFileId), role: member.role })),
    recipientCount: active.length, isRecipient: active.some(row => row.memberId === actor.id),
    createdBy: { id: event.createdByMemberId, name: name(event.createdBy.user) }, updatedBy: { id: event.updatedByMemberId, name: name(event.updatedBy.user) },
    revision: event.revision, createdAt: event.createdAt, updatedAt: event.updatedAt, cancelledAt: event.cancelledAt,
    status: event.cancelledAt ? 'CANCELLED' : (event.endAt ?? event.startAt) <= now ? 'PAST' : event.startAt <= now ? 'ONGOING' : 'UPCOMING',
    canManage: manager(actor, event.shared, event.locations.map(row => row.locationId)) && !event.cancelledAt && (event.endAt ?? event.startAt) > now,
  }
}
async function scope(tx: Prisma.TransactionClient, actor: Actor, shared: boolean, locationIds: string[], write: boolean) {
  const ids = [...new Set(locationIds)].sort()
  if (shared ? ids.length > 0 : !ids.length) throw new ApiError(400, 'EVENT_SCOPE_REQUIRED', 'Выберите точки или всю организацию.')
  const locations = await tx.organizationLocation.findMany({ where: { organizationId: actor.organizationId, ...(shared ? {} : { id: { in: ids } }), archivedAt: null }, orderBy: { createdAt: 'asc' } })
  if (!shared && locations.length !== ids.length) throw new ApiError(400, 'LOCATION_NOT_FOUND', 'Одна из выбранных точек недоступна.')
  if (write && !manager(actor, shared, ids)) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Управлять событием можно только в пределах назначенных вам точек.')
  const organization = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { timezone: true } })
  return { locations, ids, timezone: !shared && locations.length === 1 ? locations[0].timezone : organization.timezone }
}
async function audience(tx: Prisma.TransactionClient, organizationId: string, shared: boolean, ids: string[], roles?: string[]) {
  return tx.organizationMember.findMany({
    where: { organizationId, leftAt: null, user: { deletedAt: null }, ...(roles?.length ? { role: { not: 'OWNER' as const } } : {}),
      ...(shared && !roles?.length ? {} : { locationMemberships: { some: { leftAt: null, location: { archivedAt: null }, ...(!shared ? { locationId: { in: ids } } : {}), ...(roles?.length ? { role: { in: roles as ('ADMIN' | 'MEMBER')[] } } : {}) } } }),
    },
    include: { user: true, locationMemberships: { where: { leftAt: null, location: { archivedAt: null }, ...(!shared ? { locationId: { in: ids } } : {}) } } },
    orderBy: [{ user: { lastName: 'asc' } }, { id: 'asc' }],
  })
}
export async function eventMembers(userId: string, organizationId: string, shared: boolean, ids: string[]) {
  return prisma.$transaction(async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    const selected = await scope(tx, actor, shared, ids, true)
    const members = await audience(tx, organizationId, shared, selected.ids)
    return { timezone: selected.timezone, members: members.map(member => ({ id: member.id, name: name(member.user), avatarUrl: mediaUrl(member.user.avatarFileId), role: member.role, locationRoles: member.role === 'OWNER' ? [] : member.locationMemberships.map(row => row.role) })) }
  })
}
function payload(input: EventInput, timezone: string) {
  const startAt = zonedDateTimeToUtc(input.startDate, input.startTime, timezone)
  const endAt = input.endDate && input.endTime ? zonedDateTimeToUtc(input.endDate, input.endTime, timezone) : null
  if (endAt && endAt <= startAt) throw new ApiError(400, 'EVENT_INVALID_PERIOD', 'Окончание должно быть позже начала.')
  return { title: input.title, description: input.description, typeLabel: input.typeLabel, startAt, endAt, timezone, place: input.place, meetingUrl: input.meetingUrl, shared: input.shared, audienceMode: input.audienceMode, audienceRoles: [...new Set(input.audienceRoles)].sort() }
}
async function resolveRecipients(tx: Prisma.TransactionClient, organizationId: string, input: EventInput, ids: string[]) {
  const candidates = await audience(tx, organizationId, input.shared, ids, input.audienceMode === 'ROLES' ? input.audienceRoles : undefined)
  if (input.audienceMode !== 'SELECTED') return candidates.map(member => member.id)
  const selected = [...new Set(input.memberIds)]
  if (selected.some(id => !candidates.some(member => member.id === id))) throw new ApiError(400, 'EVENT_INVALID_RECIPIENT', 'Один из сотрудников не относится к выбранным точкам.')
  return selected
}
async function notify(tx: Prisma.TransactionClient, event: OrganizationEvent, memberIds: string[], type: 'EVENT_PUBLISHED' | 'EVENT_CHANGED' | 'EVENT_CANCELLED' | 'EVENT_STARTED') {
  if (!memberIds.length) return
  const members = await tx.organizationMember.findMany({ where: { organizationId: event.organizationId, id: { in: memberIds }, leftAt: null, user: { deletedAt: null } }, select: { id: true, userId: true } })
  const label = { EVENT_PUBLISHED: 'Новое событие', EVENT_CHANGED: 'Событие изменено', EVENT_CANCELLED: 'Событие отменено', EVENT_STARTED: 'Событие начинается' }[type]
  const period = event.endAt ? formatNotificationPeriod(event.startAt, event.endAt, event.timezone) : `${event.startAt.toLocaleDateString('ru-RU', { timeZone: event.timezone, day: 'numeric', month: 'long' })} · ${event.startAt.toLocaleTimeString('ru-RU', { timeZone: event.timezone, hour: '2-digit', minute: '2-digit' })}`
  await tx.accountNotification.createMany({ data: members.map(member => ({ organizationId: event.organizationId, eventId: event.id, userId: member.userId, type, title: label, message: `${event.title} · ${period} (${eventTimezoneLabel(event.timezone)})`.slice(0, 500), eventDeliveryKey: `${event.id}:${event.revision}:${type}:${member.id}` })), skipDuplicates: true })
}
async function recordChange(tx: Prisma.TransactionClient, event: LoadedEvent, actor: Actor, action: string) {
  await tx.eventChange.create({ data: { organizationId: event.organizationId, eventId: event.id, memberId: actor.id, revision: event.revision, action,
    snapshot: { title: event.title, description: event.description, typeLabel: event.typeLabel, startAt: event.startAt.toISOString(), endAt: event.endAt?.toISOString() ?? null, timezone: event.timezone, place: event.place, meetingUrl: event.meetingUrl, shared: event.shared, locationIds: event.locations.map(row => row.locationId), memberIds: event.recipients.map(row => row.memberId), audienceMode: event.audienceMode, audienceRoles: event.audienceRoles, cancelledAt: event.cancelledAt?.toISOString() ?? null } } })
}
export async function createEvent(userId: string, organizationId: string, input: EventInput) {
  return prisma.$transaction(async tx => {
    const actor = await getMembership(userId, organizationId, tx)
    const selected = await scope(tx, actor, input.shared, input.locationIds, true)
    const data = payload(input, selected.timezone)
    if (data.startAt <= new Date()) throw new ApiError(400, 'EVENT_START_IN_PAST', 'Выберите будущее время начала.')
    const recipients = await resolveRecipients(tx, organizationId, input, selected.ids)
    const event = await tx.organizationEvent.create({ data: { ...data, organizationId, createdByMemberId: actor.id, updatedByMemberId: actor.id,
      locations: { create: selected.ids.map(locationId => ({ locationId })) }, recipients: { create: recipients.map(memberId => ({ memberId })) } }, include })
    await recordChange(tx, event, actor, 'CREATED')
    await notify(tx, event, recipients, 'EVENT_PUBLISHED')
    return dto(event, actor)
  }, { timeout: 15000 })
}
async function accessibleEvent(tx: Prisma.TransactionClient, actor: Actor, eventId: string) {
  const event = await tx.organizationEvent.findFirst({ where: { organizationId: actor.organizationId, id: eventId, ...eventVisibility(actor) }, include })
  if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Событие не найдено или недоступно.')
  return event
}
export async function getEvent(userId: string, organizationId: string, eventId: string) {
  const actor = await getMembership(userId, organizationId)
  const event = await accessibleEvent(prisma, actor, eventId)
  const changes = await prisma.eventChange.findMany({ where: { eventId }, orderBy: { revision: 'desc' }, take: 50, include: { member: { include: { user: true } } } })
  return { ...dto(event, actor), changes: changes.map(change => ({ id: change.id, action: change.action, revision: change.revision, createdAt: change.createdAt, author: name(change.member.user) })) }
}
export async function listEvents(userId: string, organizationId: string, options: EventListOptions, now = new Date()) {
  const actor = await getMembership(userId, organizationId)
  if (options.pointId !== 'all' && !await prisma.organizationLocation.findFirst({ where: { id: options.pointId, organizationId, ...(actor.organizationRole === 'OWNER' ? {} : { archivedAt: null }) } })) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
  // Match the same IANA conversion as the UI, including dates at midnight.
  const dateCandidates = options.from || options.to ? await prisma.organizationEvent.findMany({ where: { organizationId, startAt: { ...(options.from ? { gte: new Date(Date.parse(`${options.from}T00:00:00Z`) - 86400000) } : {}), ...(options.to ? { lt: new Date(Date.parse(`${options.to}T00:00:00Z`) + 86400000) } : {}) } }, select: { id: true, startAt: true, timezone: true } }) : null
  const dateIds = dateCandidates?.filter(event => { const day = zonedDateAndTime(event.startAt.toISOString(), event.timezone).date; return (!options.from || day >= options.from) && (!options.to || day < options.to) })
  const where: Prisma.OrganizationEventWhereInput = { organizationId, AND: [eventVisibility(actor),
    options.pointId !== 'all' ? { OR: [{ shared: true }, { locations: { some: { locationId: options.pointId } } }] } : {},
    options.tab === 'upcoming' ? { cancelledAt: null, OR: [{ endAt: { gt: now } }, { endAt: null, startAt: { gt: now } }] } : { OR: [{ cancelledAt: { not: null } }, { endAt: { lte: now } }, { endAt: null, startAt: { lte: now } }] },
    options.search ? { title: { contains: options.search, mode: 'insensitive' } } : {},
    dateIds ? { id: { in: dateIds.map(row => row.id) } } : {},
  ] }
  const [total, events, calendar] = await prisma.$transaction([prisma.organizationEvent.count({ where }), prisma.organizationEvent.findMany({ where, include, orderBy: [{ startAt: options.tab === 'upcoming' ? 'asc' : 'desc' }, { id: 'asc' }], skip: (options.page - 1) * options.pageSize, take: options.pageSize }), ...(options.from && options.to ? [prisma.organizationEvent.findMany({ where, select: { startAt: true, timezone: true } })] : [prisma.organizationEvent.findMany({ where: { id: { in: [] } }, select: { startAt: true, timezone: true } })])])
  return { events: events.map(event => dto(event, actor, now)), markedDays: [...new Set(calendar.map(event => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: event.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(event.startAt); return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-') }))], pagination: { total, page: options.page, pageSize: options.pageSize, pages: Math.ceil(total / options.pageSize) } }
}
export async function updateEvent(userId: string, organizationId: string, eventId: string, input: EventInput) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM organization_events WHERE id = ${eventId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`
    const actor = await getMembership(userId, organizationId, tx)
    const previous = await accessibleEvent(tx, actor, eventId)
    if (!manager(actor, previous.shared, previous.locations.map(row => row.locationId))) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для изменения события.')
    if (previous.cancelledAt || (previous.endAt ?? previous.startAt) <= new Date()) throw new ApiError(409, 'EVENT_CLOSED', 'Прошедшее или отменённое событие нельзя изменить.')
    if (input.revision !== previous.revision) throw new ApiError(409, 'CONCURRENT_UPDATE', 'Событие уже изменилось. Откройте его заново.')
    const selected = await scope(tx, actor, input.shared, input.locationIds, true)
    const data = payload(input, selected.timezone)
    const startChanged = data.startAt.getTime() !== previous.startAt.getTime()
    if (startChanged && data.startAt <= new Date()) throw new ApiError(400, 'EVENT_START_IN_PAST', 'Выберите будущее время начала.')
    const oldIds = previous.recipients.map(row => row.memberId)
    const scopeChanged = previous.shared !== input.shared || previous.locations.map(row => row.locationId).sort().join() !== selected.ids.join()
    const audienceChanged = previous.audienceMode !== input.audienceMode || [...previous.audienceRoles].sort().join() !== data.audienceRoles.join() || input.audienceMode === 'SELECTED' && [...new Set(input.memberIds)].sort().join() !== [...oldIds].sort().join()
    const nextIds = input.refreshRecipients || scopeChanged || audienceChanged ? await resolveRecipients(tx, organizationId, input, selected.ids) : oldIds
    const removed = oldIds.filter(id => !nextIds.includes(id)), added = nextIds.filter(id => !oldIds.includes(id))
    const material = startChanged || (data.endAt?.getTime() ?? null) !== (previous.endAt?.getTime() ?? null) || data.timezone !== previous.timezone || data.place !== previous.place || data.meetingUrl !== previous.meetingUrl || scopeChanged
    await tx.eventLocation.deleteMany({ where: { eventId } })
    await tx.eventLocation.createMany({ data: selected.ids.map(locationId => ({ organizationId, eventId, locationId })) })
    if (removed.length) await tx.eventRecipient.updateMany({ where: { eventId, memberId: { in: removed } }, data: { removedAt: new Date() } })
    for (const memberId of added) await tx.eventRecipient.upsert({ where: { eventId_memberId: { eventId, memberId } }, create: { organizationId, eventId, memberId }, update: { removedAt: null, addedAt: new Date() } })
    const event = await tx.organizationEvent.update({ where: { id: eventId }, data: { ...data, updatedByMemberId: actor.id, revision: { increment: 1 }, ...(startChanged ? { startNotifiedAt: null } : {}) }, include })
    await recordChange(tx, event, actor, 'UPDATED')
    await notify(tx, event, added, 'EVENT_PUBLISHED')
    if (material) await notify(tx, event, nextIds.filter(id => !added.includes(id)), 'EVENT_CHANGED')
    return dto(event, actor)
  }, { timeout: 15000 })
}
export async function cancelEvent(userId: string, organizationId: string, eventId: string, revision: number) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM organization_events WHERE id = ${eventId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`
    const actor = await getMembership(userId, organizationId, tx), previous = await accessibleEvent(tx, actor, eventId)
    if (!manager(actor, previous.shared, previous.locations.map(row => row.locationId))) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для отмены события.')
    if (previous.cancelledAt) return dto(previous, actor)
    if ((previous.endAt ?? previous.startAt) <= new Date()) throw new ApiError(409, 'EVENT_CLOSED', 'Событие уже завершилось.')
    if (previous.revision !== revision) throw new ApiError(409, 'CONCURRENT_UPDATE', 'Событие уже изменилось. Откройте его заново.')
    const event = await tx.organizationEvent.update({ where: { id: eventId }, data: { cancelledAt: new Date(), updatedByMemberId: actor.id, revision: { increment: 1 } }, include })
    await recordChange(tx, event, actor, 'CANCELLED')
    await notify(tx, event, event.recipients.map(row => row.memberId), 'EVENT_CANCELLED')
    return dto(event, actor)
  })
}
// Row locks serialize delivery with edits/cancellation. Claim and notification records commit together.
export async function deliverEventStarts(now = new Date()) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT e.id FROM organization_events e JOIN organizations o ON o.id = e.organization_id WHERE o.deleted_at IS NULL AND e.cancelled_at IS NULL AND e.start_notified_at IS NULL AND e.start_at <= ${now} ORDER BY e.start_at LIMIT 100 FOR UPDATE OF e SKIP LOCKED`
    let delivered = 0
    for (const row of rows) {
      const event = await tx.organizationEvent.findUniqueOrThrow({ where: { id: row.id }, include: { recipients: { where: { removedAt: null } } } })
      // Catch up brief downtime; don't notify about meetings that started hours or days ago.
      if (now.getTime() - event.startAt.getTime() <= 15 * 60000 && (!event.endAt || event.endAt > now)) {
        await notify(tx, event, event.recipients.map(recipient => recipient.memberId), 'EVENT_STARTED')
        delivered++
      }
      await tx.organizationEvent.update({ where: { id: row.id }, data: { startNotifiedAt: now } })
    }
    return delivered
  }, { timeout: 15000 })
}
