import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/server/db.ts'
import { createOrganization } from '../src/server/organizations/organization-service.ts'
import { locationContext } from '../src/server/organizations/location-context.ts'
import { listNotificationHistory } from '../src/server/organizations/notification-service.ts'
import { createEvent, updateEvent, cancelEvent, getEvent, listEvents, eventMembers, deliverEventStarts } from '../src/server/events/service.ts'
import { eventBody, listEventsQuery, type EventInput } from '../src/server/events/schemas.ts'
import { zonedDateAndTime } from '../src/app/schedule/date-utils.ts'
import { eventDate } from '../src/app/events/format.ts'

let orgId: string, foreignOrgId: string, point1: string, point2: string, point3: string, foreignPoint: string
const accounts: Record<string, { id: string; email: string; memberId: string }> = {}
const ids: string[] = []
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === expected)
function input(patch: Partial<EventInput> = {}) { return eventBody.parse({ title: 'Месячная планёрка', shared: false, locationIds: [point1], startDate: '2038-10-12', startTime: '10:00', endDate: '2038-10-12', endTime: '11:00', audienceMode: 'ALL', ...patch }) }
function editing(event: Awaited<ReturnType<typeof createEvent>>, patch: Partial<EventInput> = {}) {
  const start = zonedDateAndTime(event.startAt.toISOString(), event.timezone), end = event.endAt ? zonedDateAndTime(event.endAt.toISOString(), event.timezone) : null
  return input({ title: event.title, description: event.description, typeLabel: event.typeLabel, startDate: start.date, startTime: start.time, endDate: end?.date, endTime: end?.time, place: event.place, meetingUrl: event.meetingUrl, shared: event.shared, locationIds: event.locations.map(point => point.id), audienceMode: event.audienceMode, audienceRoles: event.audienceRoles, memberIds: event.recipients.map(member => member.id), revision: event.revision, ...patch })
}
const notifications = (eventId: string, type?: 'EVENT_PUBLISHED' | 'EVENT_CHANGED' | 'EVENT_CANCELLED' | 'EVENT_STARTED', userId?: string) => prisma.accountNotification.count({ where: { eventId, type, userId } })
before(async () => {
  for (const label of ['owner', 'admin', 'admin2', 'employee', 'employee2', 'both', 'outsider']) {
    const user = await prisma.user.create({ data: { email: `events-${label}-${randomUUID()}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    accounts[label] = { ...user, memberId: '' }; ids.push(user.id)
  }
  const org = await createOrganization(accounts.owner.id, { name: 'Events tests', description: null, timezone: 'Europe/Moscow', firstLocation: { name: 'Самара', city: 'Самара', address: 'Тест', timezone: 'Europe/Samara' }, locations: [{ name: 'Москва', city: 'Москва', address: 'Тест', timezone: 'Europe/Moscow' }, { name: 'Омск', city: 'Омск', address: 'Тест', timezone: 'Asia/Omsk' }] })
  orgId = org.id; [point1, point2, point3] = org.locations.map(point => point.id)
  accounts.owner.memberId = (await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId: accounts.owner.id } } })).id
  for (const label of ['admin', 'admin2', 'employee', 'employee2', 'both']) {
    const member = await prisma.organizationMember.create({ data: { organizationId: orgId, userId: accounts[label].id, role: label.startsWith('admin') ? 'ADMIN' : 'MEMBER' } })
    accounts[label].memberId = member.id
    const points = label === 'admin' || label === 'employee' ? [point1] : label === 'both' ? [point1, point2] : [point2]
    await prisma.locationMember.createMany({ data: points.map(locationId => ({ organizationId: orgId, locationId, memberId: member.id, role: label.startsWith('admin') ? 'ADMIN' : 'MEMBER' })) })
  }
  const foreign = await createOrganization(accounts.outsider.id, { name: 'Foreign events', description: null, timezone: 'Europe/Moscow' })
  foreignOrgId = foreign.id; foreignPoint = foreign.locationId
})
after(async () => {
  if (orgId) await prisma.organizationEvent.deleteMany({ where: { organizationId: orgId } })
  await prisma.documentFolder.deleteMany({ where: { organizationId: { in: [orgId, foreignOrgId].filter(Boolean) } } })
  if (orgId) await prisma.organization.delete({ where: { id: orgId } })
  if (foreignOrgId) await prisma.organization.delete({ where: { id: foreignOrgId } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } }); await prisma.$disconnect()
})

describe('event scopes, recipients and notification delivery', { concurrency: false }, () => {
  it('validates dates, end fields and meeting URL schemes', () => {
    assert.equal(eventBody.safeParse({ ...input(), startDate: '2038-02-30' }).success, false)
    assert.equal(eventBody.safeParse({ ...input(), endTime: null }).success, false)
    assert.equal(eventBody.safeParse({ ...input(), meetingUrl: 'javascript:alert(1)' }).success, false)
    assert.equal(eventBody.safeParse({ ...input(), meetingUrl: 'https://example.test/meeting' }).success, true)
  })
  it('limits administrators to their assigned points even from another selected context', async () => {
    await assert.rejects(createEvent(accounts.employee.id, orgId, input()), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(createEvent(accounts.admin.id, orgId, input({ shared: true, locationIds: [] })), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(createEvent(accounts.admin.id, orgId, input({ locationIds: [point1, point2] })), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(createEvent(accounts.owner.id, orgId, input({ locationIds: [foreignPoint] })), code('LOCATION_NOT_FOUND'))
    const event = await locationContext.run({ organizationId: orgId, locationId: point2 }, () => createEvent(accounts.admin.id, orgId, input()))
    assert.equal(event.timezone, 'Europe/Samara'); assert.equal(event.canManage, true)
    await assert.rejects(getEvent(accounts.outsider.id, orgId, event.id), code('ORGANIZATION_NOT_FOUND'))
    await assert.rejects(getEvent(accounts.employee2.id, orgId, event.id), code('EVENT_NOT_FOUND'))
    assert.equal((await getEvent(accounts.employee.id, orgId, event.id)).canManage, false)
  })
  it('deduplicates multi-point recipients and lets a manager view but not edit a partial scope', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ locationIds: [point1, point2, point1] }))
    assert.equal(event.locations.length, 2); assert.equal(event.timezone, 'Europe/Moscow')
    assert.equal(event.recipients.filter(row => row.id === accounts.both.memberId).length, 1)
    assert.equal(await notifications(event.id, 'EVENT_PUBLISHED'), event.recipientCount)
    assert.equal((await getEvent(accounts.admin.id, orgId, event.id)).canManage, false)
    await assert.rejects(updateEvent(accounts.admin.id, orgId, event.id, editing(event)), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(cancelEvent(accounts.admin.id, orgId, event.id, event.revision), code('INSUFFICIENT_PERMISSIONS'))
    await prisma.locationMember.create({ data: { organizationId: orgId, locationId: point2, memberId: accounts.admin.memberId, role: 'ADMIN' } })
    try { assert.equal((await updateEvent(accounts.admin.id, orgId, event.id, editing(event, { description: 'Повестка' }))).description, 'Повестка') } finally { await prisma.locationMember.delete({ where: { locationId_memberId: { locationId: point2, memberId: accounts.admin.memberId } } }) }
  })
  it('filters by local role rather than organization role and rejects out-of-scope selections', async () => {
    const candidates = await eventMembers(accounts.admin.id, orgId, false, [point1])
    assert.ok(candidates.members.some(member => member.id === accounts.employee.memberId))
    assert.ok(!candidates.members.some(member => member.id === accounts.employee2.memberId))
    const event = await createEvent(accounts.owner.id, orgId, input({ audienceMode: 'ROLES', audienceRoles: ['ADMIN'] }))
    assert.deepEqual(event.recipients.map(member => member.id), [accounts.admin.memberId])
    await assert.rejects(createEvent(accounts.owner.id, orgId, input({ audienceMode: 'SELECTED', memberIds: [accounts.employee2.memberId] })), code('EVENT_INVALID_RECIPIENT'))
    await assert.rejects(eventMembers(accounts.admin.id, orgId, false, [point2]), code('INSUFFICIENT_PERMISSIONS'))
  })
  it('preserves recipient snapshots on ordinary edits and explicitly refreshes them', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input())
    const user = await prisma.user.create({ data: { email: `new-event-member-${randomUUID()}@example.test`, passwordHash: 'test-only' } }); ids.push(user.id)
    const newcomer = await prisma.organizationMember.create({ data: { userId: user.id, organizationId: orgId } })
    await prisma.locationMember.create({ data: { organizationId: orgId, memberId: newcomer.id, locationId: point1 } })
    const edited = await updateEvent(accounts.owner.id, orgId, event.id, editing(event, { description: 'Новая повестка', typeLabel: 'Встреча' }))
    assert.equal(edited.recipients.some(member => member.id === newcomer.id), false)
    assert.equal(await notifications(event.id, 'EVENT_CHANGED'), 0)
    const refreshed = await updateEvent(accounts.owner.id, orgId, event.id, editing(edited, { refreshRecipients: true }))
    assert.equal(refreshed.recipients.some(member => member.id === newcomer.id), true)
    assert.equal(await notifications(event.id, 'EVENT_PUBLISHED', user.id), 1)
    assert.equal(await notifications(event.id, 'EVENT_CHANGED'), 0)
  })
  it('notifies new recipients once and stops updates for removed recipients', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ audienceMode: 'SELECTED', memberIds: [accounts.employee.memberId] }))
    const edited = await updateEvent(accounts.owner.id, orgId, event.id, editing(event, { memberIds: [accounts.both.memberId], startTime: '12:00', endTime: '13:00' }))
    assert.equal(await notifications(event.id, 'EVENT_PUBLISHED', accounts.both.id), 1)
    assert.equal(await notifications(event.id, 'EVENT_CHANGED', accounts.both.id), 0)
    await cancelEvent(accounts.owner.id, orgId, event.id, edited.revision)
    assert.equal(await notifications(event.id, 'EVENT_CANCELLED', accounts.employee.id), 0)
    assert.equal(await notifications(event.id, 'EVENT_CANCELLED', accounts.both.id), 1)
    await assert.rejects(getEvent(accounts.employee.id, orgId, event.id), code('EVENT_NOT_FOUND'))
    const history = await listNotificationHistory(accounts.employee.id, accounts.employee.email, { limit: 50, category: 'EVENT', organizationId: orgId })
    assert.ok(!history.notifications.some(item => item.eventId === event.id))
  })
  it('creates material-change notifications but rejects stale edits and invalid periods', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input())
    const edited = await updateEvent(accounts.owner.id, orgId, event.id, editing(event, { place: 'Переговорная' }))
    assert.equal(await notifications(event.id, 'EVENT_CHANGED'), edited.recipientCount)
    await assert.rejects(updateEvent(accounts.owner.id, orgId, event.id, editing(event)), code('CONCURRENT_UPDATE'))
    await assert.rejects(updateEvent(accounts.owner.id, orgId, event.id, editing(edited, { endTime: '09:00' })), code('EVENT_INVALID_PERIOD'))
    const results = await Promise.allSettled([updateEvent(accounts.owner.id, orgId, event.id, editing(edited, { title: 'Версия А' })), updateEvent(accounts.owner.id, orgId, event.id, editing(edited, { title: 'Версия Б' }))])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(await prisma.eventChange.count({ where: { eventId: event.id } }), 3)
  })
  it('retains cancellation history, removes cancelled events from upcoming, and is idempotent', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ title: 'Cancelled unique' }))
    await cancelEvent(accounts.owner.id, orgId, event.id, event.revision)
    await cancelEvent(accounts.owner.id, orgId, event.id, event.revision)
    assert.equal(await notifications(event.id, 'EVENT_CANCELLED'), event.recipientCount)
    const upcoming = await listEvents(accounts.owner.id, orgId, listEventsQuery.parse({ search: 'Cancelled unique' }))
    assert.equal(upcoming.pagination.total, 0)
    const past = await listEvents(accounts.owner.id, orgId, listEventsQuery.parse({ tab: 'past', search: 'Cancelled unique' }))
    assert.equal(past.events[0].status, 'CANCELLED')
    await assert.rejects(updateEvent(accounts.owner.id, orgId, event.id, editing(event)), code('EVENT_CLOSED'))
  })
  it('integrates multi-point and shared notifications into history, links and unread counts', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ locationIds: [point1, point2] }))
    const shared = await createEvent(accounts.owner.id, orgId, input({ shared: true, locationIds: [] }))
    for (const locationId of [point1, point2]) {
      const history = await listNotificationHistory(accounts.both.id, accounts.both.email, { organizationId: orgId, locationId, category: 'EVENT', limit: 50 })
      const item = history.notifications.find(row => row.eventId === event.id)
      assert.ok(item); assert.ok(item.href?.includes(`/events?event=${event.id}`)); assert.ok(item.href?.includes(`location=${locationId}`))
      assert.ok(history.notifications.some(row => row.eventId === shared.id)); assert.ok(history.unreadCount > 0)
    }
    const other = await listNotificationHistory(accounts.both.id, accounts.both.email, { organizationId: orgId, locationId: point3, category: 'EVENT', limit: 50 })
    assert.ok(!other.notifications.some(row => row.eventId === event.id)); assert.ok(other.notifications.some(row => row.eventId === shared.id))
  })
  it('counts calendar dates in each event timezone and shares events with every point filter', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ title: 'Midnight unique', startDate: '2038-10-01', startTime: '00:10', endDate: null, endTime: null }))
    assert.equal(event.startAt.toISOString().slice(0, 10), '2038-09-30')
    assert.equal(eventDate({ startAt: event.startAt.toISOString(), timezone: event.timezone }), '2038-10-01')
    const page = await listEvents(accounts.owner.id, orgId, listEventsQuery.parse({ search: 'Midnight unique', from: '2038-10-01', to: '2038-10-02' }))
    assert.equal(page.pagination.total, 1); assert.deepEqual(page.markedDays, ['2038-10-01'])
    const shared = await createEvent(accounts.owner.id, orgId, input({ title: 'Shared unique', shared: true, locationIds: [] }))
    assert.equal(shared.timezone, 'Europe/Moscow')
    for (const pointId of [point1, point2, point3]) assert.equal((await listEvents(accounts.employee.id, orgId, listEventsQuery.parse({ pointId, search: 'Shared unique' }))).pagination.total, 1)
  })
  it('delivers start notifications atomically and deduplicates concurrent workers and restarts', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ audienceMode: 'SELECTED', memberIds: [accounts.employee.memberId] }))
    const now = new Date()
    await prisma.organizationEvent.update({ where: { id: event.id }, data: { startAt: new Date(now.getTime() - 1000), endAt: new Date(now.getTime() + 3600000) } })
    await Promise.all([deliverEventStarts(now), deliverEventStarts(now)])
    await deliverEventStarts(new Date(now.getTime() + 30000))
    assert.equal(await notifications(event.id, 'EVENT_STARTED'), 1)
    assert.ok((await prisma.organizationEvent.findUniqueOrThrow({ where: { id: event.id } })).startNotifiedAt)
  })
  it('reschedules starts, skips old starts and never sends for cancelled events', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ audienceMode: 'SELECTED', memberIds: [accounts.employee.memberId] }))
    const moved = await updateEvent(accounts.owner.id, orgId, event.id, editing(event, { startDate: '2038-10-13', endDate: '2038-10-13' }))
    await deliverEventStarts(event.startAt)
    assert.equal(await notifications(event.id, 'EVENT_STARTED'), 0)
    await deliverEventStarts(moved.startAt)
    assert.equal(await notifications(event.id, 'EVENT_STARTED'), 1)
    const stale = await createEvent(accounts.owner.id, orgId, input())
    await deliverEventStarts(new Date(stale.startAt.getTime() + 16 * 60000))
    assert.equal(await notifications(stale.id, 'EVENT_STARTED'), 0)
    const cancelled = await createEvent(accounts.owner.id, orgId, input())
    await cancelEvent(accounts.owner.id, orgId, cancelled.id, cancelled.revision)
    await deliverEventStarts(cancelled.startAt)
    assert.equal(await notifications(cancelled.id, 'EVENT_STARTED'), 0)
  })
  it('rolls back notification failures and retries start delivery without losing reservations', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ audienceMode: 'SELECTED', memberIds: [accounts.employee.memberId] }))
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_test_event_start() RETURNS trigger AS $$ BEGIN IF NEW.event_id = '${event.id}'::uuid AND NEW.type::text = 'EVENT_STARTED' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_test_event_start_trigger BEFORE INSERT ON account_notifications FOR EACH ROW EXECUTE FUNCTION reject_test_event_start()')
    try { await assert.rejects(deliverEventStarts(event.startAt)); assert.equal((await prisma.organizationEvent.findUniqueOrThrow({ where: { id: event.id } })).startNotifiedAt, null) } finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_test_event_start_trigger ON account_notifications'); await prisma.$executeRawUnsafe('DROP FUNCTION reject_test_event_start()') }
    await deliverEventStarts(event.startAt)
    assert.equal(await notifications(event.id, 'EVENT_STARTED'), 1)
  })
  it('revokes direct access and suppresses future notifications for departed members', async () => {
    const event = await createEvent(accounts.owner.id, orgId, input({ audienceMode: 'SELECTED', memberIds: [accounts.employee.memberId] }))
    await prisma.organizationMember.update({ where: { id: accounts.employee.memberId }, data: { leftAt: new Date() } })
    try {
      await assert.rejects(getEvent(accounts.employee.id, orgId, event.id), code('ORGANIZATION_NOT_FOUND'))
      await deliverEventStarts(event.startAt)
      assert.equal(await notifications(event.id, 'EVENT_STARTED'), 0)
      const history = await listNotificationHistory(accounts.employee.id, accounts.employee.email, { category: 'EVENT', limit: 50 })
      assert.equal(history.notifications.length, 0)
    } finally { await prisma.organizationMember.update({ where: { id: accounts.employee.memberId }, data: { leftAt: null } }) }
  })
})
