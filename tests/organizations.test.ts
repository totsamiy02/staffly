import { decodeNotificationCursor, isUrgentShiftEmail, listNotificationHistory, readHistoryNotification, reserveShiftEmail } from '../src/server/organizations/notification-service.ts'
import { invitationTimeRemaining } from '../src/app/organizations/invitation-time.ts'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/server/db.ts'
import { changeMemberRole, createOrganization, getOrganization, listAccountNotifications, listMembers, listMembersPage, listOrganizations, readAccountNotification, removeMember, updateOrganization } from '../src/server/organizations/organization-service.ts'
import { acceptCodeInvitation, acceptEmailInvitation, createCodeInvitation, createEmailInvitation, listActiveOrganizationInvitations, listPendingInvitations, previewCodeInvitation, previewEmailInvitation, rejectEmailInvitation, revokeInvitation } from '../src/server/organizations/invitation-service.ts'
import { confirmOrganizationDeletion, confirmOwnershipTransfer, requestOrganizationDeletion, requestOwnershipTransfer } from '../src/server/organizations/sensitive-action-service.ts'
import { updateProfileBody } from '../src/server/profile/schemas.ts'
import { updateOrganizationBody } from '../src/server/organizations/schemas.ts'
import { passwordValidationError } from '../src/app/auth/password-policy.ts'
import { cancelShift, correctActualTime, createShift, getShift, listMyUpcomingShifts, listSchedule, listShiftNotifications, readShiftNotification, updateShift } from '../src/server/schedule/service.ts'
import { memberStatistics, myStatistics, organizationStatistics } from '../src/server/schedule/statistics.ts'
import { zonedDateTimeToUtc } from '../src/server/schedule/timezone.ts'
import { calendarRange, moveMonth } from '../src/app/schedule/date-utils.ts'
import sharp from 'sharp'
import { cleanupPendingFiles, removeOrganizationLogo, removeUserAvatar, replaceOrganizationLogo, replaceUserAvatar } from '../src/server/storage/image-service.ts'
import { writeObject } from '../src/server/storage/local-file-storage.ts'
import { formatRussianPhone, normalizeRussianPhone } from '../src/app/profile/phone.ts'
import { cancelRequest, createRequest, createRequestType, getRequest, listRequests, listRequestTypes, resolveRequest, updateRequest, updateRequestType } from '../src/server/requests/service.ts'
import { addRequestAttachment, deleteRequestAttachment, downloadRequestAttachment } from '../src/server/requests/attachment-service.ts'
import { createRequestBody } from '../src/server/requests/schemas.ts'

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
  await prisma.employeeAbsence.deleteMany()
  await prisma.requestRead.deleteMany()
  await prisma.requestEvent.deleteMany()
  await prisma.requestAttachment.deleteMany()
  await prisma.organizationRequest.deleteMany()
  await prisma.requestType.deleteMany()
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

