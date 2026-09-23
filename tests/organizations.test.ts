import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/server/db.ts'
import { changeMemberRole, createOrganization, getOrganization, listAccountNotifications, listMembers, listMembersPage, listOrganizations, readAccountNotification, removeMember, updateOrganization } from '../src/server/organizations/organization-service.ts'
import { acceptCodeInvitation, acceptEmailInvitation, createCodeInvitation, createEmailInvitation, listActiveOrganizationInvitations, listPendingInvitations, previewCodeInvitation, rejectEmailInvitation, revokeInvitation } from '../src/server/organizations/invitation-service.ts'
import { confirmOrganizationDeletion, confirmOwnershipTransfer, requestOrganizationDeletion, requestOwnershipTransfer } from '../src/server/organizations/sensitive-action-service.ts'
import { updateProfileBody } from '../src/server/profile/schemas.ts'
import { updateOrganizationBody } from '../src/server/organizations/schemas.ts'
import { passwordValidationError } from '../src/app/auth/password-policy.ts'
import { cancelShift, correctActualTime, createShift, getShift, listMyUpcomingShifts, listSchedule, listShiftNotifications, readShiftNotification } from '../src/server/schedule/service.ts'
import { memberStatistics, myStatistics, organizationStatistics } from '../src/server/schedule/statistics.ts'
import { zonedDateTimeToUtc } from '../src/server/schedule/timezone.ts'
import { calendarRange, moveMonth } from '../src/app/schedule/date-utils.ts'
import sharp from 'sharp'
import { cleanupPendingFiles, removeOrganizationLogo, removeUserAvatar, replaceOrganizationLogo, replaceUserAvatar } from '../src/server/storage/image-service.ts'
import { writeObject } from '../src/server/storage/local-file-storage.ts'
import { formatRussianPhone, normalizeRussianPhone } from '../src/app/profile/phone.ts'

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
  await prisma.accountNotification.deleteMany()
  await prisma.workShiftAdjustment.deleteMany()
  await prisma.workShift.deleteMany()
  await prisma.sensitiveActionToken.deleteMany()
  await prisma.organizationInvite.deleteMany()
  await prisma.organizationMember.deleteMany()
  await prisma.user.updateMany({ data: { avatarFileId: null } })
  await prisma.organization.updateMany({ data: { logoFileId: null } })
  await prisma.storedFile.deleteMany()
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
    const second = await createOrganization(owner.id, { name: 'Second Company', description: 'Test', timezone: 'Europe/Samara' })
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

