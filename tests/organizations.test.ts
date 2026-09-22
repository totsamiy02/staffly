import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/server/db.ts'
import { changeMemberRole, createOrganization, getOrganization, listOrganizations, removeMember } from '../src/server/organizations/organization-service.ts'
import { acceptCodeInvitation, acceptEmailInvitation, createCodeInvitation, createEmailInvitation, listActiveOrganizationInvitations, listPendingInvitations, previewCodeInvitation, rejectEmailInvitation, revokeInvitation } from '../src/server/organizations/invitation-service.ts'
import { confirmOrganizationDeletion, confirmOwnershipTransfer, requestOrganizationDeletion, requestOwnershipTransfer } from '../src/server/organizations/sensitive-action-service.ts'

const suffix = randomUUID().slice(0, 8)
const email = (name: string) => `${name}-${suffix}@example.test`
let owner: { id: string; email: string }
let admin: { id: string; email: string }
let member: { id: string; email: string }
let outsider: { id: string; email: string }

async function expectCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code))
}

before(async () => {
  await prisma.sensitiveActionToken.deleteMany()
  await prisma.organizationInvite.deleteMany()
  await prisma.organizationMember.deleteMany()
  await prisma.organization.deleteMany()
  await prisma.authSession.deleteMany()
  await prisma.emailVerificationToken.deleteMany()
  await prisma.passwordResetToken.deleteMany()
  await prisma.user.deleteMany()
  const users = await Promise.all(['owner', 'admin', 'member', 'outsider'].map((name) => prisma.user.create({ data: { email: email(name), passwordHash: 'test-only', emailVerifiedAt: new Date() } })))
  ;[owner, admin, member, outsider] = users.map(({ id, email: userEmail }) => ({ id, email: userEmail }))
})

after(async () => { await prisma.$disconnect() })