describe('requests workflow, privacy and schedule integration', { concurrency: false }, () => {
  it('supports system and custom types while protecting type management', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const types = await listRequestTypes(member.id, organization.id)
    assert.equal(types.filter((type) => type.systemCode).length, 6)
    const custom = await createRequestType(owner.id, organization.id, { name: 'Удалённый день', description: 'Работа вне офиса', dateMode: 'SINGLE', requiresComment: true, allowsAttachments: true })
    await expectCode(() => createRequestType(member.id, organization.id, { name: 'Запрещённый', dateMode: 'NONE', requiresComment: false, allowsAttachments: false }), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => createRequest(member.id, organization.id, { requestTypeId: custom.id, startDate: '2027-01-10' }), 'REQUEST_COMMENT_REQUIRED')
    const historical = await createRequest(member.id, organization.id, { requestTypeId: custom.id, startDate: '2027-01-10', comment: 'Из дома' })
    await updateRequestType(owner.id, organization.id, custom.id, { name: 'Удалённый рабочий день', description: custom.description, dateMode: custom.dateMode, requiresComment: custom.requiresComment, allowsAttachments: custom.allowsAttachments, isActive: false })
    await expectCode(() => createRequest(member.id, organization.id, { requestTypeId: custom.id, startDate: '2027-01-10', comment: 'Из дома' }), 'REQUEST_TYPE_NOT_FOUND')
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: historical.id } })).typeNameSnapshot, 'Удалённый день')
    const system = types.find((type) => type.systemCode === 'OTHER')!
    await updateRequestType(owner.id, organization.id, system.id, { name: system.name, description: system.description, dateMode: system.dateMode, requiresComment: system.requiresComment, allowsAttachments: system.allowsAttachments, isActive: false })
    assert.equal((await listRequestTypes(member.id, organization.id)).some((type) => type.id === system.id), false)
    await expectCode(() => createRequest(member.id, organization.id, { requestTypeId: system.id, comment: 'Недоступный тип' }), 'REQUEST_TYPE_NOT_FOUND')
    await updateRequestType(owner.id, organization.id, system.id, { name: system.name, description: system.description, dateMode: system.dateMode, requiresComment: system.requiresComment, allowsAttachments: system.allowsAttachments, isActive: true })
    assert.equal(createRequestBody.safeParse({ requestTypeId: custom.id, startDate: '2027-02-30' }).success, false)
  })

  it('tracks reads per reviewer, blocks IDOR, resolves once and creates an absence', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const vacation = (await listRequestTypes(member.id, organization.id)).find((type) => type.systemCode === 'VACATION')!
    const request = await createRequest(member.id, organization.id, { requestTypeId: vacation.id, startDate: '2028-02-10', endDate: '2028-02-12', comment: 'Поездка' })
    await expectCode(() => getRequest(outsider.id, organization.id, request.id), 'ORGANIZATION_NOT_FOUND')
    await getRequest(owner.id, organization.id, request.id)
    assert.equal(await prisma.requestRead.count({ where: { requestId: request.id } }), 1)
    await getRequest(admin.id, organization.id, request.id)
    assert.equal(await prisma.requestRead.count({ where: { requestId: request.id } }), 2)
    const employeeMembership = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: member.id } } })
    const conflict = await createShift(owner.id, organization.id, { memberId: employeeMembership.id, startDate: '2028-02-11', startTime: '09:00', endDate: '2028-02-11', endTime: '18:00', breakMinutes: 0, description: null })
    await expectCode(() => resolveRequest(owner.id, organization.id, request.id, 'APPROVED', null, false), 'REQUEST_SHIFT_CONFLICTS')
    await resolveRequest(owner.id, organization.id, request.id, 'APPROVED', 'Согласовано', true)
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: conflict.id } })).status, 'CANCELLED')
    assert.ok(await prisma.employeeAbsence.findUnique({ where: { sourceRequestId: request.id } }))
    await expectCode(() => resolveRequest(admin.id, organization.id, request.id, 'REJECTED', 'Поздно'), 'REQUEST_ALREADY_RESOLVED')
    await expectCode(() => createShift(owner.id, organization.id, { memberId: employeeMembership.id, startDate: '2028-02-12', startTime: '10:00', endDate: '2028-02-12', endTime: '17:00', breakMinutes: 0, description: null }), 'EMPLOYEE_ABSENT')
    const dayOffType = (await listRequestTypes(member.id, organization.id)).find((type) => type.systemCode === 'DAY_OFF')!
    const dayOff = await createRequest(member.id, organization.id, { requestTypeId: dayOffType.id, startDate: '2028-03-10' })
    await resolveRequest(owner.id, organization.id, dayOff.id, 'APPROVED', null)
    const boundaryShift = await createShift(owner.id, organization.id, { memberId: employeeMembership.id, startDate: '2028-03-09', startTime: '20:00', endDate: '2028-03-10', endTime: '00:00', breakMinutes: 0, description: 'До начала отгула' })
    assert.equal(boundaryShift.status, 'SCHEDULED')
    await expectCode(() => createShift(owner.id, organization.id, { memberId: employeeMembership.id, startDate: '2028-03-10', startTime: '00:00', endDate: '2028-03-11', endTime: '00:00', breakMinutes: 0, description: null }), 'EMPLOYEE_ABSENT')
  })

  it('keeps attachments private and validates ownership of shift-change requests', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const types = await listRequestTypes(member.id, organization.id)
    const other = types.find((type) => type.systemCode === 'OTHER')!
    const request = await createRequest(member.id, organization.id, { requestTypeId: other.id, comment: 'Документы' })
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer()
    const image = await addRequestAttachment(member.id, organization.id, request.id, jpeg, 'image/jpeg', 'spravka.jpg')
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF')
    const document = await addRequestAttachment(member.id, organization.id, request.id, pdf, 'application/pdf', 'spravka.pdf')
    assert.equal((await downloadRequestAttachment(owner.id, organization.id, request.id, image.id)).contents.length, jpeg.length)
    assert.equal((await downloadRequestAttachment(member.id, organization.id, request.id, document.id)).attachment.fileName, 'spravka.pdf')
    await expectCode(() => downloadRequestAttachment(outsider.id, organization.id, request.id, image.id), 'ORGANIZATION_NOT_FOUND')
    await expectCode(() => deleteRequestAttachment(owner.id, organization.id, request.id, image.id), 'ATTACHMENT_FORBIDDEN')
    await deleteRequestAttachment(member.id, organization.id, request.id, image.id)
    await expectCode(() => downloadRequestAttachment(member.id, organization.id, request.id, image.id), 'ATTACHMENT_NOT_FOUND')
    assert.equal(await prisma.storedFile.findUnique({ where: { id: image.storedFileId } }), null)
    const shiftType = types.find((type) => type.systemCode === 'SHIFT_CHANGE')!
    const ownerMembership = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: owner.id } } })
    const ownerShift = await createShift(owner.id, organization.id, { memberId: ownerMembership.id, startDate: '2028-04-01', startTime: '10:00', endDate: '2028-04-01', endTime: '18:00', breakMinutes: 0, description: null })
    await expectCode(() => createRequest(member.id, organization.id, { requestTypeId: shiftType.id, relatedShiftId: ownerShift.id, proposedStartDate: '2028-04-02', proposedStartTime: '10:00', proposedEndDate: '2028-04-02', proposedEndTime: '18:00', comment: 'Чужая смена' }), 'SHIFT_NOT_FOUND')
  })

  it('moves the original shift on approval and rejects stale or conflicting proposals', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const memberRecord = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: member.id } } })
    const shiftType = (await listRequestTypes(member.id, organization.id)).find((item) => item.systemCode === 'SHIFT_CHANGE')!
    const shift = await createShift(owner.id, organization.id, { memberId: memberRecord.id, startDate: '2032-05-01', startTime: '09:00', endDate: '2032-05-01', endTime: '18:00', breakMinutes: 0, description: null })
    await expectCode(() => createRequest(member.id, organization.id, { requestTypeId: shiftType.id, relatedShiftId: shift.id, comment: 'Позже' }), 'SHIFT_PROPOSAL_REQUIRED')
    const proposal = await createRequest(member.id, organization.id, { requestTypeId: shiftType.id, relatedShiftId: shift.id, proposedStartDate: '2032-05-02', proposedStartTime: '12:00', proposedEndDate: '2032-05-02', proposedEndTime: '20:00', comment: 'Мне удобнее во второй день' })
    assert.ok((await getRequest(member.id, organization.id, proposal.id)).request.proposedStartAt)
    await updateRequest(member.id, organization.id, proposal.id, { requestTypeId: shiftType.id, relatedShiftId: shift.id, proposedStartDate: '2032-05-02', proposedStartTime: '13:00', proposedEndDate: '2032-05-02', proposedEndTime: '21:00', comment: 'Мне удобнее после обеда' })
    await resolveRequest(owner.id, organization.id, proposal.id, 'APPROVED', null)
    const moved = await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })
    assert.equal(moved.scheduledStartAt.toISOString(), zonedDateTimeToUtc('2032-05-02', '13:00', organization.timezone).toISOString())
    assert.equal(moved.status, 'SCHEDULED')
    assert.equal(moved.assignmentReadAt, null)
    assert.equal((await listSchedule(member.id, organization.id, '2032-05-01', '2032-05-03')).shifts.filter((item) => item.id === shift.id).length, 1)

    const other = await createShift(owner.id, organization.id, { memberId: memberRecord.id, startDate: '2032-05-04', startTime: '09:00', endDate: '2032-05-04', endTime: '18:00', breakMinutes: 0, description: null })
    const conflict = await createRequest(member.id, organization.id, { requestTypeId: shiftType.id, relatedShiftId: shift.id, proposedStartDate: '2032-05-04', proposedStartTime: '12:00', proposedEndDate: '2032-05-04', proposedEndTime: '20:00', comment: 'Перенести ещё раз' })
    await expectCode(() => resolveRequest(owner.id, organization.id, conflict.id, 'APPROVED', null), 'SHIFT_OVERLAP')
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: conflict.id } })).status, 'PENDING')
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: other.id } })).status, 'SCHEDULED')
    await cancelRequest(member.id, organization.id, conflict.id)

    const stale = await createRequest(member.id, organization.id, { requestTypeId: shiftType.id, relatedShiftId: shift.id, proposedStartDate: '2032-05-05', proposedStartTime: '10:00', proposedEndDate: '2032-05-05', proposedEndTime: '19:00', comment: 'Перенос' })
    await updateShift(owner.id, organization.id, shift.id, { memberId: memberRecord.id, startDate: '2032-05-03', startTime: '09:00', endDate: '2032-05-03', endTime: '18:00', breakMinutes: 0, description: null })
    await expectCode(() => resolveRequest(owner.id, organization.id, stale.id, 'APPROVED', null), 'REQUEST_ALREADY_RESOLVED')
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: stale.id } })).status, 'CANCELLED')
  })

  it('lets only the author edit a pending request and alerts reviewers again', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const type = (await listRequestTypes(member.id, organization.id)).find((item) => item.systemCode === 'OTHER')!
    const request = await createRequest(member.id, organization.id, { requestTypeId: type.id, comment: 'Первый текст' })
    const alert = await prisma.accountNotification.findFirstOrThrow({ where: { requestId: request.id, userId: owner.id, type: 'REQUEST_CREATED' } })
    await getRequest(owner.id, organization.id, request.id)
    await readAccountNotification(owner.id, alert.id)
    await expectCode(() => updateRequest(owner.id, organization.id, request.id, { requestTypeId: type.id, comment: 'Не мой текст' }), 'REQUEST_NOT_FOUND')
    await updateRequest(member.id, organization.id, request.id, { requestTypeId: type.id, comment: 'Исправленный текст' })
    const edited = (await getRequest(member.id, organization.id, request.id)).request
    assert.equal(edited.comment, 'Исправленный текст')
    assert.equal(edited.events.at(-1)?.type, 'EDITED')
    assert.equal(await prisma.requestRead.count({ where: { requestId: request.id } }), 0)
    assert.ok((await prisma.accountNotification.findUniqueOrThrow({ where: { id: alert.id } })).readAt)
    assert.ok(await prisma.accountNotification.findFirst({ where: { requestId: request.id, userId: owner.id, type: 'REQUEST_CREATED', readAt: null, title: 'Заявка изменена' } }))
    await resolveRequest(owner.id, organization.id, request.id, 'APPROVED', null)
    await expectCode(() => updateRequest(member.id, organization.id, request.id, { requestTypeId: type.id, comment: 'Поздно' }), 'REQUEST_ALREADY_RESOLVED')
  })

  it('supports cancellation, pagination and concurrent decision protection', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const type = (await listRequestTypes(member.id, organization.id)).find((item) => item.systemCode === 'OTHER')!
    const cancelled = await createRequest(member.id, organization.id, { requestTypeId: type.id, comment: 'Отменю сам' })
    await cancelRequest(member.id, organization.id, cancelled.id)
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: cancelled.id } })).status, 'CANCELLED')
    const concurrent = await createRequest(member.id, organization.id, { requestTypeId: type.id, comment: 'Одно решение' })
    const decisions = await Promise.allSettled([resolveRequest(owner.id, organization.id, concurrent.id, 'APPROVED', null), resolveRequest(admin.id, organization.id, concurrent.id, 'REJECTED', 'Не согласовано')])
    assert.equal(decisions.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(decisions.filter((item) => item.status === 'rejected').length, 1)
    const list = await listRequests(owner.id, organization.id, 'history', { page: 1, pageSize: 1 })
    assert.equal(list.requests.length, 1)
    assert.ok(list.pagination.total >= 2)
  })

  it('lets owners and admins review their own requests and filter the shared lists', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const type = (await listRequestTypes(owner.id, organization.id)).find((item) => item.systemCode === 'OTHER')!
    await prisma.user.update({ where: { id: owner.id }, data: { lastName: 'Биленко', firstName: 'Иван' } })
    const ownerRequest = await createRequest(owner.id, organization.id, { requestTypeId: type.id, comment: 'Заявка владельца' })
    const adminRequest = await createRequest(admin.id, organization.id, { requestTypeId: type.id, comment: 'Заявка администратора' })
    assert.ok((await listRequests(owner.id, organization.id, 'incoming', { page: 1, pageSize: 20 })).requests.some((item) => item.id === ownerRequest.id))
    assert.ok((await listRequests(admin.id, organization.id, 'incoming', { page: 1, pageSize: 20 })).requests.some((item) => item.id === ownerRequest.id))
    assert.ok((await listRequests(owner.id, organization.id, 'incoming', { page: 1, pageSize: 20 })).requests.some((item) => item.id === adminRequest.id))
    assert.deepEqual((await listRequests(owner.id, organization.id, 'incoming', { page: 1, pageSize: 20, role: 'OWNER', search: 'би' })).requests.map((item) => item.id), [ownerRequest.id])
    assert.deepEqual((await listRequests(owner.id, organization.id, 'incoming', { page: 1, pageSize: 20, role: 'OWNER', typeId: type.id, search: 'би Ив' })).requests.map((item) => item.id), [ownerRequest.id])
    assert.deepEqual((await listRequests(owner.id, organization.id, 'incoming', { page: 1, pageSize: 20, role: 'OWNER', search: 'Другое' })).requests, [])
    assert.deepEqual((await listRequests(owner.id, organization.id, 'incoming', { page: 1, pageSize: 20, role: 'ADMIN', search: 'Би' })).requests, [])
    assert.ok(await prisma.accountNotification.findFirst({ where: { requestId: ownerRequest.id, userId: owner.id, type: 'REQUEST_CREATED' } }))
    await getRequest(owner.id, organization.id, ownerRequest.id)
    await resolveRequest(owner.id, organization.id, ownerRequest.id, 'APPROVED', null)
    assert.equal((await listRequests(owner.id, organization.id, 'history', { page: 1, pageSize: 20, role: 'OWNER', search: 'Би' })).requests.some((item) => item.id === ownerRequest.id), true)
    assert.equal((await listRequests(owner.id, organization.id, 'history', { page: 1, pageSize: 20, role: 'OWNER', status: 'APPROVED', typeId: type.id, search: 'Би' })).requests.some((item) => item.id === ownerRequest.id), true)
    const completedOwnerRequest = await createRequest(owner.id, organization.id, { requestTypeId: type.id, comment: 'Рассмотреть администратору' })
    await resolveRequest(admin.id, organization.id, completedOwnerRequest.id, 'APPROVED', null)
    assert.equal((await listRequests(owner.id, organization.id, 'history', { page: 1, pageSize: 20 })).requests.some((item) => item.id === completedOwnerRequest.id), true)
    assert.equal((await listRequests(admin.id, organization.id, 'history', { page: 1, pageSize: 20 })).requests.some((item) => item.id === completedOwnerRequest.id), true)
    assert.equal((await listRequests(owner.id, organization.id, 'mine', { page: 1, pageSize: 20 })).requests.some((item) => item.id === completedOwnerRequest.id), true)
    await expectCode(() => listRequests(member.id, organization.id, 'incoming', { page: 1, pageSize: 20 }), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => cancelRequest(owner.id, organization.id, ownerRequest.id), 'REQUEST_ALREADY_RESOLVED')
    await expectCode(() => cancelRequest(member.id, organization.id, adminRequest.id), 'REQUEST_NOT_FOUND')
    await cancelRequest(admin.id, organization.id, adminRequest.id)
    await prisma.user.update({ where: { id: owner.id }, data: { lastName: null, firstName: null } })
  })

  it('sends generic decision notifications without confusing them with request reads', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const type = (await listRequestTypes(member.id, organization.id)).find((item) => item.systemCode === 'OTHER')!
    const request = await createRequest(member.id, organization.id, { requestTypeId: type.id, comment: 'Нужен ответ' })
    const reviewerNotification = await prisma.accountNotification.findFirstOrThrow({ where: { requestId: request.id, userId: owner.id, type: 'REQUEST_CREATED' } })
    assert.equal(await prisma.requestRead.count({ where: { requestId: request.id } }), 0)
    assert.equal(reviewerNotification.readAt, null)
    await getRequest(owner.id, organization.id, request.id)
    assert.equal(await prisma.requestRead.count({ where: { requestId: request.id } }), 1)
    assert.equal((await prisma.accountNotification.findUniqueOrThrow({ where: { id: reviewerNotification.id } })).readAt, null)
    await resolveRequest(owner.id, organization.id, request.id, 'REJECTED', 'Недостаточно информации')
    assert.equal((await prisma.accountNotification.findFirstOrThrow({ where: { requestId: request.id, userId: member.id, type: 'REQUEST_REJECTED' } })).message, 'Другое')
  })

  it('keeps custom requests out of schedule semantics and cancels pending history when membership ends', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const custom = await createRequestType(owner.id, organization.id, { name: 'Компенсация расходов', description: null, dateMode: 'RANGE', requiresComment: true, allowsAttachments: true })
    const customRequest = await createRequest(member.id, organization.id, { requestTypeId: custom.id, startDate: '2029-01-01', endDate: '2029-01-03', comment: 'Чеки' })
    await resolveRequest(owner.id, organization.id, customRequest.id, 'APPROVED', null)
    assert.equal(await prisma.employeeAbsence.count({ where: { sourceRequestId: customRequest.id } }), 0)
    const leaving = await prisma.user.create({ data: { email: email('leaving'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    const leavingMembership = await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: leaving.id, role: 'MEMBER' } })
    const pending = await createRequest(leaving.id, organization.id, { requestTypeId: custom.id, startDate: '2029-02-01', endDate: '2029-02-02', comment: 'До ухода' })
    await removeMember(owner.id, organization.id, leavingMembership.id)
    const preserved = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: pending.id } })
    assert.equal(preserved.status, 'CANCELLED')
    assert.equal(preserved.resolutionComment, 'Участник покинул организацию')
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
    assert.equal(memberProfile?.online, false) // A user timestamp alone is not a live session.
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