describe('profiles and public organization details', { concurrency: false }, () => {
  it('validates, normalizes and replaces profile and organization images', async () => {
    const image = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#444444' } }).png().toBuffer()
    const avatarUrl = await replaceUserAvatar(owner.id, image)
    assert.match(avatarUrl!, /^\/api\/media\/[0-9a-f-]{36}$/)
    const avatar = await prisma.user.findUniqueOrThrow({ where: { id: owner.id }, include: { avatar: true } })
    assert.equal(avatar.avatar?.mimeType, 'image/webp')
    assert.equal(avatar.avatar?.purpose, 'USER_AVATAR')
    assert.ok((avatar.avatar?.size ?? 0) < image.length)
    await expectCode(() => replaceUserAvatar(owner.id, Buffer.from('not an image')), 'INVALID_IMAGE')
    await removeUserAvatar(owner.id)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).avatarFileId, null)

    const organization = (await listOrganizations(owner.id))[0]
    await expectCode(() => replaceOrganizationLogo(member.id, organization.id, image), 'INSUFFICIENT_PERMISSIONS')
    const logoUrl = await replaceOrganizationLogo(admin.id, organization.id, image)
    assert.match(logoUrl!, /^\/api\/media\/[0-9a-f-]{36}$/)
    assert.equal((await getOrganization(owner.id, organization.id)).logoUrl, logoUrl)
    await removeOrganizationLogo(owner.id, organization.id)
    assert.equal((await getOrganization(owner.id, organization.id)).logoUrl, null)
  })

  it('keeps failed deletions in a durable queue and retries them', async () => {
    const fileId = randomUUID()
    const objectKey = `users/${owner.id}/avatars/${randomUUID()}.webp`
    await writeObject(objectKey, Buffer.from('queued cleanup test'))
    await prisma.storedFile.create({ data: { id: fileId, objectKey, mimeType: 'image/webp', size: 19, checksumSha256: '0'.repeat(64), purpose: 'USER_AVATAR', uploadedByUserId: owner.id, pendingDeletionAt: new Date() } })
    const failed = await cleanupPendingFiles({ removeObject: async () => { throw new Error('simulated filesystem outage') } })
    assert.equal(failed.deleted, 0)
    const pending = await prisma.storedFile.findUniqueOrThrow({ where: { id: fileId } })
    assert.equal(pending.deletionAttempts, 1)
    assert.equal(pending.lastDeletionError, 'simulated filesystem outage')
    const retried = await cleanupPendingFiles()
    assert.equal(retried.deleted, 1)
    assert.equal(await prisma.storedFile.findUnique({ where: { id: fileId } }), null)
  })

  it('normalizes and validates personal profile fields and Russian phone numbers', () => {
    const profile = updateProfileBody.parse({ firstName: ' Анна ', lastName: 'Иванова', middleName: '', phone: '8 (999) 123-45-67', bio: ' Руководитель команды ' })
    assert.equal(profile.firstName, 'Анна')
    assert.equal(profile.phone, '+79991234567')
    assert.equal(profile.middleName, null)
    assert.equal(updateProfileBody.safeParse({ firstName: 'Анна1', lastName: '', middleName: '', phone: '+1 555 123 4567', bio: '' }).success, false)
    assert.equal(formatRussianPhone('8 999 123 45 67'), '+7 (999) 123-45-67')
    assert.equal(formatRussianPhone('+1 555 123 4567'), '')
    assert.equal(normalizeRussianPhone('+7 (999) 123-45-67'), '+79991234567')
    assert.ok(passwordValidationError('password'))
    assert.equal(passwordValidationError('StrongPass1!'), '')
  })

  it('lets OWNER and ADMIN edit public organization data and exposes member profiles safely', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    await updateOrganization(admin.id, organization.id, { name: organization.name, description: 'Открытая кофейня', timezone: 'Europe/Moscow', contactEmail: 'team@example.test', phone: '+79991234567', website: 'https://example.test', address: 'Москва' })
    await expectCode(() => updateOrganization(member.id, organization.id, { name: organization.name, description: null, timezone: 'UTC', contactEmail: null, phone: null, website: null, address: null }), 'INSUFFICIENT_PERMISSIONS')
    await prisma.user.update({ where: { id: member.id }, data: { firstName: 'Анна', lastName: 'Иванова', phone: '+79991234567', lastSeenAt: new Date() } })
    const memberProfile = (await listMembers(owner.id, organization.id)).find((item) => item.userId === member.id)
    assert.equal(memberProfile?.displayName, 'Иванова Анна')
    assert.equal(memberProfile?.online, true)
    const filtered = await listMembersPage(owner.id, organization.id, { page: 1, pageSize: 20, role: 'MEMBER', search: 'Иванова Анна' })
    assert.equal(filtered.pagination.total, 1)
    assert.equal(filtered.members[0]?.userId, member.id)
    assert.equal((await getOrganization(owner.id, organization.id)).contactEmail, 'team@example.test')
  })

  it('validates and normalizes public organization fields', () => {
    const data = updateOrganizationBody.parse({ name: ' Кофейня ', description: '', timezone: 'Europe/Moscow', contactEmail: ' TEAM@EXAMPLE.RU ', phone: '8 (999) 123-45-67', website: 'https://example.ru', address: ' Москва ' })
    assert.equal(data.name, 'Кофейня')
    assert.equal(data.contactEmail, 'team@example.ru')
    assert.equal(data.phone, '+79991234567')
    assert.equal(data.address, 'Москва')
    assert.equal(updateOrganizationBody.safeParse({ ...data, phone: '+1 555 123 4567' }).success, false)
    assert.equal(updateOrganizationBody.safeParse({ ...data, website: 'javascript:alert(1)' }).success, false)
    assert.equal(updateOrganizationBody.safeParse({ ...data, timezone: 'Mars/Olympus' }).success, false)
    assert.equal(updateOrganizationBody.safeParse({ ...data, timezone: 'UTC' }).success, false)
  })
})