describe('organizations and authorization', { concurrency: false }, () => {
  it('creates an organization and its OWNER atomically', async () => {
    const organization = await createOrganization(owner.id, { name: 'Staffly Test', description: null, timezone: 'Europe/Moscow' })
    const membership = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: organization.id, userId: owner.id } } })
    assert.equal(membership?.role, 'OWNER')
    assert.equal((await listOrganizations(owner.id)).length, 1)
  })

  it('rolls back the organization if OWNER membership creation fails', async () => {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_test_membership() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END; $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_test_membership_trigger BEFORE INSERT ON organization_members FOR EACH ROW EXECUTE FUNCTION reject_test_membership()`)
    try {
      await assert.rejects(() => createOrganization(owner.id, { name: 'Must Roll Back', description: null, timezone: 'Europe/Moscow' }))
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER reject_test_membership_trigger ON organization_members`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION reject_test_membership()`)
    }
    assert.equal(await prisma.organization.count({ where: { name: 'Must Roll Back' } }), 0)
  })

  it('supports many organizations and many members while rejecting duplicate membership', async () => {
    const first = (await listOrganizations(owner.id))[0]
    const second = await createOrganization(owner.id, { name: 'Second Company', description: 'Test', timezone: 'UTC' })
    await prisma.organizationMember.create({ data: { organizationId: first.id, userId: admin.id, role: 'ADMIN' } })
    await prisma.organizationMember.create({ data: { organizationId: first.id, userId: member.id, role: 'MEMBER' } })
    await prisma.organizationMember.create({ data: { organizationId: second.id, userId: member.id, role: 'MEMBER' } })
    await assert.rejects(() => prisma.organizationMember.create({ data: { organizationId: first.id, userId: member.id } }))
    assert.equal((await listOrganizations(member.id)).length, 2)
  })

  it('isolates organizations and prevents MEMBER administrative actions', async () => {
    const first = (await listOrganizations(owner.id))[0]
    const second = (await listOrganizations(owner.id))[1]
    await expectCode(() => getOrganization(outsider.id, first.id), 'ORGANIZATION_NOT_FOUND')
    await expectCode(() => createEmailInvitation(member.id, first.id, email('new')), 'INSUFFICIENT_PERMISSIONS')
    const ownerMembership = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: first.id, userId: owner.id } } })
    await expectCode(() => changeMemberRole(admin.id, first.id, ownerMembership.id, 'MEMBER'), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => removeMember(admin.id, first.id, ownerMembership.id), 'INSUFFICIENT_PERMISSIONS')
    assert.notEqual(first.id, second.id)
  })
})

describe('invitations', { concurrency: false }, () => {
  it('handles a personal email invitation for a registered matching account', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const invited = await prisma.user.create({ data: { email: email('invited'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    const result = await createEmailInvitation(admin.id, organization.id, invited.email)
    assert.equal((await listPendingInvitations(invited.email)).length, 1)
    await expectCode(() => acceptEmailInvitation(outsider.id, outsider.email, result.invitation.id), 'INVITATION_EMAIL_MISMATCH')
    await acceptEmailInvitation(invited.id, invited.email, result.invitation.id)
    assert.equal((await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: organization.id, userId: invited.id } } }))?.role, 'MEMBER')
    await expectCode(() => acceptEmailInvitation(invited.id, invited.email, result.invitation.id), 'INVITATION_ALREADY_USED')
  })

  it('stores an invitation for an email that has no account and prevents active duplicates', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const unregistered = email('future')
    const result = await createEmailInvitation(owner.id, organization.id, unregistered)
    assert.equal(result.invitation.invitedEmail, unregistered)
    await expectCode(() => createEmailInvitation(owner.id, organization.id, unregistered), 'INVITATION_ALREADY_EXISTS')
    const future = await prisma.user.create({ data: { email: unregistered, passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    await acceptEmailInvitation(future.id, future.email, result.invitation.id)
  })

  it('rejects expired, rejected, and revoked invitations', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const expired = await createEmailInvitation(owner.id, organization.id, email('expired'))
    await prisma.organizationInvite.update({ where: { id: expired.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await expectCode(() => acceptEmailInvitation(outsider.id, expired.invitation.invitedEmail!, expired.invitation.id), 'INVITATION_EXPIRED')
    const rejected = await createEmailInvitation(owner.id, organization.id, email('rejected'))
    await rejectEmailInvitation(rejected.invitation.invitedEmail!, rejected.invitation.id)
    await expectCode(() => acceptEmailInvitation(outsider.id, rejected.invitation.invitedEmail!, rejected.invitation.id), 'INVITATION_REJECTED')
    const revoked = await createEmailInvitation(owner.id, organization.id, email('revoked'))
    assert.ok((await listActiveOrganizationInvitations(owner.id, organization.id)).some((invitation) => invitation.id === revoked.invitation.id))
    await expectCode(() => listActiveOrganizationInvitations(member.id, organization.id), 'INSUFFICIENT_PERMISSIONS')
    await revokeInvitation(owner.id, organization.id, revoked.invitation.id)
    assert.equal((await listActiveOrganizationInvitations(owner.id, organization.id)).some((invitation) => invitation.id === revoked.invitation.id), false)
    await expectCode(() => acceptEmailInvitation(outsider.id, revoked.invitation.invitedEmail!, revoked.invitation.id), 'INVITATION_REVOKED')
  })

  it('accepts a code once and resists concurrent consumption', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const codeInvite = await createCodeInvitation(admin.id, organization.id)
    assert.equal((await previewCodeInvitation(outsider.id, codeInvite.code)).organization.id, organization.id)
    const attempts = await Promise.allSettled([
      acceptCodeInvitation(outsider.id, outsider.email, codeInvite.code),
      acceptCodeInvitation(member.id, member.email, codeInvite.code),
    ])
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(await prisma.organizationMember.count({ where: { organizationId: organization.id, userId: { in: [outsider.id, member.id] } } }), 2)
    await expectCode(() => previewCodeInvitation(outsider.id, codeInvite.code), 'INVITATION_ALREADY_USED')
  })

  it('expires one-time codes after ten minutes', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const result = await createCodeInvitation(owner.id, organization.id)
    await prisma.organizationInvite.update({ where: { id: result.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await expectCode(() => previewCodeInvitation(outsider.id, result.code), 'INVITATION_EXPIRED')
  })
})

describe('roles and sensitive actions', { concurrency: false }, () => {
  it('lets OWNER and ADMIN manage non-owner roles with the documented limits', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const target = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: member.id } } })
    await changeMemberRole(admin.id, organization.id, target.id, 'ADMIN')
    assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: target.id } })).role, 'ADMIN')
    await changeMemberRole(owner.id, organization.id, target.id, 'MEMBER')
  })

  it('requires a one-time email code and atomically transfers ownership', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const target = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: member.id } } })
    await expectCode(() => requestOwnershipTransfer(admin.id, organization.id, target.id), 'INSUFFICIENT_PERMISSIONS')
    const request = await requestOwnershipTransfer(owner.id, organization.id, target.id)
    await expectCode(() => confirmOwnershipTransfer(owner.id, organization.id, '000000'), 'INVALID_VERIFICATION_CODE')
    await confirmOwnershipTransfer(owner.id, organization.id, request.code)
    const roles = await prisma.organizationMember.findMany({ where: { organizationId: organization.id, role: 'OWNER' } })
    assert.equal(roles.length, 1)
    assert.equal(roles[0].userId, member.id)
    await expectCode(() => confirmOwnershipTransfer(owner.id, organization.id, request.code), 'INSUFFICIENT_PERMISSIONS')
  })

  it('allows only the current OWNER to soft-delete and revokes pending invites', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const pending = await createEmailInvitation(member.id, organization.id, email('before-delete'))
    await expectCode(() => requestOrganizationDeletion(admin.id, organization.id), 'INSUFFICIENT_PERMISSIONS')
    const request = await requestOrganizationDeletion(member.id, organization.id)
    await confirmOrganizationDeletion(member.id, organization.id, request.code)
    assert.ok((await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } })).deletedAt)
    assert.ok((await prisma.organizationInvite.findUniqueOrThrow({ where: { id: pending.invitation.id } })).revokedAt)
    await expectCode(() => getOrganization(owner.id, organization.id), 'ORGANIZATION_NOT_FOUND')
    assert.equal((await listOrganizations(owner.id)).some((item) => item.id === organization.id), false)
  })
})