// Real HTTP cookies/tokens plus separate query caches reproduce cross-user behavior.
describe('session continuity, presence and cross-user synchronization regressions', { concurrency: false }, () => {
  let server: import('node:http').Server
  let base: string
  let first: { id: string; email: string }
  let second: { id: string; email: string }
  let firstAuth: { accessToken: string }
  let secondAuth: { accessToken: string }
  let firstCookie = ''
  let firstBrowserCookie = ''
  let secondCookie = ''
  let presenceOrganizationId = ''
  const password = 'Regression-test-1!'
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36'
  async function http(path: string, options: { method?: string; body?: unknown; cookie?: string; token?: string } = {}) {
    return fetch(`${base}/api${path}`, { method: options.method ?? 'GET', headers: { 'User-Agent': ua, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) })
  }
  const cookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]
  before(async () => {
    process.env.JWT_SECRET ??= 'local-regression-test-secret-with-at-least-32-characters'
    const { default: express } = await import('express')
    const { default: cookieParser } = await import('cookie-parser')
    const { hash } = await import('argon2')
    const { default: auth } = await import('../src/server/auth.ts')
    const { default: profiles } = await import('../src/server/profile/routes.ts')
    const { default: organizations } = await import('../src/server/organizations/routes.ts')
    const { default: schedule } = await import('../src/server/schedule/routes.ts')
    const { default: requests } = await import('../src/server/requests/routes.ts')
    const app = express()
    app.use(express.json(), cookieParser())
    app.use('/api/auth', auth)
    app.use('/api', profiles, organizations, schedule, requests)
    app.use((error: any, _request: any, response: any, _next: any) => response.status(error.status ?? 500).json({ code: error.code, message: error.message }))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const passwordHash = await hash(password)
    first = await prisma.user.create({ data: { email: email('session-first'), passwordHash, emailVerifiedAt: new Date() } })
    second = await prisma.user.create({ data: { email: email('session-second'), passwordHash, emailVerifiedAt: new Date() } })
    const a = await http('/auth/login', { method: 'POST', body: { email: first.email, password } })
    assert.equal(a.status, 200); firstCookie = cookie(a); firstAuth = await a.json()
    const b = await http('/auth/login', { method: 'POST', body: { email: second.email, password } })
    assert.equal(b.status, 200); secondCookie = cookie(b); secondAuth = await b.json()
  })
  after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })

  it('keeps one session through repeat login and rotations while preserving a separate same-UA device', async () => {
    const before = await prisma.authSession.findFirstOrThrow({ where: { userId: first.id, revokedAt: null } })
    const repeat = await http('/auth/login', { method: 'POST', cookie: firstCookie, body: { email: first.email, password } })
    assert.equal(repeat.status, 200); firstCookie = cookie(repeat); firstBrowserCookie = repeat.headers.getSetCookie().find(value => value.startsWith('staffly_browser='))!.split(';')[0]; firstAuth = await repeat.json()
    for (let index = 0; index < 3; index++) {
      const refreshed = await http('/auth/refresh', { method: 'POST', cookie: firstCookie, body: {} })
      assert.equal(refreshed.status, 200); firstCookie = cookie(refreshed); firstAuth = await refreshed.json()
    }
    const active = await prisma.authSession.findMany({ where: { userId: first.id, revokedAt: null } })
    assert.equal(active.length, 1); assert.equal(active[0].id, before.id)
    const otherDevice = await http('/auth/login', { method: 'POST', body: { email: first.email, password } })
    assert.equal(otherDevice.status, 200)
    assert.equal(await prisma.authSession.count({ where: { userId: first.id, revokedAt: null } }), 2)
    const deviceToken = (await otherDevice.json()).accessToken
    const listed = await http('/auth/sessions', { token: deviceToken })
    const sessions = (await listed.json()).sessions
    assert.equal(sessions.length, 2); assert.equal(sessions.filter((item: any) => item.current).length, 1)
    await http('/auth/logout', { method: 'POST', cookie: cookie(otherDevice), body: {} })
  })

  it('continues the same browser session after its refresh cookie is lost, but never authenticates with browser identity alone', async () => {
    const previous = await prisma.authSession.findFirstOrThrow({ where: { userId: first.id, revokedAt: null } })
    const identityOnly = await http('/auth/refresh', { method: 'POST', cookie: firstBrowserCookie, body: {} })
    assert.equal(identityOnly.status, 401)
    const login = await http('/auth/login', { method: 'POST', cookie: firstBrowserCookie, body: { email: first.email, password } })
    assert.equal(login.status, 200); firstCookie = cookie(login); firstAuth = await login.json()
    assert.equal(await prisma.authSession.count({ where: { userId: first.id, revokedAt: null } }), 1)
    assert.equal((await prisma.authSession.findFirstOrThrow({ where: { userId: first.id, revokedAt: null } })).id, previous.id)
  })

  it('does not clear a newly rotated cookie when an obsolete refresh loses the race', async () => {
    const obsolete = firstCookie
    const valid = await http('/auth/refresh', { method: 'POST', cookie: firstCookie, body: {} })
    assert.equal(valid.status, 200); firstCookie = cookie(valid); firstAuth = await valid.json()
    const stale = await http('/auth/refresh', { method: 'POST', cookie: obsolete, body: {} })
    assert.equal(stale.status, 401); assert.equal(stale.headers.get('set-cookie'), null)
    const stillValid = await http('/auth/refresh', { method: 'POST', cookie: firstCookie, body: {} })
    assert.equal(stillValid.status, 200); firstCookie = cookie(stillValid); firstAuth = await stillValid.json()
  })

  it('defines online by unexpired non-revoked session heartbeat, not API polling or lastSeen alone', async () => {
    const { updatePresence, PRESENCE_TTL_MS } = await import('../src/server/profile/presence.ts')
    const organization = await createOrganization(first.id, { name: 'Presence regression', description: null, timezone: 'Europe/Moscow' })
    presenceOrganizationId = organization.id
    await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: second.id } })
    const session = await prisma.authSession.findFirstOrThrow({ where: { userId: second.id, revokedAt: null } })
    await updatePresence(second.id, session.id, true)
    assert.equal((await listMembers(first.id, organization.id)).find(item => item.userId === second.id)?.online, true)
    await prisma.authSession.update({ where: { id: session.id }, data: { lastActiveAt: new Date(Date.now() - PRESENCE_TTL_MS - 1_000) } })
    assert.equal((await listMembersPage(first.id, organization.id, {})).members.find(item => item.userId === second.id)?.online, false)
    await http('/account-notifications', { token: secondAuth.accessToken })
    assert.equal((await listMembers(first.id, organization.id)).find(item => item.userId === second.id)?.online, false)
    await updatePresence(second.id, session.id, true)
    const other = await http('/auth/login', { method: 'POST', body: { email: second.email, password } })
    assert.equal(other.status, 200)
    const otherToken = (await other.json()).accessToken
    const otherSession = (await (await http('/auth/sessions', { token: otherToken })).json()).sessions.find((item: any) => item.current)
    await updatePresence(second.id, otherSession.id, true)
    await http('/auth/logout', { method: 'POST', cookie: cookie(other), body: {} })
    assert.equal((await listMembers(first.id, organization.id)).find(item => item.userId === second.id)?.online, true)
    await updatePresence(second.id, session.id, false)
    assert.equal((await listMembers(first.id, organization.id)).find(item => item.userId === second.id)?.online, false)
  })

  it('polls notification, shift and request changes between two authenticated users without local invalidation', async () => {
    // QueryObserver only enables browser polling when imported in a browser environment.
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
    const { QueryClient, QueryObserver, timeoutManager, focusManager } = await import('@tanstack/query-core')
    const { liveQueryOptions } = await import('../src/app/live-query.ts')
    focusManager.setEventListener(() => () => {})
    focusManager.setFocused(true)
    const delays: number[] = []
    timeoutManager.setTimeoutProvider({ setTimeout, clearTimeout, setInterval: (callback, delay) => { delays.push(delay); return setInterval(callback, delay === liveQueryOptions.refetchInterval ? 20 : delay) }, clearInterval })
    const a = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } }); const b = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })
    const cleanup: Array<() => void> = []
    async function waitUntil(predicate: () => boolean) { const until = Date.now() + 3_000; while (!predicate()) { if (Date.now() > until) assert.fail('Cross-user cache did not synchronize'); await new Promise(resolve => setTimeout(resolve, 10)) } }
    try {
      const organization = await createOrganization(first.id, { name: 'Two-user sync regression', description: null, timezone: 'Europe/Moscow' })
      const employee = await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: second.id } })
      function observe(client: InstanceType<typeof QueryClient>, key: unknown[], path: string, token: string) {
        const observer = new QueryObserver<any>(client, { ...liveQueryOptions, queryKey: key, queryFn: async () => { const response = await http(path, { token }); assert.equal(response.status, 200); return response.json() } })
        cleanup.push(observer.subscribe(() => {})); return observer
      }
      const schedule = observe(b, ['schedule', organization.id, '2038-01-01', '2038-02-01'], `/organizations/${organization.id}/schedule?from=2038-01-01&to=2038-02-01`, secondAuth.accessToken)
      const notifications = observe(b, ['shift-notifications'], '/shift-notifications', secondAuth.accessToken)
      const history = observe(b, ['notifications', { limit: 6 }], '/notifications?limit=6', secondAuth.accessToken)
      const mine = observe(b, ['requests', organization.id, 'mine', { page: 1 }], `/organizations/${organization.id}/requests/mine?page=1&pageSize=20`, secondAuth.accessToken)
      const incoming = observe(a, ['requests', organization.id, 'incoming', { page: 1 }], `/organizations/${organization.id}/requests/incoming?page=1&pageSize=20`, firstAuth.accessToken)
      await waitUntil(() => schedule.getCurrentResult().isSuccess && mine.getCurrentResult().isSuccess && incoming.getCurrentResult().isSuccess)
      const shiftResponse = await http(`/organizations/${organization.id}/shifts`, { method: 'POST', token: firstAuth.accessToken, body: { memberId: employee.id, startDate: '2038-01-10', startTime: '09:00', endDate: '2038-01-10', endTime: '17:00', breakMinutes: 0, description: null } })
      assert.equal(shiftResponse.status, 201); const shift = (await shiftResponse.json()).shift
      await waitUntil(() => notifications.getCurrentResult().data?.notifications.some((item: any) => item.id === shift.id) && schedule.getCurrentResult().data?.shifts.some((item: any) => item.id === shift.id))
      await waitUntil(() => history.getCurrentResult().data?.notifications.some((item: any) => item.type === 'SHIFT_ASSIGNED' && item.href?.includes(shift.id)))
      const event = history.getCurrentResult().data.notifications.find((item: any) => item.type === 'SHIFT_ASSIGNED' && item.href?.includes(shift.id))
      assert.equal((await http(`/notifications/${event.id}/read`, { method: 'POST', token: firstAuth.accessToken, body: {} })).status, 404)
      assert.equal((await http(`/notifications/${event.id}/read`, { method: 'POST', token: secondAuth.accessToken, body: { unread: 'invalid' } })).status, 400)
      assert.equal((await http('/notifications?limit=999', { token: secondAuth.accessToken })).status, 400)
      assert.equal((await http(`/notifications/${event.id}/read`, { method: 'POST', token: secondAuth.accessToken, body: {} })).status, 204)
      await waitUntil(() => history.getCurrentResult().data?.notifications.find((item: any) => item.id === event.id)?.readAt)
      const read = await http(`/shift-notifications/${shift.id}/read`, { method: 'POST', token: secondAuth.accessToken, body: {} })
      assert.equal(read.status, 204)
      await waitUntil(() => !notifications.getCurrentResult().data?.notifications.some((item: any) => item.id === shift.id))
      const changed = await http(`/organizations/${organization.id}/shifts/${shift.id}`, { method: 'PATCH', token: firstAuth.accessToken, body: { memberId: employee.id, startDate: '2038-01-10', startTime: '08:00', endDate: '2038-01-10', endTime: '17:00', breakMinutes: 0, description: null } })
      assert.equal(changed.status, 200)
      await waitUntil(() => notifications.getCurrentResult().data?.notifications.find((item: any) => item.id === shift.id)?.scheduledStartAt === '2038-01-10T05:00:00.000Z' && schedule.getCurrentResult().data?.shifts.find((item: any) => item.id === shift.id)?.scheduledStartAt === '2038-01-10T05:00:00.000Z')
      const type = (await listRequestTypes(second.id, organization.id)).find(item => item.systemCode === 'SHIFT_CHANGE')!
      const requestResponse = await http(`/organizations/${organization.id}/requests`, { method: 'POST', token: secondAuth.accessToken, body: { requestTypeId: type.id, relatedShiftId: shift.id, proposedStartDate: '2038-01-11', proposedStartTime: '10:00', proposedEndDate: '2038-01-11', proposedEndTime: '18:00', comment: 'Перенести' } })
      assert.equal(requestResponse.status, 201); const request = (await requestResponse.json()).request
      await waitUntil(() => incoming.getCurrentResult().data?.requests.some((item: any) => item.id === request.id))
      const approval = await http(`/organizations/${organization.id}/requests/${request.id}/approve`, { method: 'POST', token: firstAuth.accessToken, body: {} })
      assert.equal(approval.status, 200)
      await waitUntil(() => mine.getCurrentResult().data?.requests.find((item: any) => item.id === request.id)?.status === 'APPROVED' && schedule.getCurrentResult().data?.shifts.find((item: any) => item.id === shift.id)?.scheduledStartAt === '2038-01-11T07:00:00.000Z')
      await waitUntil(() => history.getCurrentResult().data?.notifications.some((item: any) => item.type === 'REQUEST_APPROVED' && item.href?.includes(request.id)))
      assert.ok(delays.includes(10_000))
      assert.equal((await listAccountNotifications(second.id)).some(item => item.requestId === request.id && item.type === 'REQUEST_APPROVED'), true)
    } finally {
      cleanup.forEach(stop => stop()); await Promise.all([a.cancelQueries(), b.cancelQueries()]); a.clear(); b.clear(); focusManager.setFocused(undefined)
      timeoutManager.setTimeoutProvider({ setTimeout, clearTimeout, setInterval, clearInterval })
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  it('switching accounts in one cookie jar revokes the displaced session immediately', async () => {
    const previous = await prisma.authSession.findFirstOrThrow({ where: { userId: first.id, revokedAt: null } })
    const switched = await http('/auth/login', { method: 'POST', cookie: firstCookie, body: { email: second.email, password } })
    assert.equal(switched.status, 200)
    assert.ok((await prisma.authSession.findUniqueOrThrow({ where: { id: previous.id } })).revokedAt)
    assert.equal((await http('/auth/me', { token: firstAuth.accessToken })).status, 401)
    await http('/auth/logout', { method: 'POST', cookie: cookie(switched), body: {} })
    await http('/profile/presence', { method: 'POST', token: secondAuth.accessToken, body: { visible: true } })
    assert.equal((await listMembers(first.id, presenceOrganizationId)).find(item => item.userId === second.id)?.online, true)
    await http('/auth/logout', { method: 'POST', cookie: secondCookie, body: {} })
    assert.equal((await listMembers(first.id, presenceOrganizationId)).find(item => item.userId === second.id)?.online, false)
  })
})

