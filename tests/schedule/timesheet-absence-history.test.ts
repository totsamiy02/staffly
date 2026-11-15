import assert from 'node:assert/strict'
import { it, after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { actOnTimesheet, readTimesheet } from '../../src/server/schedule/timesheets/service.ts'
import { changeAbsence } from '../../src/server/schedule/absence-service.ts'
import { timesheetDatabaseError } from '../../src/server/schedule/timesheets/errors.ts'

after(() => prisma.$disconnect())
it('requires an explicit author and reason for changes to an absence in a closed period', async () => {
  const user = await prisma.user.create({ data: { email: `absence-history-${randomUUID()}@example.test` } })
  const org = await createBusinessOrganization(user.id, { name: 'История отсутствий', description: null, timezone: 'Europe/Moscow' })
  const member = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: user.id } } })
  await prisma.locationMember.update({
    where: { locationId_memberId: { locationId: org.locationId, memberId: member.id } },
    data: { joinedAt: new Date('2020-01-01') }
  })
  const scope = <T>(work: () => T) => locationContext.run({ organizationId: org.id, locationId: org.locationId }, work)
  const absence = await prisma.employeeAbsence.create({
    data: {
      organizationId: org.id,
      memberId: member.id,
      type: 'SICK',
      startDate: new Date('2025-10-06'),
      endDate: new Date('2025-10-07')
    }
  })
  const preview = await scope(() => readTimesheet(user.id, org.id, '2025-10'))
  await scope(() => actOnTimesheet(user.id, org.id, '2025-10', { action: 'CLOSE', revision: 0, snapshotToken: preview.snapshotToken }))
  const body = { startDate: '2025-10-06', endDate: '2025-10-08', updatedAt: absence.updatedAt.toISOString() }
  await assert.rejects(scope(() => changeAbsence(user.id, org.id, absence.id, body)), error => timesheetDatabaseError(error)?.code === 'TIMESHEET_REASON_REQUIRED')
  await scope(() => changeAbsence(user.id, org.id, absence.id, { ...body, changeReason: 'Уточнена дата закрытия больничного' }))
  const current = await scope(() => readTimesheet(user.id, org.id, '2025-10'))
  assert.equal(current.changedSinceClose, true)
  assert.equal(current.snapshot.members[0].sickDays, 2)
  assert(current.events.some(event => event.kind === 'LATE_ABSENCE' && event.actorMemberId === member.id && event.reason === 'Уточнена дата закрытия больничного'))
  await prisma.timesheetEvent.createMany({
    data: Array.from({ length: 60 }, () => ({
      periodId: current.period!.id,
      actorMemberId: member.id,
      actorName: 'Проверяющий',
      kind: 'CORRECTION',
      reason: 'Синтетическая проверка полной истории'
    }))
  })
  const firstPage = await scope(() => readTimesheet(user.id, org.id, '2025-10', 1))
  const secondPage = await scope(() => readTimesheet(user.id, org.id, '2025-10', 2))
  assert.equal(firstPage.events.length, 50)
  assert.equal(firstPage.historyPagination.pages, 2)
  assert.equal(secondPage.events.length, 12)
  assert(secondPage.events.some(event => event.kind === 'CLOSE'))

})
