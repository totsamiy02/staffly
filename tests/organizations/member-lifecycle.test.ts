import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { hasPermission } from '../../src/server/organizations/access/access.ts'
import { previewDeparture, confirmDeparture } from '../../src/server/organizations/departure-service.ts'
import { removeMember } from '../../src/server/organizations/organization-service.ts'
import { createCodeInvitation, createEmailInvitation, previewCodeInvitation, acceptCodeInvitation, acceptEmailInvitation } from '../../src/server/organizations/invitation-service.ts'

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected
after(() => prisma.$disconnect())

async function fixture() {
  const [owner, employee] = await Promise.all(['owner', 'employee'].map(name => prisma.user.create({ data: { email: `lifecycle-${name}-${randomUUID()}@example.test`, emailVerifiedAt: new Date() } })))
  const org = await createBusinessOrganization(owner.id, { name: 'Member lifecycle', description: null, timezone: 'Europe/Moscow' })
  const second = await prisma.organizationLocation.create({ data: { organizationId: org.id, name: 'Second', city: 'Москва', address: 'Тест', timezone: 'Europe/Moscow' } })
  const member = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: employee.id, joinedAt: new Date('2020-01-01T00:00:00Z'), accessConfigured: true } })
  const role = await prisma.accessRole.create({ data: { organizationId: org.id, name: 'Privileged', permissions: ['schedule.edit', 'members.invite'] } })
  const ownerMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } })
  await prisma.organizationMember.update({ where: { id: member.id }, data: { accessRoleId: role.id } })
  await prisma.locationMember.create({ data: { organizationId: org.id, memberId: member.id, locationId: org.locationId, role: 'ADMIN' } })
  await prisma.accessAssignment.create({ data: { organizationId: org.id, memberId: member.id, locationId: org.locationId, roleId: role.id } })
  const team = await prisma.locationTeam.create({ data: { organizationId: org.id, locationId: org.locationId, name: 'Old team' } })
  await prisma.locationTeamMember.create({ data: { organizationId: org.id, memberId: member.id, teamId: team.id } })
  const transfer = await prisma.locationTransfer.create({ data: { organizationId: org.id, memberId: member.id, createdByMemberId: ownerMember.id, fromLocationId: org.locationId, toLocationId: second.id, temporary: true, startAt: new Date(Date.now() + 86400000), endAt: new Date(Date.now() + 3 * 86400000) } })
  const at = <T>(locationId: string, work: () => T) => locationContext.run({ organizationId: org.id, locationId }, work)
  const invite = async (kind: 'email' | 'code', locationId = org.locationId) => at(locationId, async () => {
    if (kind === 'email') {
      const { invitation } = await createEmailInvitation(owner.id, org.id, employee.email)
      return () => acceptEmailInvitation(employee.id, employee.email, invitation.id)
    }
    const invitation = await createCodeInvitation(owner.id, org.id)
    await previewCodeInvitation(employee.id, invitation.code)
    return () => acceptCodeInvitation(employee.id, employee.email, invitation.code)
  })
  return { owner, employee, org, second, member, role, transfer, at, invite }
}