describe('pending shift-request lifecycle regressions', { concurrency: false }, () => {
  let organization: { id: string }
  let employeeId: string
  let ownerMemberId: string
  let shiftTypeId: string
  const shiftInput = (date: string) => ({ memberId: employeeId, startDate: date, startTime: '09:00', endDate: date, endTime: '17:00', breakMinutes: 0, description: null })
  const proposal = (shiftId: string, date: string) => createRequest(member.id, organization.id, { requestTypeId: shiftTypeId, relatedShiftId: shiftId, proposedStartDate: date, proposedStartTime: '10:00', proposedEndDate: date, proposedEndTime: '18:00', comment: 'Перенести смену' })
  async function assertCancelled(id: string) {
    const record = await prisma.organizationRequest.findUniqueOrThrow({ where: { id }, include: { events: true } })
    assert.equal(record.status, 'CANCELLED'); assert.ok(record.cancelledAt); assert.ok(record.resolutionComment)
    assert.equal(record.events.filter(event => event.type === 'CANCELLED').length, 1)
    assert.equal((await listAccountNotifications(member.id)).some(item => item.requestId === id && item.type === 'REQUEST_CANCELLED'), true)
    assert.equal((await listRequests(owner.id, organization.id, 'incoming', { page: 1, pageSize: 100 })).requests.some(item => item.id === id), false)
    assert.equal((await listRequests(owner.id, organization.id, 'history', { page: 1, pageSize: 100 })).requests.some(item => item.id === id), true)
    await expectCode(() => resolveRequest(owner.id, organization.id, id, 'APPROVED', null), 'REQUEST_ALREADY_RESOLVED')
  }
  before(async () => {
    organization = await createOrganization(owner.id, { name: 'Request conflict regressions', description: null, timezone: 'Europe/Moscow' })
    employeeId = (await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: member.id } })).id
    ownerMemberId = (await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: owner.id } } })).id
    shiftTypeId = (await listRequestTypes(member.id, organization.id)).find(type => type.systemCode === 'SHIFT_CHANGE')!.id
  })
  it('keeps a proposal for description-only edits, cancels it atomically for time changes', async () => {
    const shift = await createShift(owner.id, organization.id, shiftInput('2039-01-01'))
    const request = await proposal(shift.id, '2039-01-02')
    await updateShift(owner.id, organization.id, shift.id, { ...shiftInput('2039-01-01'), description: 'Другая заметка' })
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'PENDING')
    await updateShift(owner.id, organization.id, shift.id, { ...shiftInput('2039-01-01'), startTime: '08:00' })
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'CANCELLED')
    await assertCancelled(request.id)
  })
  it('cancels pending proposals when the original shift is cancelled or assigned to someone else', async () => {
    const shift = await createShift(owner.id, organization.id, shiftInput('2039-02-01'))
    const request = await proposal(shift.id, '2039-02-02')
    await cancelShift(owner.id, organization.id, shift.id, 'Нет работы')
    await assertCancelled(request.id)
    const reassigned = await createShift(owner.id, organization.id, shiftInput('2039-02-03'))
    const secondRequest = await proposal(reassigned.id, '2039-02-04')
    await updateShift(owner.id, organization.id, reassigned.id, { ...shiftInput('2039-02-03'), memberId: ownerMemberId })
    await assertCancelled(secondRequest.id)
  })
  it('preserves the approved proposal and cancels competing pending proposals for the same original shift', async () => {
    const shift = await createShift(owner.id, organization.id, shiftInput('2039-03-01'))
    const a = await proposal(shift.id, '2039-03-02')
    const b = await proposal(shift.id, '2039-03-03')
    await resolveRequest(owner.id, organization.id, a.id, 'APPROVED', null)
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: a.id } })).status, 'APPROVED')
    await assertCancelled(b.id)
    assert.equal((await getRequest(member.id, organization.id, a.id)).request.originalStartAt.toISOString(), '2039-03-01T06:00:00.000Z')
  })
  it('cancels shift-change proposals when approving an absence cancels the original shifts', async () => {
    const shift = await createShift(owner.id, organization.id, shiftInput('2039-04-01'))
    const change = await proposal(shift.id, '2039-04-02')
    const dayOff = (await listRequestTypes(member.id, organization.id)).find(type => type.systemCode === 'DAY_OFF')!
    const absence = await createRequest(member.id, organization.id, { requestTypeId: dayOff.id, startDate: '2039-04-01' })
    await resolveRequest(owner.id, organization.id, absence.id, 'APPROVED', null, true)
    await assertCancelled(change.id)
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'CANCELLED')
  })
  it('reconciles expired proposals and legacy external edits with one cancellation event', async () => {
    const shift = await createShift(owner.id, organization.id, shiftInput('2039-05-01'))
    const expired = await proposal(shift.id, '2039-05-02')
    await prisma.organizationRequest.update({ where: { id: expired.id }, data: { proposedStartAt: new Date('2020-01-01T10:00:00Z') } })
    await getRequest(member.id, organization.id, expired.id)
    await assertCancelled(expired.id) // List/get reconciliation is the catch-up mechanism.
    const external = await proposal(shift.id, '2039-05-03')
    await prisma.workShift.update({ where: { id: shift.id }, data: { scheduledStartAt: new Date('2039-05-01T05:00:00Z') } })
    await getRequest(member.id, organization.id, external.id)
    await assertCancelled(external.id)
    await getRequest(member.id, organization.id, external.id)
    assert.equal(await prisma.requestEvent.count({ where: { requestId: external.id, type: 'CANCELLED' } }), 1)
  })
  it('cannot approve a proposal concurrently with cancelling the original shift', async () => {
    const shift = await createShift(owner.id, organization.id, shiftInput('2039-06-01'))
    const request = await proposal(shift.id, '2039-06-02')
    const results = await Promise.allSettled([resolveRequest(owner.id, organization.id, request.id, 'APPROVED', null), cancelShift(owner.id, organization.id, shift.id, 'Отмена')])
    assert.ok(results.some(result => result.status === 'fulfilled'))
    const actualShift = await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })
    const actualRequest = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: request.id } })
    if (actualRequest.status === 'APPROVED') assert.equal(actualShift.scheduledStartAt.toISOString(), '2039-06-02T07:00:00.000Z')
    else assert.equal(actualRequest.status, 'CANCELLED')
    assert.notEqual(actualRequest.status, 'PENDING')
  })
})