describe('roles and sensitive actions', { concurrency: false }, () => {
  it('lets OWNER and ADMIN manage non-owner roles with the documented limits', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const target = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: member.id } } })
    await changeMemberRole(admin.id, organization.id, target.id, 'ADMIN')
    assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: target.id } })).role, 'ADMIN')
    const roleNotification = (await listAccountNotifications(member.id)).find((notification) => notification.organizationId === organization.id)
    assert.equal(roleNotification?.type, 'ROLE_CHANGED')
    await readAccountNotification(member.id, roleNotification!.id)
    assert.equal((await listAccountNotifications(member.id)).some((notification) => notification.id === roleNotification!.id), false)
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

describe('work schedule and time statistics', { concurrency: false }, () => {
  let scheduleOrganizationId = ''
  let scheduleOwnerMemberId = ''
  let scheduleAdminMemberId = ''
  let scheduleEmployeeMemberId = ''

  it('prepares an isolated organization and respects IANA timezone conversion', async () => {
    const organization = await createOrganization(owner.id, { name: 'Schedule Test', description: null, timezone: 'Europe/Moscow' })
    scheduleOrganizationId = organization.id
    const memberships = await Promise.all([
      prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: owner.id } } }),
      prisma.organizationMember.create({ data: { organizationId: organization.id, userId: admin.id, role: 'ADMIN' } }),
      prisma.organizationMember.create({ data: { organizationId: organization.id, userId: member.id, role: 'MEMBER' } }),
    ])
    ;[scheduleOwnerMemberId, scheduleAdminMemberId, scheduleEmployeeMemberId] = memberships.map((item) => item.id)
    assert.equal(zonedDateTimeToUtc('2026-09-23', '10:00', 'Europe/Moscow').toISOString(), '2026-09-23T07:00:00.000Z')
    assert.equal(zonedDateTimeToUtc('2026-07-01', '10:00', 'America/New_York').toISOString(), '2026-07-01T14:00:00.000Z')
    assert.throws(() => zonedDateTimeToUtc('2026-03-08', '02:30', 'America/New_York'), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_LOCAL_TIME'))
    assert.equal(calendarRange('2028-02').days.length, 42)
    assert.ok(calendarRange('2028-02').days.includes('2028-02-29'))
    assert.equal(calendarRange('2027-02').days.includes('2027-02-29'), false)
    assert.ok(calendarRange('2036-02').days.includes('2036-02-29'))
    assert.equal(moveMonth('2036-12', 1), '2037-01')
  })

  it('allows OWNER and ADMIN to create normal and overnight shifts while rejecting MEMBER and foreign memberships', async () => {
    const ownerShift = await createShift(owner.id, scheduleOrganizationId, { memberId: scheduleEmployeeMemberId, startDate: '2025-01-10', startTime: '10:00', endDate: '2025-01-10', endTime: '22:00', breakMinutes: 60, description: 'Основной зал' })
    assert.equal(ownerShift.effectiveMinutes, 720)
    const overnight = await createShift(admin.id, scheduleOrganizationId, { memberId: scheduleAdminMemberId, startDate: '2025-01-11', startTime: '20:00', endDate: '2025-01-12', endTime: '08:00', breakMinutes: 30, description: null })
    assert.equal(overnight.effectiveMinutes, 720)
    await expectCode(() => createShift(member.id, scheduleOrganizationId, { memberId: scheduleEmployeeMemberId, startDate: '2025-01-13', startTime: '10:00', endDate: '2025-01-13', endTime: '18:00', breakMinutes: 0, description: null }), 'INSUFFICIENT_PERMISSIONS')
    const foreign = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: { not: scheduleOrganizationId }, userId: outsider.id } })
    await expectCode(() => createShift(owner.id, scheduleOrganizationId, { memberId: foreign.id, startDate: '2025-01-13', startTime: '10:00', endDate: '2025-01-13', endTime: '18:00', breakMinutes: 0, description: null }), 'MEMBER_NOT_FOUND')
  })

  it('validates ranges and prevents normal, overnight, and concurrent overlaps', async () => {
    const invalid = { memberId: scheduleEmployeeMemberId, startDate: '2025-02-01', startTime: '10:00', endDate: '2025-02-01', endTime: '10:00', breakMinutes: 0, description: null }
    await expectCode(() => createShift(owner.id, scheduleOrganizationId, invalid), 'INVALID_SHIFT_RANGE')
    await expectCode(() => createShift(owner.id, scheduleOrganizationId, { ...invalid, endTime: '12:00', breakMinutes: 120 }), 'INVALID_SHIFT_BREAK')
    await createShift(owner.id, scheduleOrganizationId, { ...invalid, startDate: '2025-02-02', startTime: '20:00', endDate: '2025-02-03', endTime: '08:00' })
    await expectCode(() => createShift(owner.id, scheduleOrganizationId, { ...invalid, startDate: '2025-02-03', startTime: '06:00', endDate: '2025-02-03', endTime: '14:00' }), 'SHIFT_OVERLAP')
    const concurrent = await Promise.allSettled([
      createShift(owner.id, scheduleOrganizationId, { ...invalid, startDate: '2025-02-05', startTime: '09:00', endDate: '2025-02-05', endTime: '17:00' }),
      createShift(admin.id, scheduleOrganizationId, { ...invalid, startDate: '2025-02-05', startTime: '12:00', endDate: '2025-02-05', endTime: '20:00' }),
    ])
    assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1)
  })

  it('counts finished shifts automatically, separates future plans, and records actual-time audit', async () => {
    const future = await createShift(owner.id, scheduleOrganizationId, { memberId: scheduleEmployeeMemberId, startDate: '2027-03-01', startTime: '10:00', endDate: '2027-03-01', endTime: '18:00', breakMinutes: 60, description: null })
    const before = await memberStatistics(owner.id, scheduleOrganizationId, scheduleEmployeeMemberId, { from: '2025-01-01', to: '2028-01-01', memberState: 'all', sort: 'name', direction: 'asc', page: 1, limit: 50 })
    assert.ok((before.period?.workedMinutes ?? 0) >= 720)
    assert.equal(before.period?.plannedMinutes, 480)
    assert.equal(before.period?.plannedShifts, 1)
    const upcoming = await listMyUpcomingShifts(member.id, scheduleOrganizationId)
    assert.deepEqual(upcoming.shifts.map((shift) => shift.id), [future.id])
    assert.ok((await listShiftNotifications(member.id)).some((notification) => notification.id === future.id))
    await readShiftNotification(member.id, future.id)
    assert.equal((await listShiftNotifications(member.id)).some((notification) => notification.id === future.id), false)
    const past = await prisma.workShift.findFirstOrThrow({ where: { organizationId: scheduleOrganizationId, memberId: scheduleEmployeeMemberId, scheduledStartAt: { lt: new Date('2026-01-01') } }, orderBy: { scheduledStartAt: 'asc' } })
    await expectCode(() => correctActualTime(member.id, scheduleOrganizationId, past.id, { startDate: '2025-01-10', startTime: '10:00', endDate: '2025-01-10', endTime: '18:00', breakMinutes: 0, reason: 'Ушёл раньше' }), 'INSUFFICIENT_PERMISSIONS')
    await correctActualTime(admin.id, scheduleOrganizationId, past.id, { startDate: '2025-01-10', startTime: '11:00', endDate: '2025-01-10', endTime: '18:00', breakMinutes: 30, reason: 'Опоздание и ранний уход' })
    assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: past.id } }), 1)
    const after = await myStatistics(member.id, scheduleOrganizationId, { from: '2025-01-01', to: '2028-01-01', memberState: 'all', sort: 'name', direction: 'asc', page: 1, limit: 50 })
    assert.equal(after.period?.workedMinutes, (before.period?.workedMinutes ?? 0) - 300)
    await cancelShift(owner.id, scheduleOrganizationId, future.id, 'График изменён')
    const cancelled = await myStatistics(member.id, scheduleOrganizationId, { from: '2025-01-01', to: '2028-01-01', memberState: 'all', sort: 'name', direction: 'asc', page: 1, limit: 50 })
    assert.equal(cancelled.period?.plannedMinutes, 0)
    assert.equal(cancelled.period?.plannedShifts, 0)
  })

  it('allows cancelled slots to be reused and includes overnight shifts crossing a requested month boundary', async () => {
    const first = await createShift(owner.id, scheduleOrganizationId, { memberId: scheduleEmployeeMemberId, startDate: '2027-06-01', startTime: '09:00', endDate: '2027-06-01', endTime: '17:00', breakMinutes: 0, description: null })
    await cancelShift(admin.id, scheduleOrganizationId, first.id, 'Перенос графика')
    const replacement = await createShift(owner.id, scheduleOrganizationId, { memberId: scheduleEmployeeMemberId, startDate: '2027-06-01', startTime: '09:00', endDate: '2027-06-01', endTime: '17:00', breakMinutes: 30, description: 'Новая смена' })
    assert.equal(replacement.status, 'SCHEDULED')
    const boundary = await createShift(owner.id, scheduleOrganizationId, { memberId: scheduleAdminMemberId, startDate: '2027-06-30', startTime: '20:00', endDate: '2027-07-01', endTime: '08:00', breakMinutes: 0, description: null })
    const july = await listSchedule(member.id, scheduleOrganizationId, '2027-07-01', '2027-08-01')
    assert.ok(july.shifts.some((shift) => shift.id === boundary.id))
  })

  it('sorts statistics on the backend, supports all-time totals, and blocks nested-resource IDOR', async () => {
    const adminView = await organizationStatistics(admin.id, scheduleOrganizationId, { memberState: 'all', sort: 'workedMinutes', direction: 'desc', page: 1, limit: 50 })
    assert.ok(adminView.summary.workedShifts > 0)
    assert.ok(adminView.members.every((item, index, items) => index === 0 || items[index - 1].workedMinutes >= item.workedMinutes))
    const byShifts = await organizationStatistics(owner.id, scheduleOrganizationId, { from: '2025-01-01', to: '2028-01-01', memberState: 'all', sort: 'workedShifts', direction: 'asc', page: 1, limit: 50 })
    assert.ok(byShifts.members.every((item, index, items) => index === 0 || items[index - 1].workedShifts <= item.workedShifts))
    await expectCode(() => listSchedule(outsider.id, scheduleOrganizationId, '2025-01-01', '2025-03-01'), 'ORGANIZATION_NOT_FOUND')
    const shift = await prisma.workShift.findFirstOrThrow({ where: { organizationId: scheduleOrganizationId } })
    await expectCode(() => getShift(outsider.id, scheduleOrganizationId, shift.id), 'ORGANIZATION_NOT_FOUND')
    const otherOrganization = await createOrganization(outsider.id, { name: 'Other Schedule', description: null, timezone: 'Europe/Kaliningrad' })
    const otherMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: otherOrganization.id, userId: outsider.id } } })
    const otherShift = await createShift(outsider.id, otherOrganization.id, { memberId: otherMember.id, startDate: '2025-01-01', startTime: '09:00', endDate: '2025-01-01', endTime: '17:00', breakMinutes: 0, description: null })
    await expectCode(() => getShift(owner.id, scheduleOrganizationId, otherShift.id), 'SHIFT_NOT_FOUND')
  })

  it('restricts organization statistics and preserves former employee history while cancelling future shifts', async () => {
    await expectCode(() => organizationStatistics(member.id, scheduleOrganizationId, { from: '2025-01-01', to: '2028-01-01', memberState: 'all', sort: 'workedMinutes', direction: 'desc', page: 1, limit: 50 }), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => memberStatistics(member.id, scheduleOrganizationId, scheduleAdminMemberId, { from: '2025-01-01', to: '2028-01-01', memberState: 'all', sort: 'name', direction: 'asc', page: 1, limit: 50 }), 'INSUFFICIENT_PERMISSIONS')
    const future = await createShift(owner.id, scheduleOrganizationId, { memberId: scheduleAdminMemberId, startDate: '2027-04-01', startTime: '10:00', endDate: '2027-04-01', endTime: '18:00', breakMinutes: 0, description: null })
    await removeMember(owner.id, scheduleOrganizationId, scheduleAdminMemberId)
    assert.ok((await prisma.organizationMember.findUniqueOrThrow({ where: { id: scheduleAdminMemberId } })).leftAt)
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: future.id } })).status, 'CANCELLED')
    const former = await organizationStatistics(owner.id, scheduleOrganizationId, { from: '2025-01-01', to: '2028-01-01', memberState: 'former', sort: 'workedShifts', direction: 'desc', page: 1, limit: 50 })
    assert.equal(former.members[0]?.memberId, scheduleAdminMemberId)
    assert.ok(await prisma.workShift.count({ where: { memberId: scheduleAdminMemberId } }))
    await expectCode(() => createShift(owner.id, scheduleOrganizationId, { memberId: scheduleAdminMemberId, startDate: '2027-05-01', startTime: '10:00', endDate: '2027-05-01', endTime: '18:00', breakMinutes: 0, description: null }), 'MEMBER_NOT_FOUND')
    assert.ok(scheduleOwnerMemberId)
  })
})