describe('employee access across departure, return and point invitations', () => {
  for (const kind of ['email', 'code'] as const) {
    it(`returns through ${kind} with basic access, keeping identity and past shifts`, async () => {
      const f = await fixture()
      const past = await prisma.workShift.create({ data: { organizationId: f.org.id, locationId: f.org.locationId, memberId: f.member.id, createdByMemberId: f.member.id, scheduledStartAt: new Date('2020-01-02T06:00:00Z'), scheduledEndAt: new Date('2020-01-02T14:00:00Z') } })
      await f.at(f.org.locationId, async () => {
        const preview = await previewDeparture(f.owner.id, f.org.id, f.member.id, 'organization')
        await confirmDeparture(f.owner.id, f.org.id, f.member.id, { scope: 'organization', token: preview.token, reason: 'Завершение работы', choices: [], keepCurrent: false, acknowledgeDrafts: false, acknowledgeWorkload: false })
      })
      const departed = await prisma.organizationMember.findUniqueOrThrow({ where: { id: f.member.id } })
      assert.equal(departed.accessRoleId, null)
      await assert.rejects(getMembership(f.employee.id, f.org.id), code('ORGANIZATION_NOT_FOUND'))
      await (await f.invite(kind))()
      const actor = await f.at(f.org.locationId, () => getMembership(f.employee.id, f.org.id))
      assert.equal(actor.id, f.member.id)
      assert.equal(+actor.joinedAt, +f.member.joinedAt)
      assert.equal(actor.accessRoleId, null)
      assert.equal(hasPermission(actor, 'schedule.edit'), false)
      assert.equal(hasPermission(actor, 'schedule.own'), true)
      assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: past.id } })).memberId, f.member.id)
      assert.ok((await prisma.locationTransfer.findUniqueOrThrow({ where: { id: f.transfer.id } })).revokedAt)
    })

    it(`cleans historical stale grants when a former member returns through ${kind}`, async () => {
      const f = await fixture()
      // Older departures could leave active placements and explicit grants behind.
      await prisma.organizationMember.update({ where: { id: f.member.id }, data: { leftAt: new Date() } })
      await (await f.invite(kind, f.second.id))()
      const actor = await f.at(f.second.id, () => getMembership(f.employee.id, f.org.id))
      assert.equal(hasPermission(actor, 'schedule.edit'), false)
      assert.equal(hasPermission(actor, 'schedule.own'), true)
      assert.equal(hasPermission(actor, 'schedule.own', f.org.locationId), false)
      assert.equal(await prisma.accessAssignment.count({ where: { memberId: f.member.id } }), 0)
      assert.equal(await prisma.locationTeamMember.count({ where: { memberId: f.member.id } }), 0)
      assert.ok((await prisma.locationMember.findUniqueOrThrow({ where: { locationId_memberId: { locationId: f.org.locationId, memberId: f.member.id } } })).leftAt)
      assert.ok((await prisma.locationTransfer.findUniqueOrThrow({ where: { id: f.transfer.id } })).revokedAt)
    })
  }

  it('revokes global, local and temporary access through the legacy departure service too', async () => {
    const f = await fixture()
    await removeMember(f.owner.id, f.org.id, f.member.id)
    assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: f.member.id } })).accessRoleId, null)
    assert.equal(await prisma.accessAssignment.count({ where: { memberId: f.member.id } }), 0)
    assert.ok((await prisma.locationTransfer.findUniqueOrThrow({ where: { id: f.transfer.id } })).revokedAt)
  })

  it('previews and accepts a code for another point, granting its standard member role', async () => {
    const f = await fixture()
    await prisma.organizationMember.update({ where: { id: f.member.id }, data: { accessRoleId: null } })
    await (await f.invite('code', f.second.id))()
    const actor = await f.at(f.second.id, () => getMembership(f.employee.id, f.org.id))
    assert.equal(hasPermission(actor, 'schedule.own'), true)
    assert.equal(hasPermission(actor, 'schedule.edit'), false)
    assert.equal(hasPermission(actor, 'schedule.edit', f.org.locationId), true)
    assert.equal(actor.accessConfigured, true)
  })

  it('preserves an explicitly assigned role when adding an active employee to a point', async () => {
    const f = await fixture()
    await prisma.accessAssignment.create({ data: { organizationId: f.org.id, memberId: f.member.id, locationId: f.second.id, roleId: f.role.id } })
    await (await f.invite('email', f.second.id))()
    assert.equal((await prisma.accessAssignment.findUniqueOrThrow({ where: { memberId_locationId: { memberId: f.member.id, locationId: f.second.id } } })).roleId, f.role.id)
  })

  it('still refuses a code for a point the employee already belongs to', async () => {
    const f = await fixture()
    const invitation = await f.at(f.org.locationId, () => createCodeInvitation(f.owner.id, f.org.id))
    await assert.rejects(previewCodeInvitation(f.employee.id, invitation.code), code('ALREADY_MEMBER'))
    await assert.rejects(acceptCodeInvitation(f.employee.id, f.employee.email, invitation.code), code('ALREADY_MEMBER'))
    assert.equal((await prisma.organizationInvite.findUniqueOrThrow({ where: { id: invitation.invitation.id } })).acceptedAt, null)
  })
})