describe('notification history, invitation presentation and email policy', { concurrency: false }, () => {
  let organization: Awaited<ReturnType<typeof createOrganization>>
  let maker: { id: string; email: string }
  let receiver: { id: string; email: string }
  let receiverMemberId: string
  before(async () => {
    maker = await prisma.user.create({ data: { email: email('notice-owner'), passwordHash: 'test-only', emailVerifiedAt: new Date(), firstName: 'Иван', lastName: 'Петров', middleName: 'Иванович' } })
    receiver = await prisma.user.create({ data: { email: email('notice-member'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    organization = await createOrganization(maker.id, { name: 'Notification history', description: null, timezone: 'Asia/Vladivostok' })
  })

  it('includes logo and employee identity in registered, email-token and code invitations; reading does not consume the invite', async () => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#444' } }).png().toBuffer()
    const logoUrl = await replaceOrganizationLogo(maker.id, organization.id, image)
    try {
      const result = await createEmailInvitation(maker.id, organization.id, receiver.email)
      assert.equal(result.inviterName, 'Петров Иван Иванович')
      assert.equal(result.logoUrl, logoUrl)
      assert.equal(result.invitation.expiresAt.getTime() - result.invitation.createdAt.getTime(), 86_400_000)
      const pending = (await listPendingInvitations(receiver.email)).find(item => item.id === result.invitation.id)!
      assert.equal(pending.invitedBy, 'Петров Иван Иванович')
      assert.equal(pending.organization.logoUrl, logoUrl)
      assert.equal((await previewEmailInvitation(receiver.email, result.token)).organization.logoUrl, logoUrl)
      const code = await createCodeInvitation(maker.id, organization.id)
      const codePreview = await previewCodeInvitation(receiver.id, code.code)
      assert.equal(codePreview.organization.logoUrl, logoUrl)
      assert.equal(codePreview.invitedBy, 'Петров Иван Иванович')
      const id = `invite:${pending.id}`
      await readHistoryNotification(receiver.id, receiver.email, id, false)
      let item = (await listNotificationHistory(receiver.id, receiver.email, { limit: 20 })).notifications.find(item => item.id === id)!
      assert.equal(item.state, 'ACTIVE')
      assert.ok(item.readAt)
      assert.equal(item.organization.logoUrl, logoUrl)
      assert.equal(item.inviter, 'Петров Иван Иванович')
      assert.equal(item.href, `/app#invitation-${pending.id}`)
      await readHistoryNotification(receiver.id, receiver.email, id, true)
      assert.equal((await listNotificationHistory(receiver.id, receiver.email, { limit: 20, unread: true })).notifications.find(item => item.id === id)?.readAt, null)
      await acceptEmailInvitation(receiver.id, receiver.email, pending.id)
      item = (await listNotificationHistory(receiver.id, receiver.email, { limit: 20 })).notifications.find(item => item.id === id)!
      assert.equal(item.state, 'ACCEPTED')
      assert.ok(item.readAt)
      assert.equal(item.href, `/app/organizations/${organization.id}`)
      await expectCode(() => acceptEmailInvitation(receiver.id, receiver.email, pending.id), 'INVITATION_ALREADY_USED')
      receiverMemberId = (await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: receiver.id } } })).id
    } finally { await removeOrganizationLogo(maker.id, organization.id); await cleanupPendingFiles() }
  })

  it('retains a pre-registration invitation for the new matching account and rejects another recipient', async () => {
    const newEmail = email('notice-new-user')
    const invite = await createEmailInvitation(maker.id, organization.id, newEmail)
    assert.equal(await prisma.user.count({ where: { email: newEmail } }), 0)
    const newcomer = await prisma.user.create({ data: { email: newEmail, passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    assert.equal((await previewEmailInvitation(newEmail, invite.token)).id, invite.invitation.id)
    assert.ok((await listNotificationHistory(newcomer.id, newEmail, { limit: 20 })).notifications.some(item => item.id === `invite:${invite.invitation.id}`))
    await expectCode(() => previewEmailInvitation(receiver.email, invite.token), 'INVITATION_EMAIL_MISMATCH')
    await expectCode(() => readHistoryNotification(receiver.id, receiver.email, `invite:${invite.invitation.id}`, false), 'NOTIFICATION_NOT_FOUND')
    await acceptEmailInvitation(newcomer.id, newEmail, invite.invitation.id)
    assert.equal((await listNotificationHistory(newcomer.id, newEmail, { limit: 20 })).notifications[0].state, 'ACCEPTED')
  })

  it('preserves expired, rejected and revoked invitations with email fallback and blocks expiration at the exact boundary', async () => {
    await prisma.user.update({ where: { id: maker.id }, data: { firstName: null, lastName: null, middleName: null } })
    const recipient = await prisma.user.create({ data: { email: email('notice-expired'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    const expired = await createEmailInvitation(maker.id, organization.id, recipient.email)
    assert.equal(expired.inviterName, maker.email)
    await prisma.organizationInvite.update({ where: { id: expired.invitation.id }, data: { expiresAt: new Date() } })
    await expectCode(() => acceptEmailInvitation(recipient.id, recipient.email, expired.invitation.id), 'INVITATION_EXPIRED')
    await expectCode(() => previewEmailInvitation(recipient.email, expired.token), 'INVITATION_EXPIRED')
    const rejected = await createEmailInvitation(maker.id, organization.id, recipient.email)
    await rejectEmailInvitation(recipient.email, rejected.invitation.id)
    const revoked = await createEmailInvitation(maker.id, organization.id, recipient.email)
    await revokeInvitation(maker.id, organization.id, revoked.invitation.id)
    const states = (await listNotificationHistory(recipient.id, recipient.email, { limit: 20 })).notifications.map(item => item.state)
    // Creating a replacement can revoke expired records; expiry itself remains impossible to accept.
    assert.ok(states.includes('EXPIRED'))
    assert.ok(states.includes('REJECTED'))
    assert.ok(states.includes('REVOKED'))
    assert.equal((await listPendingInvitations(recipient.email)).length, 0)
    assert.equal(invitationTimeRemaining('2026-01-02T00:00:00Z', Date.parse('2026-01-01T12:34:00Z')), 'Осталось 11 ч 26 мин')
    assert.equal(invitationTimeRemaining('2026-01-02T00:00:00+03:00', Date.parse('2026-01-01T21:00:00Z')), 'Срок истёк')
    assert.equal(invitationTimeRemaining('2026-01-02T00:00:00Z', Date.parse('2026-01-01T23:59:59Z')), 'Осталось 1 мин')
  })

  it('includes an accepted one-time code only in its actual recipient history', async () => {
    const recipient = await prisma.user.create({ data: { email: email('notice-code'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    const code = await createCodeInvitation(maker.id, organization.id)
    await acceptCodeInvitation(recipient.id, recipient.email, code.code)
    const id = `invite:${code.invitation.id}`
    const history = await listNotificationHistory(recipient.id, recipient.email, { limit: 20 })
    assert.equal(history.notifications.find(item => item.id === id)?.state, 'ACCEPTED')
    assert.ok(!(await listNotificationHistory(receiver.id, receiver.email, { limit: 50 })).notifications.some(item => item.id === id))
    await expectCode(() => readHistoryNotification(receiver.id, receiver.email, id, false), 'NOTIFICATION_NOT_FOUND')
    await readHistoryNotification(recipient.id, recipient.email, id, true)
    assert.ok((await listNotificationHistory(recipient.id, recipient.email, { limit: 20, unread: true })).notifications.some(item => item.id === id))
  })

  it('paginates mixed sources at identical timestamps without repetition or omissions and enforces read ownership', async () => {
    const reader = await prisma.user.create({ data: { email: email('notice-pages'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    const timestamp = new Date('2040-01-01T00:00:00Z')
    const events = await prisma.accountNotification.createManyAndReturn({ data: Array.from({ length: 42 }, (_, i) => ({ userId: reader.id, organizationId: organization.id, type: 'ROLE_CHANGED' as const, title: `Событие ${i}`, message: 'Проверка', createdAt: timestamp })) })
    const invite = await createEmailInvitation(maker.id, organization.id, reader.email)
    await prisma.organizationInvite.update({ where: { id: invite.invitation.id }, data: { createdAt: timestamp } })
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = await listNotificationHistory(reader.id, reader.email, { limit: 7, cursor })
      assert.ok(page.notifications.length <= 7)
      ids.push(...page.notifications.map(item => item.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.equal(ids.length, 43)
    assert.equal(new Set(ids).size, 43)
    await readHistoryNotification(reader.id, reader.email, `event:${events[0].id}`, false)
    await readHistoryNotification(reader.id, reader.email, `event:${events[0].id}`, false) // idempotent
    assert.equal((await listNotificationHistory(reader.id, reader.email, { limit: 50, unread: true })).notifications.length, 42)
    await readHistoryNotification(reader.id, reader.email, `event:${events[0].id}`, true)
    await expectCode(() => readHistoryNotification(receiver.id, receiver.email, `event:${events[0].id}`, false), 'NOTIFICATION_NOT_FOUND')
    await expectCode(() => listNotificationHistory(reader.id, reader.email, { limit: 20, cursor: 'invalid' }), 'INVALID_CURSOR')
    assert.equal(decodeNotificationCursor(undefined), null)
  })

  it('keeps immutable assignment/change/cancellation events; description edits never produce another notification', async () => {
    const input = { memberId: receiverMemberId, startDate: '2041-02-01', startTime: '10:00', endDate: '2041-02-01', endTime: '18:00', breakMinutes: 0, description: null }
    const shift = await createShift(maker.id, organization.id, input)
    await updateShift(maker.id, organization.id, shift.id, { ...input, description: 'Уточнение' })
    assert.equal(await prisma.accountNotification.count({ where: { shiftId: shift.id } }), 1)
    await updateShift(maker.id, organization.id, shift.id, { ...input, startTime: '11:00' })
    await cancelShift(maker.id, organization.id, shift.id, 'Отмена')
    const events = await prisma.accountNotification.findMany({ where: { shiftId: shift.id }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(events.map(item => item.type), ['SHIFT_ASSIGNED', 'SHIFT_CHANGED', 'SHIFT_CANCELLED'])
    assert.ok(events[0].message.includes('10:00'))
    assert.ok(events[1].message.includes('11:00'))
    const history = await listNotificationHistory(receiver.id, receiver.email, { limit: 50 })
    assert.ok(history.notifications.some(item => item.type === 'SHIFT_CANCELLED' && item.href?.includes(`shift=${shift.id}`)))
  })

  it('limits concurrent urgent shift email attempts per employee and organization while retaining every in-app event', async () => {
    const now = new Date('2042-01-01T00:00:00Z')
    const events = await prisma.accountNotification.createManyAndReturn({ data: Array.from({ length: 3 }, () => ({ userId: receiver.id, organizationId: organization.id, type: 'SHIFT_CHANGED' as const, title: 'Изменение', message: 'Тест' })) })
    const results = await Promise.all(events.map(event => reserveShiftEmail(event.id, receiver.id, organization.id, now)))
    assert.equal(results.filter(Boolean).length, 1)
    assert.equal(await prisma.accountNotification.count({ where: { id: { in: events.map(item => item.id) } } }), 3)
    assert.equal(await reserveShiftEmail(events[results.findIndex(value => !value)].id, receiver.id, organization.id, new Date(now.getTime() + 3_600_000)), true)
    assert.equal(await reserveShiftEmail(events[results.findIndex(Boolean)].id, receiver.id, organization.id, new Date(now.getTime() + 7_200_000)), false)
    assert.equal(isUrgentShiftEmail(new Date(now.getTime() + 23 * 3_600_000), new Date(now.getTime() + 25 * 3_600_000), now), true)
    assert.equal(isUrgentShiftEmail(new Date(now.getTime() + 25 * 3_600_000), new Date(now.getTime() + 26 * 3_600_000), now), false)
    assert.equal(isUrgentShiftEmail(new Date(now.getTime() - 10_000), new Date(now.getTime() - 1), now), false)
  })
})
