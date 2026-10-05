import * as documentsService from '../src/server/documents/service.ts'
import { listSchema as documentListSchema, assignSchema as assignmentSchema } from '../src/server/documents/schemas.ts'
import { reportSickness, changeAbsence, listAbsences, absenceListQuery, absencePeriodBody } from '../src/server/schedule/absence-service.ts'
import { absenceDays } from '../src/app/schedule/absence-format.ts'
import { writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { planningData, savePosition, saveTemplate, assignPositions, saveWorkload, templateBody } from '../src/server/schedule/planning.ts'
import { decodeNotificationCursor, isUrgentShiftEmail, listNotificationHistory, readHistoryNotification, updateAllNotifications, reserveShiftEmail } from '../src/server/organizations/notification-service.ts'
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
import { createShiftBatch, cancelShift, correctActualTime, createShift, getShift, listMyUpcomingShifts, listSchedule, listCancelledShifts, listShiftNotifications, readShiftNotification, updateShift } from '../src/server/schedule/service.ts'
import { memberStatistics, myStatistics, organizationStatistics } from '../src/server/schedule/statistics.ts'
import { zonedDateTimeToUtc } from '../src/server/schedule/timezone.ts'
import { calendarRange, moveMonth, shiftState, shiftTimeRange } from '../src/app/schedule/date-utils.ts'
import sharp from 'sharp'
import { stageStoredFile, cleanupPendingFiles, removeOrganizationLogo, removeUserAvatar, replaceOrganizationLogo, replaceUserAvatar } from '../src/server/storage/image-service.ts'
import { deleteObject, readObject, storageRoot, writeObject } from '../src/server/storage/local-file-storage.ts'
import { formatRussianPhone, normalizeRussianPhone } from '../src/app/profile/phone.ts'
import { respondToStaffing, cancelRequest, createRequest, createRequestType, getRequest, listRequests, listRequestTypes, resolveRequest, updateRequest, updateRequestType } from '../src/server/requests/service.ts'
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
  await prisma.locationTransfer.deleteMany()
  await prisma.accountNotification.deleteMany()
  await prisma.documentAcknowledgement.deleteMany()
  await prisma.document.deleteMany()
  await prisma.documentFolder.updateMany({ data: { parentId: null } })
  await prisma.documentFolder.deleteMany()
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
    await expectCode(() => changeMemberRole(admin.id, first.id, ownerMembership.id, 'MEMBER'), 'OWNER_REQUIRED')
    await expectCode(() => removeMember(admin.id, first.id, ownerMembership.id), 'INSUFFICIENT_PERMISSIONS')
    assert.notEqual(first.id, second.id)
  })
})

describe('requests workflow, privacy and schedule integration', { concurrency: false }, () => {
  it('supports system and custom types while protecting type management', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const types = await listRequestTypes(member.id, organization.id)
    assert.equal(types.filter((type) => type.systemCode).length, 9)
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
    const image = await addRequestAttachment(member.id, organization.id, request.id, jpeg, 'image/jpeg', encodeURIComponent('../spravka.exe'))
    // A complete one-page PDF fixture (the old header-only stub did not open).
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>']
    let documentText = '%PDF-1.4\n'
    const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(documentText); documentText += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset })
    const xref = Buffer.byteLength(documentText)
    documentText += 'xref\n0 4\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const pdf = Buffer.from(documentText)
    assert.equal(image.fileName, '_spravka.jpg')
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
    const consumed = await prisma.organizationInvite.findUniqueOrThrow({ where: { id: codeInvite.invitation.id } })
    assert.ok([outsider.id, member.id].includes(consumed.acceptedByUserId!))
    assert.ok(await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: organization.id, userId: consumed.acceptedByUserId! } } }))
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
    const logoUrl = await replaceOrganizationLogo(owner.id, organization.id, image)
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

  it('preserves an existing disk object when a new upload key collides', async () => {
    const key = `users/${owner.id}/avatars/${randomUUID()}.webp`
    await writeObject(key, Buffer.from('existing object'))
    await assert.rejects(() => stageStoredFile({ objectKey: key, mimeType: 'image/webp', size: 3, checksumSha256: '0'.repeat(64), purpose: 'USER_AVATAR', uploadedByUserId: owner.id }, Buffer.from('new')), /already exists/)
    assert.equal((await readObject(key)).toString(), 'existing object')
    assert.equal(await prisma.storedFile.findUnique({ where: { objectKey: key } }), null)
    await deleteObject(key)
  })
  it('tracks interrupted uploads durably, protects live intents and cleans only their owned temp files', async () => {
    const bytes = Buffer.from('interrupted upload fixture')
    const file = await stageStoredFile({ objectKey: `users/${owner.id}/avatars/${randomUUID()}.webp`, mimeType: 'image/webp', size: bytes.length, checksumSha256: '0'.repeat(64), purpose: 'USER_AVATAR', uploadedByUserId: owner.id }, bytes)
    await cleanupPendingFiles()
    assert.equal((await readObject(file.objectKey)).toString(), bytes.toString())
    const temporary = path.join(storageRoot, `${file.objectKey}.${randomUUID()}.tmp`)
    const unrelated = path.join(storageRoot, `${file.objectKey}.unknown.tmp`)
    await writeFile(temporary, bytes); await writeFile(unrelated, bytes)
    await prisma.storedFile.update({ where: { id: file.id }, data: { pendingDeletionAt: new Date(Date.now() - 1000) } })
    await cleanupPendingFiles()
    assert.equal(await prisma.storedFile.findUnique({ where: { id: file.id } }), null)
    await assert.rejects(() => access(temporary))
    await assert.rejects(() => readObject(file.objectKey))
    await access(unrelated) // Unknown names are preserved, never guessed to be ours.
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

  it('lets only OWNER edit public organization data and exposes member profiles safely', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    await updateOrganization(owner.id, organization.id, { name: organization.name, description: 'Открытая кофейня', timezone: 'Europe/Moscow', contactEmail: 'team@example.test', phone: '+79991234567', website: 'https://example.test', address: 'Москва' })
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
  it('lets only OWNER manage shared non-owner roles', async () => {
    const organization = (await listOrganizations(owner.id))[0]
    const target = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: member.id } } })
    await expectCode(() => changeMemberRole(admin.id, organization.id, target.id, 'ADMIN'), 'OWNER_REQUIRED')
    await changeMemberRole(owner.id, organization.id, target.id, 'ADMIN')
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
    assert.equal(calendarRange('2028-02').days.length, 35)
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
    const foreign = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: { not: scheduleOrganizationId }, userId: owner.id } })
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
      assert.ok(item.href?.startsWith(`/app/organizations/${organization.id}?location=`))
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
    await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: reader.id, role: 'MEMBER' } })

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

  it('isolates history, badge, floating alerts, read-all and removal across organizations and rejects lost membership', async () => {
    const other = await createOrganization(maker.id, { name: 'Other notices', description: null, timezone: 'Europe/Moscow' })
    const privateOrg = await createOrganization(maker.id, { name: 'Private notices', description: null, timezone: 'Europe/Moscow' })
    await prisma.organizationMember.create({ data: { organizationId: other.id, userId: receiver.id, role: 'MEMBER' } })
    const a = await prisma.accountNotification.create({ data: { userId: receiver.id, organizationId: organization.id, type: 'REQUEST_CREATED', title: 'A', message: 'A' } })
    const b = await prisma.accountNotification.create({ data: { userId: receiver.id, organizationId: other.id, type: 'REQUEST_CREATED', title: 'B', message: 'B' } })
    const inaccessible = await prisma.accountNotification.create({ data: { userId: receiver.id, organizationId: privateOrg.id, type: 'ROLE_CHANGED', title: 'Private', message: 'Private' } })
    const global = await listNotificationHistory(receiver.id, receiver.email, { limit: 50, unread: true })
    assert.ok(global.notifications.some(item => item.id === `event:${a.id}`))
    assert.ok(global.notifications.some(item => item.id === `event:${b.id}`))
    assert.ok(!global.notifications.some(item => item.id === `event:${inaccessible.id}`))
    const scoped = await listNotificationHistory(receiver.id, receiver.email, { limit: 50, organizationId: other.id, unread: true, category: 'REQUEST' })
    assert.deepEqual(scoped.notifications.map(item => item.id), [`event:${b.id}`])
    assert.equal(scoped.unreadCount, 1)
    assert.deepEqual((await listAccountNotifications(receiver.id, other.id)).map(item => item.id), [b.id])
    await expectCode(() => listNotificationHistory(receiver.id, receiver.email, { limit: 20, organizationId: privateOrg.id }), 'ORGANIZATION_NOT_FOUND')
    await expectCode(() => readHistoryNotification(receiver.id, receiver.email, `event:${a.id}`, false, other.id), 'NOTIFICATION_NOT_FOUND')
    await expectCode(() => updateAllNotifications(receiver.id, receiver.email, { organizationId: other.id }, `event:${a.id}`), 'NOTIFICATION_NOT_FOUND')
    await updateAllNotifications(receiver.id, receiver.email, { organizationId: other.id })
    assert.equal((await listNotificationHistory(receiver.id, receiver.email, { limit: 20, organizationId: other.id, unread: true })).notifications.length, 0)
    assert.equal((await listNotificationHistory(receiver.id, receiver.email, { limit: 20, organizationId: other.id })).notifications.length, 1)
    assert.equal((await prisma.accountNotification.findUniqueOrThrow({ where: { id: a.id } })).readAt, null)
    await readHistoryNotification(receiver.id, receiver.email, `event:${b.id}`, true, other.id)
    assert.equal((await listNotificationHistory(receiver.id, receiver.email, { limit: 20, organizationId: other.id })).unreadCount, 1)
    await updateAllNotifications(receiver.id, receiver.email, { organizationId: other.id }, `event:${b.id}`)
    assert.equal((await listNotificationHistory(receiver.id, receiver.email, { limit: 20, organizationId: other.id })).notifications.length, 0)
    assert.ok((await prisma.accountNotification.findUniqueOrThrow({ where: { id: b.id } })).hiddenAt)
    await prisma.organizationMember.update({ where: { organizationId_userId: { organizationId: other.id, userId: receiver.id } }, data: { leftAt: new Date() } })
    await expectCode(() => listAccountNotifications(receiver.id, other.id), 'ORGANIZATION_NOT_FOUND')
    await expectCode(() => readHistoryNotification(receiver.id, receiver.email, `event:${b.id}`, true), 'NOTIFICATION_NOT_FOUND')
  })

  it('reloads encrypted one-time codes from backend and hiding an invitation notification never revokes it', async () => {
    const code = await createCodeInvitation(maker.id, organization.id)
    assert.equal((await listActiveOrganizationInvitations(maker.id, organization.id)).find(item => item.id === code.invitation.id)?.code, code.code)
    const stored = await prisma.organizationInvite.findUniqueOrThrow({ where: { id: code.invitation.id } })
    assert.ok(stored.codeCiphertext && !stored.codeCiphertext.includes(code.code))
    await expectCode(() => listActiveOrganizationInvitations(receiver.id, organization.id), 'INSUFFICIENT_PERMISSIONS')
    await revokeInvitation(maker.id, organization.id, code.invitation.id)
    assert.ok(!(await listActiveOrganizationInvitations(maker.id, organization.id)).some(item => item.id === code.invitation.id))
    const recipient = await prisma.user.create({ data: { email: email('hidden-invite'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    const invite = await createEmailInvitation(maker.id, organization.id, recipient.email)
    await updateAllNotifications(recipient.id, recipient.email, {}, `invite:${invite.invitation.id}`)
    assert.equal((await listNotificationHistory(recipient.id, recipient.email, { limit: 20 })).notifications.length, 0)
    assert.ok((await listPendingInvitations(recipient.email)).some(item => item.id === invite.invitation.id))
    await acceptEmailInvitation(recipient.id, recipient.email, invite.invitation.id)
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

describe('schedule presentation and personal period regressions', { concurrency: false }, () => {
  it('fits each month to complete Monday-based weeks without losing dates, including leap years over ten years', () => {
    assert.equal(calendarRange('2027-02').days.length, 28)
    assert.equal(calendarRange('2028-02').days.length, 35)
    assert.equal(calendarRange('2026-03').days.length, 42)
    for (let year = 2026; year <= 2036; year++) for (let month = 1; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, '0')}`
      const range = calendarRange(key)
      const count = new Date(Date.UTC(year, month, 0)).getUTCDate()
      assert.ok([28, 35, 42].includes(range.days.length))
      assert.equal(range.days.filter(day => day.startsWith(key)).length, count)
      assert.equal(new Set(range.days).size, range.days.length)
      assert.equal(new Date(`${range.from}T00:00:00Z`).getUTCDay(), 1)
      assert.equal(new Date(`${range.to}T00:00:00Z`).getUTCDay(), 1)
      assert.ok(range.days.includes(`${key}-01`))
      assert.ok(range.days.includes(`${key}-${String(count).padStart(2, '0')}`))
    }
    assert.ok(!calendarRange('2100-02').days.includes('2100-02-29'))
    assert.ok(calendarRange('2000-02').days.includes('2000-02-29'))
  })

  it('uses actual time for status and labels overnight/changed dates in the organization timezone', () => {
    const shift = { status: 'SCHEDULED' as const, scheduledStartAt: '2026-01-01T18:00:00Z', scheduledEndAt: '2026-01-02T03:00:00Z', actualStartAt: null, actualEndAt: null }
    assert.equal(shiftState(shift, Date.parse('2026-01-01T17:00:00Z')).label, 'Запланирована')
    assert.equal(shiftState(shift, Date.parse('2026-01-01T19:00:00Z')).label, 'Идёт сейчас')
    assert.equal(shiftState(shift, Date.parse('2026-01-02T03:00:00Z')).label, 'Завершена')
    assert.equal(shiftState({ ...shift, status: 'CANCELLED' }, Date.parse('2026-01-01T19:00:00Z')).label, 'Отменена')
    assert.equal(shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, 'Europe/Moscow'), '01.01, 21:00 → 02.01, 06:00')
    assert.equal(shiftTimeRange('2026-01-02T06:00:00Z', '2026-01-02T12:00:00Z', 'Europe/Moscow', '2026-01-01'), '02.01, 09:00 → 02.01, 15:00')
    assert.equal(shiftTimeRange('2026-01-02T06:00:00Z', '2026-01-02T12:00:00Z', 'Europe/Moscow'), '09:00–15:00')
  })

  it('hides cancelled shifts from the working calendar but preserves direct details and the personal paginated history with paid breaks and plan/fact totals', async () => {
    const organization = await createOrganization(owner.id, { name: 'Schedule presentation regression', description: null, timezone: 'Asia/Vladivostok' })
    const employee = await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: member.id } })
    const other = await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: admin.id } })
    const input = { memberId: employee.id, startDate: '2025-03-01', startTime: '10:00', endDate: '2025-03-01', endTime: '18:00', breakMinutes: 60, description: null }
    const completed = await createShift(owner.id, organization.id, input)
    await correctActualTime(owner.id, organization.id, completed.id, { startDate: '2025-03-01', startTime: '11:00', endDate: '2025-03-01', endTime: '17:00', breakMinutes: 30, reason: 'Фактическое время' })
    const cancelled = await createShift(owner.id, organization.id, { ...input, startDate: '2025-03-02', endDate: '2025-03-02' })
    await cancelShift(owner.id, organization.id, cancelled.id, 'График отменён')
    await createShift(owner.id, organization.id, { ...input, memberId: other.id })
    await createShift(owner.id, organization.id, { ...input, startDate: '2025-04-01', endDate: '2025-04-01' })
    const calendar = await listSchedule(member.id, organization.id, '2025-03-01', '2025-04-01')
    assert.ok(!calendar.shifts.some(shift => shift.id === cancelled.id))
    assert.ok(calendar.shifts.some(shift => shift.id === completed.id))
    assert.equal((await getShift(member.id, organization.id, cancelled.id)).status, 'CANCELLED')
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: cancelled.id } })).status, 'CANCELLED')
    const options = { from: '2025-03-01', to: '2025-04-01', memberState: 'all' as const, sort: 'name' as const, direction: 'asc' as const, page: 1, limit: 1, historyOrder: 'asc' as const }
    const first = await myStatistics(member.id, organization.id, options)
    assert.equal(first.history.length, 1)
    assert.equal(first.pagination.total, 2)
    assert.equal(first.history[0].id, completed.id)
    assert.equal(first.history[0].breakMinutes, 60)
    assert.equal(first.history[0].actualBreakMinutes, 30)
    assert.equal(first.history[0].plannedMinutes, 480)
    assert.equal(first.history[0].actualMinutes, 360)
    assert.equal(first.history[0].minutes, 360)
    assert.equal(first.period?.workedMinutes, 360) // The whole period, never just this page or another employee.
    assert.equal(first.period?.workedShifts, 1)
    const second = await myStatistics(member.id, organization.id, { ...options, page: 2 })
    assert.equal(second.history[0].id, cancelled.id)
    assert.equal(second.period?.workedMinutes, 360)
    await expectCode(() => memberStatistics(member.id, organization.id, other.id, options), 'INSUFFICIENT_PERMISSIONS')
  })
})

describe('positions, templates, atomic batches and employee proposals', () => {
  let organizationId: string
  let employeeId: string
  let positionId: string
  const input = (day: string, start = '09:00', end = '18:00') => ({ memberId: employeeId, positionId, startDate: day, startTime: start, endDate: day, endTime: end, breakMinutes: 0, description: null })
  it('keeps multiple positions separate from authorization and validates organization boundaries', async () => {
    const organization = await createOrganization(owner.id, { name: 'Planning regressions', description: null, timezone: 'Asia/Vladivostok' })
    organizationId = organization.id
    const employee = await prisma.organizationMember.create({ data: { organizationId, userId: member.id, role: 'MEMBER' } }); employeeId = employee.id
    await prisma.organizationMember.create({ data: { organizationId, userId: admin.id, role: 'ADMIN' } })
    const first = await savePosition(owner.id, organizationId, null, { name: 'Бариста', isActive: true }); positionId = first.id
    const second = await savePosition(owner.id, organizationId, null, { name: 'Кассир', isActive: true })
    await assignPositions(admin.id, organizationId, employeeId, [first.id, second.id])
    assert.equal((await planningData(member.id, organizationId)).assignments.filter(item => item.memberId === employeeId).length, 2)
    assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: employeeId } })).role, 'MEMBER')
    const positioned = await listMembersPage(owner.id, organizationId, { positionId: first.id })
    assert.deepEqual(positioned.members.map(item => item.id), [employeeId])
    assert.deepEqual(positioned.members[0].positions.map(item => item.name).sort(), ['Бариста', 'Кассир'])
    const unassigned = await listMembersPage(owner.id, organizationId, { positionId: 'unassigned' })
    assert.equal(unassigned.members.some(item => item.id === employeeId), false)
    assert.equal((await listMembers(member.id, organizationId)).find(item => item.id === employeeId)?.positions.length, 2)
    await expectCode(() => savePosition(member.id, organizationId, null, { name: 'Админ', isActive: true }), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => assignPositions(owner.id, organizationId, employeeId, [randomUUID()]), 'POSITION_INACTIVE')
    await expectCode(() => savePosition(outsider.id, organizationId, null, { name: 'Чужая', isActive: true }), 'ORGANIZATION_NOT_FOUND')
  })
  it('validates reusable overnight templates without changing saved shifts', async () => {
    assert.equal(templateBody.safeParse({ name: 'Ночная', positionId, startTime: '21:00', endTime: '09:00', endDayOffset: 1 }).success, true)
    assert.equal(templateBody.safeParse({ name: 'Ночная', positionId, startTime: '21:00', endTime: '09:00', endDayOffset: 0 }).success, false)
    assert.equal(templateBody.safeParse({ name: 'Ошибка', positionId, startTime: '25:00', endTime: '26:00', endDayOffset: 0 }).success, false)
    const template = await saveTemplate(owner.id, organizationId, null, { name: 'Дневная', positionId, startTime: '09:00', endTime: '18:00', endDayOffset: 0, isActive: true })
    const shift = await createShift(owner.id, organizationId, input('2050-09-10'))
    await saveTemplate(admin.id, organizationId, template.id, { ...template, startTime: '10:00', endTime: '19:00' })
    assert.equal((await getShift(member.id, organizationId, shift.id)).scheduledStartAt.toISOString(), '2050-09-09T23:00:00.000Z')
    assert.equal(shift.positionName, 'Бариста')
    await savePosition(owner.id, organizationId, positionId, { name: 'Старший бариста', isActive: true })
    assert.equal((await getShift(member.id, organizationId, shift.id)).positionName, 'Бариста')
  })
  it('rolls back an entire batch on existing, intra-batch and absence conflicts, including notifications', async () => {
    const count = await prisma.workShift.count({ where: { organizationId } })
    const notifications = await prisma.accountNotification.count({ where: { organizationId } })
    await expectCode(() => createShiftBatch(owner.id, organizationId, [input('2050-09-12'), input('2050-09-10')]), 'SHIFT_OVERLAP')
    assert.equal(await prisma.workShift.count({ where: { organizationId } }), count)
    assert.equal(await prisma.accountNotification.count({ where: { organizationId } }), notifications)
    await expectCode(() => createShiftBatch(owner.id, organizationId, [input('2050-09-14'), input('2050-09-14', '17:00', '20:00')]), 'SHIFT_OVERLAP')
    const types = await listRequestTypes(owner.id, organizationId)
    const dayOff = types.find(item => item.systemCode === 'DAY_OFF')!
    const request = await createRequest(member.id, organizationId, { requestTypeId: dayOff.id, startDate: '2050-09-16' })
    await resolveRequest(owner.id, organizationId, request.id, 'APPROVED', null)
    await expectCode(() => createShiftBatch(owner.id, organizationId, [input('2050-09-15'), input('2050-09-16')]), 'EMPLOYEE_ABSENT')
    assert.equal(await prisma.workShift.count({ where: { organizationId } }), count)
    const saved = await createShiftBatch(admin.id, organizationId, [input('2050-09-12'), input('2050-09-14', '09:00', '19:00')])
    assert.equal(saved.shifts.length, 2)
    await expectCode(() => createShiftBatch(member.id, organizationId, [input('2050-09-18')]), 'INSUFFICIENT_PERMISSIONS')
    await savePosition(owner.id, organizationId, positionId, { name: 'Старший бариста', isActive: false })
    await expectCode(() => createShiftBatch(owner.id, organizationId, [input('2050-09-18')]), 'POSITION_NOT_ASSIGNED')
    await savePosition(owner.id, organizationId, positionId, { name: 'Старший бариста', isActive: true })
  })
  it('warns on monthly employee workload, excludes cancellations, respects timezone and permits explicit acknowledgment', async () => {
    await saveWorkload(owner.id, organizationId, 30 * 60)
    await expectCode(() => createShiftBatch(owner.id, organizationId, [input('2050-09-18')]), 'WORKLOAD_WARNING')
    const before = await prisma.workShift.count({ where: { organizationId } })
    await createShiftBatch(owner.id, organizationId, [input('2050-09-18')], true)
    assert.equal(await prisma.workShift.count({ where: { organizationId } }), before + 1)
    await createShiftBatch(owner.id, organizationId, [input('2050-10-01')])
    const shift = await createShift(owner.id, organizationId, { ...input('2050-10-02'), acknowledgeWorkload: true })
    await cancelShift(owner.id, organizationId, shift.id, 'Отмена для нормы')
    await createShiftBatch(owner.id, organizationId, [input('2050-10-03')])
    await expectCode(() => saveWorkload(member.id, organizationId, null), 'INSUFFICIENT_PERMISSIONS')
  })
  it('keeps simultaneous batches atomic and does not silently exceed a norm during concurrent planning', async () => {
    await saveWorkload(owner.id, organizationId, 18 * 60)
    const result = await Promise.allSettled([
      createShiftBatch(owner.id, organizationId, [input('2052-01-10'), input('2052-01-12')]),
      createShiftBatch(admin.id, organizationId, [input('2052-01-14'), input('2052-01-16')]),
    ])
    assert.equal(result.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(await prisma.workShift.count({ where: { organizationId, scheduledStartAt: { gte: new Date('2051-12-31T14:00:00Z'), lt: new Date('2052-01-31T14:00:00Z') } } }), 2)
    await saveWorkload(owner.id, organizationId, 30 * 60)
  })
  it('rechecks changed shift requests against the monthly norm and requires reviewer acknowledgment', async () => {
    await saveWorkload(owner.id, organizationId, 10 * 60)
    const shift = await createShift(owner.id, organizationId, input('2050-12-10'))
    const type = (await listRequestTypes(member.id, organizationId)).find(item => item.systemCode === 'SHIFT_CHANGE')!
    const request = await createRequest(member.id, organizationId, { requestTypeId: type.id, relatedShiftId: shift.id, proposedStartDate: '2050-12-10', proposedStartTime: '09:00', proposedEndDate: '2050-12-10', proposedEndTime: '21:00', comment: 'Продлить смену' })
    await expectCode(() => resolveRequest(owner.id, organizationId, request.id, 'APPROVED', null), 'WORKLOAD_WARNING')
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'PENDING')
    await resolveRequest(admin.id, organizationId, request.id, 'APPROVED', null, false, true)
    assert.equal((await getShift(member.id, organizationId, shift.id)).effectiveMinutes, 720)
    await saveWorkload(owner.id, organizationId, 30 * 60)
  })
  it('creates employee proposals without changing the official calendar and revalidates on approval', async () => {
    const type = (await listRequestTypes(owner.id, organizationId)).find(item => item.systemCode === 'SHIFT_PROPOSAL')!
    const proposed = { requestTypeId: type.id, proposedStartDate: '2050-11-10', proposedStartTime: '09:00', proposedEndDate: '2050-11-10', proposedEndTime: '18:00', comment: 'Хочу выйти на смену' }
    const before = await prisma.workShift.count({ where: { organizationId } })
    const request = await createRequest(member.id, organizationId, proposed)
    assert.equal(await prisma.workShift.count({ where: { organizationId } }), before)
    await expectCode(() => resolveRequest(member.id, organizationId, request.id, 'APPROVED', null), 'INSUFFICIENT_PERMISSIONS')
    await resolveRequest(owner.id, organizationId, request.id, 'APPROVED', null)
    const approved = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: request.id } })
    assert.ok(approved.relatedShiftId)
    assert.equal((await getShift(member.id, organizationId, approved.relatedShiftId)).memberId, employeeId)
    const conflict = await createRequest(member.id, organizationId, proposed)
    await expectCode(() => resolveRequest(owner.id, organizationId, conflict.id, 'APPROVED', null), 'SHIFT_OVERLAP')
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: conflict.id } })).status, 'PENDING')
    await expectCode(() => createRequest(member.id, organizationId, { ...proposed, proposedStartDate: '2020-01-01', proposedEndDate: '2020-01-01' }), 'INVALID_SHIFT_PROPOSAL')
  })
})


describe('employee absences: lifecycle, privacy and schedule consistency', { concurrency: false }, () => {
  let org: string, employee: string, adminMember: string
  const input = (date: string, start = '09:00', end = '18:00', endDate = date) => ({ memberId: employee, startDate: date, startTime: start, endDate, endTime: end, breakMinutes: 0, description: null })
  before(async () => {
    const organization = await createOrganization(owner.id, { name: 'Absence tests', timezone: 'Asia/Vladivostok', description: null })
    org = organization.id
    employee = (await prisma.organizationMember.create({ data: { organizationId: org, userId: member.id } })).id
    adminMember = (await prisma.organizationMember.create({ data: { organizationId: org, userId: admin.id, role: 'ADMIN' } })).id
  })
  it('validates inclusive calendar dates and leap days', () => {
    assert.equal(absencePeriodBody.safeParse({ startDate: '2028-02-29', endDate: '2028-03-01' }).success, true)
    assert.equal(absencePeriodBody.safeParse({ startDate: '2027-02-29', endDate: '2027-03-01' }).success, false)
    assert.equal(absencePeriodBody.safeParse({ startDate: '2028-03-02', endDate: '2028-03-01' }).success, false)
    assert.equal(absenceDays('2028-02-28', '2028-03-01'), 3)
  })
  it('registers absence as an informational request without approval and notifies only managers', async () => {
    const before = await prisma.organizationRequest.count({ where: { organizationId: org } })
    const sick = await reportSickness(member.id, org, { startDate: '2052-02-28', endDate: '2052-03-01' })
    assert.equal(sick.type, 'SICK'); assert.ok(sick.sourceRequestId)
    assert.equal(await prisma.organizationRequest.count({ where: { organizationId: org } }), before + 1)
    const notifications = await prisma.accountNotification.findMany({ where: { absenceId: sick.id } })
    assert.deepEqual(notifications.map(n => n.userId).sort(), [owner.id, admin.id].sort())
    assert.ok(notifications.every(n => n.emailAttemptedAt === null))
    const history = await listNotificationHistory(owner.id, owner.email, { limit: 50 })
    assert.ok(history.notifications.some(n => n.href?.startsWith(`/app/organizations/${org}/schedule?absences=1&absence=${sick.id}`)))
    await expectCode(() => reportSickness(member.id, org, { startDate: '2052-03-01', endDate: '2052-03-03' }), 'ABSENCE_OVERLAP')
    await expectCode(() => reportSickness(outsider.id, org, { startDate: '2052-03-01', endDate: '2052-03-03' }), 'ORGANIZATION_NOT_FOUND')
  })
  it('restricts viewing and editing, preserves cancellation history and detects stale edits', async () => {
    const sick = await reportSickness(admin.id, org, { startDate: '2052-04-01', endDate: '2052-04-04' })
    await expectCode(() => changeAbsence(member.id, org, sick.id, { startDate: '2052-04-01', endDate: '2052-04-02', updatedAt: sick.updatedAt.toISOString() }), 'ABSENCE_NOT_FOUND')
    const own = await listAbsences(member.id, org, absenceListQuery.parse({ history: 'true', memberId: adminMember }))
    assert.ok(own.absences.every(a => a.memberId === employee))
    const changed = await changeAbsence(owner.id, org, sick.id, { startDate: '2052-04-01', endDate: '2052-04-02', updatedAt: sick.updatedAt.toISOString() })
    await expectCode(() => changeAbsence(admin.id, org, sick.id, { startDate: '2052-04-01', endDate: '2052-04-03', updatedAt: sick.updatedAt.toISOString() }), 'ABSENCE_CHANGED')
    await changeAbsence(admin.id, org, sick.id, { updatedAt: changed.updatedAt.toISOString(), reason: 'Сообщение ошибочно' })
    const archived = await prisma.employeeAbsence.findUniqueOrThrow({ where: { id: sick.id } })
    assert.ok(archived.cancelledAt); assert.equal(archived.cancelledByMemberId, adminMember)
    assert.equal(archived.cancellationReason, 'Сообщение ошибочно')
    assert.ok(!(await listAbsences(owner.id, org, absenceListQuery.parse({}))).absences.some(a => a.id === sick.id))
    await reportSickness(admin.id, org, { startDate: '2052-04-01', endDate: '2052-04-02' })
    const privateCalendar = await listSchedule(member.id, org, '2052-04-01', '2052-05-01')
    assert.equal(privateCalendar.absences.find(a => a.memberId === adminMember)?.type, 'ABSENCE')
  })
  it('keeps existing overnight shifts, uses organization date boundaries and requires explicit override', async () => {
    const shift = await createShift(owner.id, org, input('2052-05-09', '22:00', '06:00', '2052-05-10'))
    const sick = await reportSickness(member.id, org, { startDate: '2052-05-10', endDate: '2052-05-10' })
    const view = await listAbsences(owner.id, org, absenceListQuery.parse({ id: sick.id }))
    assert.equal(view.absences[0].conflicts[0].id, shift.id)
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'SCHEDULED')
    await expectCode(() => createShift(owner.id, org, input('2052-05-10')), 'EMPLOYEE_ABSENT')
    await createShift(owner.id, org, { ...input('2052-05-10'), acknowledgeAbsence: true })
    await expectCode(() => createShift(member.id, org, { ...input('2052-05-10'), acknowledgeAbsence: true }), 'INSUFFICIENT_PERMISSIONS')
    const boundary = await createShift(owner.id, org, input('2052-05-09', '18:00', '22:00'))
    assert.equal(boundary.scheduledStartAt.toISOString(), '2052-05-09T08:00:00.000Z')
    const batchCount = await prisma.workShift.count({ where: { organizationId: org } })
    await expectCode(() => createShiftBatch(owner.id, org, [input('2052-05-11'), input('2052-05-10', '19:00', '21:00')]), 'EMPLOYEE_ABSENT')
    assert.equal(await prisma.workShift.count({ where: { organizationId: org } }), batchCount)
    await createShiftBatch(owner.id, org, [{ ...input('2052-05-11'), acknowledgeAbsence: true }, { ...input('2052-05-10', '19:00', '21:00'), acknowledgeAbsence: true }])
  })
  it('approves leave exactly once without silently cancelling shifts; rejection creates no absence', async () => {
    const types = await listRequestTypes(member.id, org)
    const vacation = types.find(t => t.systemCode === 'VACATION')!, dayOff = types.find(t => t.systemCode === 'DAY_OFF')!
    const shift = await createShift(owner.id, org, input('2052-06-02'))
    const request = await createRequest(member.id, org, { requestTypeId: vacation.id, startDate: '2052-06-01', endDate: '2052-06-03' })
    const concurrent = await Promise.allSettled([resolveRequest(owner.id, org, request.id, 'APPROVED', null), resolveRequest(admin.id, org, request.id, 'APPROVED', null)])
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(await prisma.employeeAbsence.count({ where: { sourceRequestId: request.id } }), 1)
    assert.deepEqual((await getRequest(owner.id, org, request.id)).absenceConflicts, [])
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'SCHEDULED')
    const rejected = await createRequest(member.id, org, { requestTypeId: dayOff.id, startDate: '2052-06-05' })
    await resolveRequest(owner.id, org, rejected.id, 'REJECTED', 'Нужен другой день')
    assert.equal(await prisma.employeeAbsence.count({ where: { sourceRequestId: rejected.id } }), 0)
    const cancelled = await createRequest(member.id, org, { requestTypeId: dayOff.id, startDate: '2052-06-06' })
    await cancelRequest(member.id, org, cancelled.id)
    await expectCode(() => resolveRequest(owner.id, org, cancelled.id, 'APPROVED', null), 'REQUEST_ALREADY_RESOLVED')
    const overlap = await createRequest(member.id, org, { requestTypeId: dayOff.id, startDate: '2052-06-02' })
    assert.equal((await getRequest(owner.id, org, overlap.id)).absenceConflicts.length, 1)
    await expectCode(() => resolveRequest(owner.id, org, overlap.id, 'APPROVED', null), 'ABSENCE_OVERLAP')
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: overlap.id } })).status, 'PENDING')
    const absence = await prisma.employeeAbsence.findUniqueOrThrow({ where: { sourceRequestId: request.id } })
    await expectCode(() => changeAbsence(member.id, org, absence.id, { startDate: '2052-06-01', endDate: '2052-06-02', updatedAt: absence.updatedAt.toISOString() }), 'INSUFFICIENT_PERMISSIONS')
  })
  it('supports self correction, manager cancellation and absence acknowledgment during request approval', async () => {
    const sick = await reportSickness(member.id, org, { startDate: '2052-09-01', endDate: '2052-09-05' })
    const changed = await changeAbsence(member.id, org, sick.id, { startDate: '2052-09-01', endDate: '2052-09-03', updatedAt: sick.updatedAt.toISOString() })
    assert.equal(changed.endDate.toISOString().slice(0, 10), '2052-09-03')
    const otherOrg = (await listOrganizations(owner.id)).find(o => o.id !== org)!
    await expectCode(() => changeAbsence(owner.id, otherOrg.id, sick.id, { startDate: '2052-09-01', endDate: '2052-09-02', updatedAt: changed.updatedAt.toISOString() }), 'ABSENCE_NOT_FOUND')
    const shift = await createShift(owner.id, org, input('2052-08-31'))
    await expectCode(() => updateShift(owner.id, org, shift.id, input('2052-09-01')), 'EMPLOYEE_ABSENT')
    const moved = await updateShift(owner.id, org, shift.id, { ...input('2052-09-01'), acknowledgeAbsence: true })
    assert.equal(moved.scheduledStartAt.toISOString(), '2052-08-31T23:00:00.000Z')
    const type = (await listRequestTypes(member.id, org)).find(t => t.systemCode === 'SHIFT_PROPOSAL')!
    const request = await createRequest(member.id, org, { requestTypeId: type.id, proposedStartDate: '2052-09-02', proposedStartTime: '09:00', proposedEndDate: '2052-09-02', proposedEndTime: '18:00', comment: 'Прошу назначить смену' })
    await expectCode(() => resolveRequest(owner.id, org, request.id, 'APPROVED', null), 'EMPLOYEE_ABSENT')
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'PENDING')
    await resolveRequest(admin.id, org, request.id, 'APPROVED', null, false, false, true)
    assert.ok((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: request.id } })).relatedShiftId)
    await changeAbsence(owner.id, org, changed.id, { updatedAt: changed.updatedAt.toISOString(), reason: 'Вернулся к работе' })
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'SCHEDULED')
  })
  it('stores personal absence reason and comment without approval and allows only authorized self changes', async () => {
    const item = await reportSickness(member.id, org, { startDate: '2053-02-01', endDate: '2053-02-02', reason: 'PERSONAL', comment: 'Личные обстоятельства' })
    assert.equal(item.type, 'ABSENCE')
    assert.ok(item.sourceRequestId)
    const view = await listAbsences(owner.id, org, absenceListQuery.parse({ id: item.id, history: 'true' }))
    assert.equal(view.absences[0].reason, 'PERSONAL')
    assert.equal(view.absences[0].comment, 'Личные обстоятельства')
    await expectCode(() => changeAbsence(outsider.id, org, item.id, { startDate: '2053-02-01', endDate: '2053-02-03', updatedAt: item.updatedAt.toISOString() }), 'ORGANIZATION_NOT_FOUND')
    const edited = await changeAbsence(member.id, org, item.id, { startDate: '2053-02-01', endDate: '2053-02-03', updatedAt: item.updatedAt.toISOString() })
    assert.equal(edited.endDate.toISOString().slice(0, 10), '2053-02-03')
    const privateView = await listSchedule(admin.id, org, '2053-02-01', '2053-03-01')
    assert.equal(privateView.absences.find(row => row.id === item.id)?.reason, 'PERSONAL')
    await changeAbsence(member.id, org, item.id, { updatedAt: edited.updatedAt.toISOString(), reason: 'Планы изменились' })
  })

  it('keeps informational requests mandatory, editable and cancellable in the shared history', async () => {
    const type = (await listRequestTypes(member.id, org)).find(t => t.systemCode === 'SICK')!
    await expectCode(() => updateRequestType(owner.id, org, type.id, { name: type.name, description: type.description, dateMode: type.dateMode, requiresComment: type.requiresComment, allowsAttachments: type.allowsAttachments, isActive: false }), 'MANDATORY_REQUEST_TYPE')
    const report = await createRequest(member.id, org, { requestTypeId: type.id, startDate: '2055-03-01', endDate: '2055-03-02', absenceReason: 'OTHER', comment: 'Проверка сообщения' })
    assert.equal(report.status, 'APPROVED')
    assert.equal((await listRequests(owner.id, org, 'incoming', { page: 1, pageSize: 50 })).requests.some(r => r.id === report.id), false)
    assert.ok((await listRequests(owner.id, org, 'history', { page: 1, pageSize: 50 })).requests.some(r => r.id === report.id))
    await expectCode(() => resolveRequest(owner.id, org, report.id, 'APPROVED', null), 'INFORMATIONAL_REQUEST')
    await expectCode(() => updateRequest(outsider.id, org, report.id, { requestTypeId: type.id, startDate: '2055-03-01', endDate: '2055-03-02' }), 'ORGANIZATION_NOT_FOUND')
    await updateRequest(member.id, org, report.id, { requestTypeId: type.id, startDate: '2055-03-01', endDate: '2055-03-03', absenceReason: 'PERSONAL', comment: 'Изменено' })
    const detail = await getRequest(member.id, org, report.id)
    assert.equal(detail.request.absenceReason, 'PERSONAL')
    const absence = await prisma.employeeAbsence.findUniqueOrThrow({ where: { sourceRequestId: report.id } })
    assert.equal(absence.endDate.toISOString().slice(0, 10), '2055-03-03')
    await expectCode(() => cancelRequest(admin.id, org, report.id), 'REQUEST_NOT_FOUND')
    await cancelRequest(member.id, org, report.id)
    assert.ok((await prisma.employeeAbsence.findUniqueOrThrow({ where: { id: absence.id } })).cancelledAt)
    assert.equal((await getRequest(owner.id, org, report.id)).request.status, 'CANCELLED')
    await expectCode(() => cancelRequest(member.id, org, report.id), 'REQUEST_ALREADY_RESOLVED')
    const current = await listAbsences(owner.id, org, absenceListQuery.parse({}))
    const archived = await listAbsences(owner.id, org, absenceListQuery.parse({ history: 'true' }))
    assert.ok(!current.absences.some(a => a.id === absence.id))
    assert.ok(archived.absences.some(a => a.id === absence.id))
    assert.ok(archived.absences.every(a => a.cancelledAt || a.endDate < '2050-01-01'))
  })
  it('binds day-off requests to an own future shift and validates its organization and date', async () => {
    const type = (await listRequestTypes(member.id, org)).find(t => t.systemCode === 'DAY_OFF')!
    const shift = await createShift(owner.id, org, input('2056-03-04'))
    await expectCode(() => createRequest(admin.id, org, { requestTypeId: type.id, startDate: '2056-03-04', relatedShiftId: shift.id }), 'SHIFT_NOT_FOUND')
    await expectCode(() => createRequest(member.id, org, { requestTypeId: type.id, startDate: '2056-03-05', relatedShiftId: shift.id }), 'DAY_OFF_SHIFT_DATE')
    const request = await createRequest(member.id, org, { requestTypeId: type.id, startDate: '2056-03-04', relatedShiftId: shift.id })
    assert.equal(request.status, 'PENDING')
    assert.equal(request.relatedShiftId, shift.id)
    assert.equal(request.proposedStartAt, null)
    await resolveRequest(owner.id, org, request.id, 'APPROVED', null)
    assert.ok(await prisma.employeeAbsence.findUnique({ where: { sourceRequestId: request.id } }))
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'SCHEDULED')
  })

  it('returns uploaded avatars in shifts and statistics and separates completed and cancelled history', async () => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#555' } }).png().toBuffer()
    const avatar = await replaceUserAvatar(member.id, image)
    try {
      const past = await createShift(owner.id, org, input('2020-03-04'))
      const future = await createShift(owner.id, org, input('2054-03-04'))
      const cancelled = await createShift(owner.id, org, input('2054-03-05'))
      await cancelShift(owner.id, org, cancelled.id, 'Проверка истории')
      assert.equal(past.memberAvatarUrl, avatar)
      assert.equal((await listSchedule(member.id, org, '2020-03-01', '2020-04-01', 'current')).shifts.length, 1)
      await expectCode(() => listSchedule(member.id, org, '2020-03-01', '2020-04-01', 'history'), 'INSUFFICIENT_PERMISSIONS')
      assert.equal((await listSchedule(owner.id, org, '2020-03-01', '2020-04-01', 'history')).shifts.length, 0)
      const current = await listSchedule(member.id, org, '2054-03-01', '2054-04-01', 'current')
      assert.ok(current.shifts.some(shift => shift.id === future.id && shift.memberAvatarUrl === avatar))
      const history = await listSchedule(admin.id, org, '2054-03-01', '2054-04-01', 'history')
      assert.ok(history.shifts.some(shift => shift.id === cancelled.id && shift.status === 'CANCELLED'))
      assert.ok(!history.shifts.some(shift => shift.id === future.id))
      const statistics = await organizationStatistics(owner.id, org, { memberState: 'active', sort: 'name', direction: 'asc', page: 1, limit: 50 })
      assert.equal(statistics.members.find(row => row.userId === member.id)?.avatarUrl, avatar)
      assert.equal((await memberStatistics(member.id, org, employee, { memberState: 'all', sort: 'name', direction: 'asc', page: 1, limit: 20 })).member.avatarUrl, avatar)
    } finally { await removeUserAvatar(member.id); await cleanupPendingFiles() }
  })

  it('serializes overlapping reports and preserves history for former employees', async () => {
    const results = await Promise.allSettled([reportSickness(member.id, org, { startDate: '2052-07-01', endDate: '2052-07-03' }), reportSickness(member.id, org, { startDate: '2052-07-02', endDate: '2052-07-04' })])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const winningReport = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof reportSickness>>>
    const activeAbsence = await prisma.employeeAbsence.findUniqueOrThrow({ where: { id: winningReport.value.id } })
    await changeAbsence(member.id, org, activeAbsence.id, { updatedAt: activeAbsence.updatedAt.toISOString(), reason: 'Проверка архива' })
    const types = await listRequestTypes(member.id, org)
    const pending = await createRequest(member.id, org, { requestTypeId: types.find(t => t.systemCode === 'DAY_OFF')!.id, startDate: '2052-08-01' })
    await removeMember(owner.id, org, employee)
    await expectCode(() => resolveRequest(owner.id, org, pending.id, 'APPROVED', null), 'REQUEST_ALREADY_RESOLVED')
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: pending.id } })).status, 'CANCELLED')
    const history = await listAbsences(owner.id, org, absenceListQuery.parse({ history: 'true', memberId: employee }))
    assert.ok(history.absences.length); assert.ok(history.absences.every(a => a.formerMember))
    await expectCode(() => listAbsences(member.id, org, absenceListQuery.parse({ history: 'true' })), 'ORGANIZATION_NOT_FOUND')
  })
})

describe('documents: privacy, immutable storage and acknowledgement lifecycle', { concurrency: false }, () => {
  let org: string, otherOrg: string, employee: string, administrator: string, otherEmployee: string, root: string, nested: string
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF')
  const metadata = (visibility: 'ORGANIZATION' | 'ADMINS' | 'PRIVATE_MEMBER' = 'ORGANIZATION', targetMemberId: string | null = null) => ({ displayName: 'Правила работы', visibility, targetMemberId, folderId: root })
  before(async () => {
    org = (await createOrganization(owner.id, { name: 'Documents', description: null, timezone: 'Europe/Moscow' })).id
    otherOrg = (await createOrganization(owner.id, { name: 'Other documents', description: null, timezone: 'Europe/Moscow' })).id
    employee = (await prisma.organizationMember.create({ data: { organizationId: org, userId: member.id } })).id
    administrator = (await prisma.organizationMember.create({ data: { organizationId: org, userId: admin.id, role: 'ADMIN' } })).id
    otherEmployee = (await prisma.organizationMember.create({ data: { organizationId: otherOrg, userId: member.id } })).id
    root = (await documentsService.saveFolder(owner.id, org, undefined, { name: 'Правила', parentId: null })).id
    nested = (await documentsService.saveFolder(owner.id, org, undefined, { name: 'Вложенная', parentId: root })).id
  })
  it('creates removable starter folders and files private uploads under the employee in the right organization', async () => {
    const folderOrg = (await createOrganization(owner.id, { name: 'Folder defaults', description: null, timezone: 'Europe/Moscow' })).id
    const target = (await prisma.organizationMember.create({ data: { organizationId: folderOrg, userId: member.id } })).id
    const before = await documentsService.listDocuments(owner.id, folderOrg, documentListSchema.parse({}))
    assert.ok(before.folders.some(folder => folder.name === 'Главная' && !folder.parentId))
    assert.ok(before.folders.some(folder => folder.name === 'Документы сотрудников' && !folder.parentId))
    const uploaded = await documentsService.uploadDocument(owner.id, folderOrg, pdf, 'application/pdf', 'contract.pdf', { ...metadata('PRIVATE_MEMBER', target), folderId: null })
    const saved = await prisma.document.findUniqueOrThrow({ where: { id: uploaded.id }, include: { folder: { include: { parent: true } } } })
    assert.equal(saved.folder?.parent?.name, 'Документы сотрудников')
    assert.equal(saved.folder?.organizationId, folderOrg)
    assert.ok(saved.folder?.name)
    const scoped = await documentsService.personalDocuments(member.id, 1, '', folderOrg)
    assert.deepEqual(scoped.documents.map(document => document.id), [uploaded.id])
    assert.deepEqual((await documentsService.listDocuments(member.id, folderOrg, documentListSchema.parse({ scope: 'mine' }))).documents.map(document => document.id), [uploaded.id])
    assert.equal((await documentsService.listDocuments(owner.id, folderOrg, documentListSchema.parse({ scope: 'mine' }))).pagination.total, 0)
    assert.ok(!(await documentsService.personalDocuments(member.id, 1, '', org)).documents.some(document => document.id === uploaded.id))
    const emptyStarter = before.folders.find(folder => folder.name === 'Главная')!
    await documentsService.deleteFolder(owner.id, folderOrg, emptyStarter.id)
    assert.ok(!(await documentsService.listDocuments(owner.id, folderOrg, documentListSchema.parse({}))).folders.some(folder => folder.id === emptyStarter.id))
  })
  it('pins folders per user without exposing private or foreign folders', async () => {
    const pinOrg = (await createOrganization(owner.id, { name: 'Pinned folders', description: null, timezone: 'Europe/Moscow' })).id
    await prisma.organizationMember.create({ data: { organizationId: pinOrg, userId: member.id } })
    const publicFolder = (await documentsService.saveFolder(owner.id, pinOrg, undefined, { name: 'Public', parentId: null })).id
    const privateFolder = (await documentsService.saveFolder(owner.id, pinOrg, undefined, { name: 'Private', parentId: null })).id
    await documentsService.uploadDocument(owner.id, pinOrg, pdf, 'application/pdf', 'public.pdf', { ...metadata(), folderId: publicFolder })
    await documentsService.uploadDocument(owner.id, pinOrg, pdf, 'application/pdf', 'private.pdf', { ...metadata('ADMINS'), folderId: privateFolder })
    await documentsService.setFolderPinned(owner.id, pinOrg, publicFolder, true)
    assert.equal((await documentsService.listDocuments(owner.id, pinOrg, documentListSchema.parse({}))).folders.find(folder => folder.id === publicFolder)?.pinned, true)
    assert.equal((await documentsService.listDocuments(member.id, pinOrg, documentListSchema.parse({}))).folders.find(folder => folder.id === publicFolder)?.pinned, false)
    await documentsService.setFolderPinned(member.id, pinOrg, publicFolder, true)
    assert.equal((await documentsService.listDocuments(member.id, pinOrg, documentListSchema.parse({}))).folders.find(folder => folder.id === publicFolder)?.pinned, true)
    await expectCode(() => documentsService.setFolderPinned(member.id, pinOrg, privateFolder, true), 'FOLDER_NOT_FOUND')
    await expectCode(() => documentsService.setFolderPinned(member.id, pinOrg, root, true), 'FOLDER_NOT_FOUND')
    await documentsService.setFolderPinned(member.id, pinOrg, publicFolder, false)
    assert.equal((await documentsService.listDocuments(member.id, pinOrg, documentListSchema.parse({}))).folders.find(folder => folder.id === publicFolder)?.pinned, false)
  })
  it('retains acknowledged documents in the employee acknowledgement history', async () => {
    const historyOrg = (await createOrganization(owner.id, { name: 'Acknowledgement history', description: null, timezone: 'Europe/Moscow' })).id
    const recipient = (await prisma.organizationMember.create({ data: { organizationId: historyOrg, userId: member.id } })).id
    const document = await documentsService.uploadDocument(owner.id, historyOrg, pdf, 'application/pdf', 'history.pdf', { ...metadata(), folderId: null })
    await documentsService.assignAcknowledgements(owner.id, historyOrg, document.id, assignmentSchema.parse({ recipients: 'members', memberIds: [recipient] }))
    assert.equal((await documentsService.listDocuments(member.id, historyOrg, documentListSchema.parse({ scope: 'required' }))).pagination.total, 1)
    assert.equal((await documentsService.listDocuments(member.id, historyOrg, documentListSchema.parse({ scope: 'acknowledgements' }))).pagination.total, 1)
    await documentsService.acknowledgeDocument(member.id, historyOrg, document.id)
    assert.equal((await documentsService.listDocuments(member.id, historyOrg, documentListSchema.parse({ scope: 'required' }))).pagination.total, 0)
    const history = await documentsService.listDocuments(member.id, historyOrg, documentListSchema.parse({ scope: 'acknowledgements' }))
    assert.equal(history.pagination.total, 1)
    assert.equal(history.documents[0].acknowledgement?.state, 'ACKNOWLEDGED')
  })
  it('allows changing visibility of an existing document inside a folder', async () => {
    const accessOrg = (await createOrganization(owner.id, { name: 'Folder access', description: null, timezone: 'Europe/Moscow' })).id
    await prisma.organizationMember.create({ data: { organizationId: accessOrg, userId: member.id } })
    const folder = (await documentsService.saveFolder(owner.id, accessOrg, undefined, { name: 'Archive', parentId: null })).id
    const data = { displayName: 'Правила доступа', folderId: folder, visibility: 'ORGANIZATION' as const, targetMemberId: null }
    const document = await documentsService.uploadDocument(owner.id, accessOrg, pdf, 'application/pdf', 'access.pdf', data)
    assert.equal((await documentsService.listDocuments(member.id, accessOrg, documentListSchema.parse({ folderId: folder }))).pagination.total, 1)
    await documentsService.updateDocument(owner.id, accessOrg, document.id, { ...data, visibility: 'ADMINS' })
    assert.equal((await documentsService.listDocuments(member.id, accessOrg, documentListSchema.parse({ folderId: folder }))).pagination.total, 0)
    await documentsService.updateDocument(owner.id, accessOrg, document.id, data)
    assert.equal((await documentsService.listDocuments(member.id, accessOrg, documentListSchema.parse({ folderId: folder }))).pagination.total, 1)
  })
  it('checks organization and visibility on lists, details, byte delivery and progress without leaking storage keys', async () => {
    const publicDoc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'policy.pdf', metadata())
    const adminDoc = await documentsService.uploadDocument(admin.id, org, pdf, 'application/pdf', 'admin.pdf', metadata('ADMINS'))
    const privateDoc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', encodeURIComponent('Договор.pdf'), metadata('PRIVATE_MEMBER', employee))
    const otherPrivate = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'other.pdf', metadata('PRIVATE_MEMBER', administrator))
    await expectCode(() => documentsService.getDocument(member.id, org, adminDoc.id), 'DOCUMENT_NOT_FOUND')
    await expectCode(() => documentsService.getDocument(member.id, org, otherPrivate.id), 'DOCUMENT_NOT_FOUND')
    await expectCode(() => documentsService.getDocument(owner.id, otherOrg, publicDoc.id), 'DOCUMENT_NOT_FOUND')
    await expectCode(() => documentsService.deliverDocument(member.id, otherOrg, publicDoc.id, 'download'), 'DOCUMENT_NOT_FOUND')
    await expectCode(() => documentsService.deliverDocument(outsider.id, org, publicDoc.id, 'download'), 'DOCUMENT_NOT_FOUND')
    await expectCode(() => documentsService.documentProgress(member.id, org, publicDoc.id), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => documentsService.uploadDocument(member.id, org, pdf, 'application/pdf', 'policy.pdf', metadata()), 'INSUFFICIENT_PERMISSIONS')
    const workspace = await documentsService.listDocuments(member.id, org, documentListSchema.parse({ folderId: root }))
    assert.deepEqual(workspace.documents.map(item => item.id), [publicDoc.id])
    assert.equal(workspace.folders.find(folder => folder.id === root)?.documentCount, 1)
    assert.ok(workspace.uploadMaxBytes > 0)
    const filtered = await documentsService.listDocuments(member.id, org, documentListSchema.parse({ folderId: root, fileType: 'image' }))
    assert.equal(filtered.pagination.total, 0)
    const search = await documentsService.listDocuments(member.id, org, documentListSchema.parse({ search: 'Правила', sort: 'name' }))
    assert.deepEqual(search.documents.map(item => item.id), [publicDoc.id])
    assert.equal(search.folders.find(folder => folder.id === root)?.documentCount, 1)
    const personal = await documentsService.personalDocuments(member.id)
    assert.ok(personal.documents.some(item => item.id === privateDoc.id)); assert.ok(!personal.documents.some(item => item.id === otherPrivate.id))
    const detail = await documentsService.getDocument(member.id, org, privateDoc.id)
    assert.equal(JSON.stringify(detail).includes('objectKey'), false)
    assert.equal(JSON.stringify(detail).includes('storedFileId'), false)
    assert.equal('progress' in detail, false)
    const stream = await documentsService.deliverDocument(member.id, org, privateDoc.id, 'download'); const parts: Buffer[] = []
    for await (const part of stream.stream) parts.push(Buffer.from(part)); assert.deepEqual(Buffer.concat(parts), pdf)
    const confidential = (await documentsService.saveFolder(owner.id, org, undefined, { name: 'Confidential', parentId: null })).id
    await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'secret.pdf', { ...metadata('ADMINS'), folderId: confidential })
    const nestedDoc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'nested.pdf', { ...metadata(), folderId: nested })
    const counted = await documentsService.listDocuments(member.id, org, documentListSchema.parse({ folderId: root }))
    assert.equal(counted.folders.find(folder => folder.id === root)?.documentCount, 2)
    assert.equal(counted.folders.find(folder => folder.id === nested)?.documentCount, 1)
    await documentsService.deleteDocument(owner.id, org, nestedDoc.id)
    assert.equal((await documentsService.listDocuments(member.id, org, documentListSchema.parse({}))).folders.find(folder => folder.id === root)?.documentCount, 1)
    assert.ok(workspace.folders.some(folder => folder.id === nested))
    assert.ok((await documentsService.listDocuments(member.id, org, documentListSchema.parse({}))).folders.some(folder => folder.id === confidential))
  })
  it('snapshots recipients, separates notification read/open/ack, and rejects duplicate or inaccessible assignments', async () => {
    const doc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'ack.pdf', metadata())
    await documentsService.assignAcknowledgements(owner.id, org, doc.id, assignmentSchema.parse({ recipients: 'roles', roles: ['MEMBER'], deadline: '2026-09-27', comment: 'Прочитайте правила' }))
    const newUser = await prisma.user.create({ data: { email: email('new-document-member'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    await prisma.organizationMember.create({ data: { organizationId: org, userId: newUser.id } })
    assert.equal(await prisma.documentAcknowledgement.count({ where: { documentId: doc.id } }), 1)
    const notification = await prisma.accountNotification.findFirstOrThrow({ where: { documentId: doc.id } })
    await readHistoryNotification(member.id, member.email, `event:${notification.id}`, false, org)
    const unread = await listNotificationHistory(member.id, member.email, { limit: 30, unread: true, organizationId: org })
    assert.ok(!unread.notifications.find(item => item.documentId === doc.id))
    assert.equal(unread.unreadCount, 0); assert.equal(unread.actionableCount, 0)
    assert.equal((await listNotificationHistory(member.id, member.email, { limit: 30, organizationId: org })).actionableCount, 1)
    assert.equal((await documentsService.listDocuments(member.id, org, documentListSchema.parse({ scope: 'required' }))).pagination.total, 1)
    await readHistoryNotification(member.id, member.email, `event:${notification.id}`, true, org)
    await updateAllNotifications(member.id, member.email, { organizationId: org })
    assert.equal((await listNotificationHistory(member.id, member.email, { limit: 30, unread: true, organizationId: org })).unreadCount, 0)
    assert.equal((await documentsService.listDocuments(member.id, org, documentListSchema.parse({ scope: 'required' }))).pagination.total, 1)
    await expectCode(() => updateAllNotifications(member.id, member.email, { organizationId: org }, `event:${notification.id}`), 'ACTION_REQUIRED')
    await documentsService.getDocument(member.id, org, doc.id)
    // Opening the document detail is enough; acknowledgement remains an explicit action.
    await documentsService.acknowledgeDocument(member.id, org, doc.id)
    await expectCode(() => documentsService.acknowledgeDocument(member.id, org, doc.id), 'ALREADY_ACKNOWLEDGED')
    await expectCode(() => documentsService.assignAcknowledgements(owner.id, org, doc.id, assignmentSchema.parse({ recipients: 'members', memberIds: [employee] })), 'ALREADY_ASSIGNED')
    assert.equal((await listNotificationHistory(member.id, member.email, { limit: 30, unread: true, organizationId: org })).actionableCount, 0)
    const adminDoc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'admins.pdf', metadata('ADMINS'))
    await expectCode(() => documentsService.assignAcknowledgements(owner.id, org, adminDoc.id, assignmentSchema.parse({ recipients: 'members', memberIds: [employee] })), 'RECIPIENT_ACCESS_DENIED')
    await expectCode(() => documentsService.assignAcknowledgements(owner.id, org, doc.id, assignmentSchema.parse({ recipients: 'members', memberIds: [otherEmployee] })), 'INVALID_RECIPIENTS')
  })
  it('retains cancellation and deletion history, checks access-change conflicts and preserves bytes', async () => {
    const doc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'retained.pdf', metadata())
    await documentsService.assignAcknowledgements(owner.id, org, doc.id, assignmentSchema.parse({ recipients: 'members', memberIds: [employee, administrator] }))
    await expectCode(() => documentsService.updateDocument(owner.id, org, doc.id, metadata('ADMINS')), 'ACKNOWLEDGEMENT_ACCESS_CONFLICT')
    const requirement = await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId_memberId: { documentId: doc.id, memberId: employee } } })
    await documentsService.cancelAcknowledgement(owner.id, org, doc.id, requirement.id)
    await expectCode(() => documentsService.acknowledgeDocument(member.id, org, doc.id), 'ACKNOWLEDGEMENT_NOT_ACTIVE')
    await documentsService.updateDocument(owner.id, org, doc.id, metadata('ADMINS'))
    await documentsService.recordDocumentOpened(admin.id, org, doc.id); await documentsService.acknowledgeDocument(admin.id, org, doc.id)
    await documentsService.deleteDocument(owner.id, org, doc.id)
    await expectCode(() => documentsService.getDocument(member.id, org, doc.id), 'DOCUMENT_NOT_FOUND')
    await expectCode(() => documentsService.deliverDocument(member.id, org, doc.id, 'download'), 'DOCUMENT_NOT_FOUND')
    assert.equal((await documentsService.documentProgress(owner.id, org, doc.id)).recipients.length, 2)
    assert.ok((await documentsService.getDocument(owner.id, org, doc.id)).deletedAt)
    const stream = await documentsService.deliverDocument(owner.id, org, doc.id, 'download'); for await (const _ of stream.stream) { /* drain */ }
    const record = await prisma.document.findUniqueOrThrow({ where: { id: doc.id }, include: { storedFile: true } }); assert.equal(record.storedFile.pendingDeletionAt, null)
    assert.ok((await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId_memberId: { documentId: doc.id, memberId: administrator } } })).acknowledgedAt)
    const pending = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'pending.pdf', metadata())
    await documentsService.assignAcknowledgements(owner.id, org, pending.id, assignmentSchema.parse({ recipients: 'members', memberIds: [employee] }))
    await documentsService.deleteDocument(owner.id, org, pending.id)
    assert.ok((await prisma.documentAcknowledgement.findFirstOrThrow({ where: { documentId: pending.id } })).cancelledAt)
  })
  it('serves protected bytes only on explicit POST, marks successful delivery and refuses anonymous, foreign and static access', async () => {
    const { default: express } = await import('express')
    const { default: router } = await import('../src/server/documents/routes.ts')
    const { default: media } = await import('../src/server/storage/routes.ts')
    const { SignJWT } = await import('jose')
    const user = await prisma.user.create({ data: { email: email('http-document'), passwordHash: 'test-only', emailVerifiedAt: new Date() } })
    const recipient = await prisma.organizationMember.create({ data: { organizationId: org, userId: user.id } })
    const doc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', encodeURIComponent('Приказ №1.pdf'), metadata('PRIVATE_MEMBER', recipient.id))
    await documentsService.assignAcknowledgements(owner.id, org, doc.id, assignmentSchema.parse({ recipients: 'members', memberIds: [recipient.id] }))
    const session = await prisma.authSession.create({ data: { userId: user.id, refreshTokenHash: randomUUID(), idleExpiresAt: new Date(Date.now() + 60000), absoluteExpiresAt: new Date(Date.now() + 60000) } })
    const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET!))
    const app = express(); app.use(express.json()); app.use('/api', router, media)
    app.use((_req, res) => res.status(404).end())
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ code: error.code }))
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const path = `/api/organizations/${org}/documents/${doc.id}`
    const headers = { Authorization: `Bearer ${token}` }
    try {
      assert.equal((await fetch(`${base}${path}/content?action=download`, { method: 'POST' })).status, 401)
      assert.equal((await fetch(`${base}${path}`, { headers })).status, 200)
      assert.equal((await fetch(`${base}${path}/content?action=preview`, { headers })).status, 404)
      assert.equal((await fetch(`${base}${path}/content?action=preview`, { method: 'HEAD', headers })).status, 404)
      assert.equal((await prisma.documentAcknowledgement.findFirstOrThrow({ where: { documentId: doc.id } })).openedAt, null)
      assert.equal((await fetch(`${base}/api/organizations/${otherOrg}/documents/${doc.id}/content?action=download`, { method: 'POST', headers })).status, 404)
      const binding = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
      assert.equal((await fetch(`${base}/api/media/${binding.storedFileId}`, { headers })).status, 404)
      const result = await fetch(`${base}${path}/content?action=preview`, { method: 'POST', headers })
      assert.equal(result.status, 200); assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
      assert.ok(result.headers.get('content-disposition')?.startsWith('inline;'))
      assert.ok(result.headers.get('content-disposition')?.includes("filename*=UTF-8''"))
      assert.ok(result.headers.get('cache-control')?.includes('no-store'))
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), pdf)
      let opened = false
      for (let attempt = 0; attempt < 20; attempt++) {
        const detail = await fetch(`${base}${path}`, { headers }).then(result => result.json())
        if (detail.document.acknowledgement.openedAt) { opened = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.ok(opened, 'Successful streaming must eventually commit openedAt')
      assert.equal((await fetch(`${base}${path}/acknowledge`, { method: 'POST', headers })).status, 204)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
  it('cancels unfinished requirements when a role change removes document access', async () => {
    const doc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'admin-role.pdf', metadata('ADMINS'))
    await documentsService.assignAcknowledgements(owner.id, org, doc.id, assignmentSchema.parse({ recipients: 'members', memberIds: [administrator] }))
    await changeMemberRole(owner.id, org, administrator, 'MEMBER')
    await expectCode(() => documentsService.getDocument(admin.id, org, doc.id), 'DOCUMENT_NOT_FOUND')
    assert.ok((await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId_memberId: { documentId: doc.id, memberId: administrator } } })).cancelledAt)
    assert.ok(!(await listNotificationHistory(admin.id, admin.email, { limit: 30, organizationId: org })).notifications.some(item => item.documentId === doc.id))
    await expectCode(() => documentsService.uploadDocument(admin.id, org, pdf, 'application/pdf', 'admin-upload.pdf', metadata()), 'INSUFFICIENT_PERMISSIONS')
  })
  it('guards folder cycles, cross-organization moves, nonempty deletion and former-member history', async () => {
    await expectCode(() => documentsService.saveFolder(owner.id, org, root, { name: 'Cycle', parentId: nested }), 'FOLDER_CYCLE')
    await expectCode(() => documentsService.saveFolder(owner.id, org, root, { name: 'Self', parentId: root }), 'FOLDER_CYCLE')
    const foreign = await documentsService.saveFolder(owner.id, otherOrg, undefined, { name: 'Foreign', parentId: null })
    await expectCode(() => documentsService.saveFolder(owner.id, org, root, { name: 'Cross', parentId: foreign.id }), 'FOLDER_NOT_FOUND')
    await expectCode(() => documentsService.deleteFolder(owner.id, org, root), 'FOLDER_NOT_EMPTY')
    const privateDoc = await documentsService.uploadDocument(owner.id, org, pdf, 'application/pdf', 'former.pdf', metadata('PRIVATE_MEMBER', employee))
    await expectCode(() => documentsService.updateDocument(owner.id, org, privateDoc.id, { ...metadata('PRIVATE_MEMBER', employee), folderId: foreign.id }), 'FOLDER_NOT_FOUND')
    await removeMember(owner.id, org, employee)
    assert.equal((await documentsService.getDocument(owner.id, org, privateDoc.id)).targetMember?.former, true)
    assert.ok(!(await documentsService.personalDocuments(member.id)).documents.some(doc => doc.id === privateDoc.id))
    await expectCode(() => documentsService.getDocument(member.id, org, privateDoc.id), 'DOCUMENT_NOT_FOUND')
    const empty = await documentsService.saveFolder(owner.id, org, undefined, { name: 'Empty', parentId: null })
    await documentsService.deleteFolder(owner.id, org, empty.id)
  })
  it('treats date-only deadlines as the end of the organization day including DST', () => {
    const ack = { cancelledAt: null, acknowledgedAt: null, openedAt: null, deadline: new Date('2026-09-27') }
    assert.equal(documentsService.acknowledgementState(ack, 'Europe/Moscow', new Date('2026-09-27T20:59:59.999Z')).overdue, false)
    assert.equal(documentsService.acknowledgementState(ack, 'Europe/Moscow', new Date('2026-09-27T21:00:00Z')).overdue, true)
    const autumn = { ...ack, deadline: new Date('2026-11-01') }
    assert.equal(documentsService.acknowledgementState(autumn, 'America/New_York', new Date('2026-11-02T04:59:59Z')).overdue, false)
    assert.equal(documentsService.acknowledgementState(autumn, 'America/New_York', new Date('2026-11-02T05:00:00Z')).overdue, true)
  })
})

// Multi-location regressions exercise the same request scope used by the API.
import { locationContext } from '../src/server/organizations/location-context.ts'
import { requestLocationClosure, locationOverview, archiveLocation, assignLocationMember, deleteTeam, listLocations, listTeams, removeLocationMember, saveLocation, saveTeam, transferMember } from '../src/server/organizations/location-service.ts'
import { createOrganizationBody } from '../src/server/organizations/schemas.ts'
async function locationFixture() {
  const organization = await createOrganization(owner.id, { name: 'Сеть кофеен', description: null, timezone: 'Europe/Moscow', firstLocation: { name: 'На Пушкина', city: 'Москва', address: 'Пушкина, 10', timezone: 'Europe/Moscow', teamNames: ['Утренняя команда'] } })
  const first = organization.locations[0]
  const second = await saveLocation(owner.id, organization.id, null, { name: 'На Ленина', city: 'Москва', address: 'Ленина, 20', timezone: 'Europe/Moscow', teamNames: [] })
  const manager = await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: admin.id } })
  const employee = await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: member.id } })
  await assignLocationMember(owner.id, organization.id, first.id, manager.id, 'ADMIN')
  await assignLocationMember(owner.id, organization.id, first.id, employee.id, 'MEMBER')
  return { organizationId: organization.id, first, second, manager, employee }
}
function atPoint<T>(f: { organizationId: string }, locationId: string, run: () => T) { return locationContext.run({ organizationId: f.organizationId, locationId }, run) }
const pointShift = (memberId: string, date = '2060-05-02', startTime = '09:00', endTime = '18:00') => ({ memberId, startDate: date, endDate: date, startTime, endTime, breakMinutes: 0, description: null })
describe('locations, teams and point authorization', { concurrency: false }, () => {
  it('lists cancelled shifts across months with pagination, reasons and point permissions', async () => {
    const f = await locationFixture()
    const a = await atPoint(f, f.first.id, () => createShift(admin.id, f.organizationId, pointShift(f.employee.id, '2065-01-02')))
    const b = await atPoint(f, f.first.id, () => createShift(admin.id, f.organizationId, pointShift(f.employee.id, '2065-06-02')))
    await atPoint(f, f.first.id, () => cancelShift(admin.id, f.organizationId, a.id, 'Отмена первой смены'))
    await atPoint(f, f.first.id, () => cancelShift(admin.id, f.organizationId, b.id, 'Отмена второй смены'))
    const first = await atPoint(f, f.first.id, () => listCancelledShifts(admin.id, f.organizationId, { page: 1, limit: 1, order: 'asc', memberId: f.employee.id }))
    const second = await atPoint(f, f.first.id, () => listCancelledShifts(admin.id, f.organizationId, { page: 2, limit: 1, order: 'asc' }))
    assert.equal(first.pagination.total, 2)
    assert.equal(first.pagination.pages, 2)
    assert.equal(first.shifts[0].id, a.id)
    assert.equal(second.shifts[0].id, b.id)
    assert.equal(first.shifts[0].cancellationReason, 'Отмена первой смены')
    const newest = await atPoint(f, f.first.id, () => listCancelledShifts(admin.id, f.organizationId, { page: 1, limit: 20, order: 'desc' }))
    assert.equal(newest.shifts[0].id, b.id)
    const other = await atPoint(f, f.second.id, () => listCancelledShifts(owner.id, f.organizationId, { page: 1, limit: 20, order: 'desc' }))
    assert.equal(other.pagination.total, 0)
    await expectCode(() => atPoint(f, f.second.id, () => listCancelledShifts(admin.id, f.organizationId, { page: 1, limit: 20, order: 'desc' })), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => atPoint(f, f.first.id, () => listCancelledShifts(member.id, f.organizationId, { page: 1, limit: 20, order: 'desc' })), 'INSUFFICIENT_PERMISSIONS')
  })
  it('requires first-point data at creation and creates named teams atomically', async () => {
    assert.equal(createOrganizationBody.safeParse({ name: 'Кофейня', timezone: 'Europe/Moscow' }).success, false)
    const f = await locationFixture()
    const locations = await listLocations(owner.id, f.organizationId)
    assert.equal(locations.length, 2)
    assert.equal(locations[0].address, 'Пушкина, 10')
    assert.equal((await atPoint(f, f.first.id, () => listTeams(member.id, f.organizationId)))[0].name, 'Утренняя команда')
  })
  it('shows everyone the point calendar and directory but grants ADMIN only at assigned points', async () => {
    const f = await locationFixture()
    const first = await atPoint(f, f.first.id, () => getOrganization(admin.id, f.organizationId))
    const second = await atPoint(f, f.second.id, () => getOrganization(admin.id, f.organizationId))
    assert.equal(first.role, 'ADMIN'); assert.equal(second.role, 'MEMBER')
    const shift = await atPoint(f, f.first.id, () => createShift(admin.id, f.organizationId, pointShift(f.employee.id)))
    assert.equal((await atPoint(f, f.first.id, () => listSchedule(member.id, f.organizationId, '2060-05-01', '2060-06-01'))).shifts[0].id, shift.id)
    assert.equal((await atPoint(f, f.second.id, () => listSchedule(member.id, f.organizationId, '2060-05-01', '2060-06-01'))).shifts.length, 0)
    await expectCode(() => atPoint(f, f.second.id, () => cancelShift(admin.id, f.organizationId, shift.id, 'Чужая точка')), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => atPoint(f, f.second.id, () => cancelShift(owner.id, f.organizationId, shift.id, 'Неверная область')), 'SHIFT_NOT_FOUND')
    assert.equal((await atPoint(f, f.first.id, () => listMembersPage(member.id, f.organizationId, { role: 'ADMIN' }))).members[0].id, f.manager.id)
    assert.equal((await atPoint(f, f.second.id, () => listMembersPage(member.id, f.organizationId, {}))).members.some(m => m.id === f.employee.id), false)
    await expectCode(() => atPoint(f, f.first.id, () => saveLocation(admin.id, f.organizationId, null, { name: 'Новая', city: 'Москва', address: 'Адрес 10', timezone: 'Europe/Moscow', teamNames: [] })), 'INSUFFICIENT_PERMISSIONS')
    await expectCode(() => assignLocationMember(admin.id, f.organizationId, f.first.id, f.employee.id, 'ADMIN'), 'OWNER_REQUIRED')
  })
  it('validates HTTP point selection and applies local permissions through router dispatch', async () => {
    const f = await locationFixture()
    const { default: express } = await import('express')
    const { default: router } = await import('../src/server/organizations/routes.ts')
    const { requireAuth } = await import('../src/server/auth.ts')
    const { selectLocation } = await import('../src/server/organizations/location-context.ts')
    const { SignJWT } = await import('jose')
    const session = await prisma.authSession.create({ data: { userId: admin.id, refreshTokenHash: randomUUID(), idleExpiresAt: new Date(Date.now() + 60000), absoluteExpiresAt: new Date(Date.now() + 60000) } })
    const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(admin.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET!))
    const app = express(); app.use(express.json()); app.use('/api/organizations/:organizationId', requireAuth, selectLocation); app.use('/api', router)
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ code: error.code }))
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/organizations/${f.organizationId}`
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    try {
      assert.equal((await fetch(base)).status, 401)
      assert.equal((await fetch(`${base}?locationId=invalid`, { headers })).status, 400)
      assert.equal((await fetch(`${base}?locationId=${randomUUID()}`, { headers })).status, 404)
      assert.equal((await fetch(`${base}?locationId=${f.first.id}`, { headers }).then(r => r.json())).organization.role, 'ADMIN')
      assert.equal((await fetch(`${base}?locationId=${f.second.id}`, { headers }).then(r => r.json())).organization.role, 'MEMBER')
      const result = await fetch(`${base}/teams?locationId=${f.second.id}`, { method: 'POST', headers, body: JSON.stringify({ name: 'Чужая команда', memberIds: [] }) })
      assert.equal(result.status, 403)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
  it('keeps teams local and refuses foreign employees, cross-point IDs and MEMBER writes', async () => {
    const f = await locationFixture()
    const team = await atPoint(f, f.first.id, () => saveTeam(admin.id, f.organizationId, null, { name: 'Вечерняя команда', memberIds: [f.employee.id] }))
    assert.equal((await atPoint(f, f.second.id, () => listTeams(member.id, f.organizationId))).length, 0)
    await expectCode(() => atPoint(f, f.second.id, () => saveTeam(owner.id, f.organizationId, team.id, { name: 'Чужая', memberIds: [] })), 'TEAM_NOT_FOUND')
    await expectCode(() => atPoint(f, f.second.id, () => saveTeam(owner.id, f.organizationId, null, { name: 'Команда', memberIds: [f.employee.id] })), 'TEAM_MEMBERS_INVALID')
    await expectCode(() => atPoint(f, f.first.id, () => deleteTeam(member.id, f.organizationId, team.id)), 'INSUFFICIENT_PERMISSIONS')
    await atPoint(f, f.first.id, () => removeLocationMember(admin.id, f.organizationId, f.first.id, f.employee.id))
    assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: f.employee.id } })).leftAt, null)
    assert.equal(await prisma.locationTeamMember.count({ where: { teamId: team.id } }), 0)
  })
  it('checks overlap and workload across points while statistics use only the selected point', async () => {
    const f = await locationFixture()
    await assignLocationMember(owner.id, f.organizationId, f.second.id, f.employee.id, 'MEMBER')
    await atPoint(f, f.first.id, () => createShift(admin.id, f.organizationId, pointShift(f.employee.id)))
    await expectCode(() => atPoint(f, f.second.id, () => createShift(owner.id, f.organizationId, pointShift(f.employee.id))), 'SHIFT_OVERLAP')
    await atPoint(f, f.second.id, () => saveWorkload(owner.id, f.organizationId, 600))
    await expectCode(() => atPoint(f, f.second.id, () => createShift(owner.id, f.organizationId, pointShift(f.employee.id, '2060-05-03'))), 'WORKLOAD_WARNING')
    await atPoint(f, f.second.id, () => createShift(owner.id, f.organizationId, { ...pointShift(f.employee.id, '2060-05-03'), acknowledgeWorkload: true }))
    const options = { memberState: 'all' as const, sort: 'name' as const, direction: 'asc' as const, page: 1, limit: 50 }
    const stats = await atPoint(f, f.second.id, () => organizationStatistics(owner.id, f.organizationId, options))
    assert.equal(stats.summary.plannedMinutes, 540)
    const firstStats = await atPoint(f, f.first.id, () => organizationStatistics(owner.id, f.organizationId, options))
    assert.equal(firstStats.members.find(m => m.memberId === f.manager.id)?.role, 'ADMIN')
    await removeLocationMember(owner.id, f.organizationId, f.first.id, f.employee.id)
    const former = await atPoint(f, f.first.id, () => organizationStatistics(owner.id, f.organizationId, { ...options, memberState: 'former' }))
    assert.equal(former.members.find(m => m.memberId === f.employee.id)?.active, false)
    const active = await atPoint(f, f.first.id, () => organizationStatistics(owner.id, f.organizationId, { ...options, memberState: 'active' }))
    assert.equal(active.members.some(m => m.memberId === f.employee.id), false)
  })
  it('allows transfers only with authority at both points and bounds temporary shifts to the placement period', async () => {
    const f = await locationFixture()
    const input = { memberId: f.employee.id, fromLocationId: f.first.id, toLocationId: f.second.id, temporary: true, startAt: '2060-05-02T06:00:00Z', endAt: '2060-05-02T15:00:00Z' }
    await expectCode(() => transferMember(admin.id, f.organizationId, input), 'INSUFFICIENT_PERMISSIONS')
    await assignLocationMember(owner.id, f.organizationId, f.second.id, f.manager.id, 'ADMIN')
    await transferMember(admin.id, f.organizationId, input)
    await atPoint(f, f.second.id, () => createShift(admin.id, f.organizationId, pointShift(f.employee.id)))
    await expectCode(() => atPoint(f, f.second.id, () => createShift(admin.id, f.organizationId, pointShift(f.employee.id, '2060-05-03'))), 'MEMBER_NOT_IN_LOCATION')
  })
  it('preserves old and future shift point IDs on permanent transfer and prevents closing points with pending work', async () => {
    const f = await locationFixture()
    const past = await atPoint(f, f.first.id, () => createShift(owner.id, f.organizationId, pointShift(f.employee.id, '2020-05-02')))
    const future = await atPoint(f, f.first.id, () => createShift(owner.id, f.organizationId, pointShift(f.employee.id)))
    await transferMember(owner.id, f.organizationId, { memberId: f.employee.id, fromLocationId: f.first.id, toLocationId: f.second.id, temporary: false })
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: past.id } })).locationId, f.first.id)
    assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: future.id } })).status, 'SCHEDULED')
    await expectCode(() => requestLocationClosure(owner.id, f.organizationId, f.first.id), 'LOCATION_HAS_WORK')
    await atPoint(f, f.first.id, () => cancelShift(owner.id, f.organizationId, future.id, 'Закрытие точки'))
    const closure = await requestLocationClosure(owner.id, f.organizationId, f.first.id)
    await archiveLocation(owner.id, f.organizationId, f.first.id, closure.code)
    await expectCode(() => requestLocationClosure(owner.id, f.organizationId, f.second.id), 'LAST_LOCATION')
  })
  it('isolates incoming requests, resolutions, attachments and shared organization settings', async () => {
    const f = await locationFixture()
    const type = (await listRequestTypes(member.id, f.organizationId)).find(t => t.systemCode === 'OTHER')!
    const request = await atPoint(f, f.first.id, () => createRequest(member.id, f.organizationId, { requestTypeId: type.id, comment: 'Заявка точки А' }))
    await assignLocationMember(owner.id, f.organizationId, f.second.id, f.manager.id, 'ADMIN')
    assert.equal((await atPoint(f, f.second.id, () => listRequests(admin.id, f.organizationId, 'incoming', { page: 1, pageSize: 20 }))).requests.length, 0)
    await expectCode(() => atPoint(f, f.second.id, () => resolveRequest(admin.id, f.organizationId, request.id, 'APPROVED', null)), 'REQUEST_NOT_FOUND')
    await expectCode(() => atPoint(f, f.second.id, () => getRequest(admin.id, f.organizationId, request.id)), 'REQUEST_NOT_FOUND')
    await expectCode(() => atPoint(f, f.first.id, () => updateOrganization(admin.id, f.organizationId, { name: 'Нельзя', description: null, timezone: 'Europe/Moscow', contactEmail: null, phone: null, website: null, address: null })), 'INSUFFICIENT_PERMISSIONS')
  })
  it('separates point and shared documents on lists, direct IDs and byte delivery', async () => {
    const f = await locationFixture()
    const metadata = { displayName: 'Инструкция', folderId: null, visibility: 'ORGANIZATION' as const, targetMemberId: null, shared: false }
    const local = await atPoint(f, f.first.id, () => documentsService.uploadDocument(admin.id, f.organizationId, Buffer.from('Point document'), 'text/plain', 'instructions.txt', metadata))
    const shared = await atPoint(f, f.first.id, () => documentsService.uploadDocument(owner.id, f.organizationId, Buffer.from('Shared document'), 'text/plain', 'shared.txt', { ...metadata, shared: true }))
    const sharedAdmins = await atPoint(f, f.first.id, () => documentsService.uploadDocument(owner.id, f.organizationId, Buffer.from('Shared admin document'), 'text/plain', 'shared-admin.txt', { ...metadata, shared: true, visibility: 'ADMINS' }))
    assert.equal((await atPoint(f, f.first.id, () => documentsService.getDocument(admin.id, f.organizationId, sharedAdmins.id))).canManage, false)
    await atPoint(f, f.first.id, () => documentsService.assignAcknowledgements(owner.id, f.organizationId, sharedAdmins.id, assignmentSchema.parse({ recipients: 'roles', roles: ['ADMIN'] })))
    assert.equal((await listNotificationHistory(admin.id, admin.email, { limit: 50, organizationId: f.organizationId })).notifications.some(n => n.documentId === sharedAdmins.id), true)
    assert.equal((await atPoint(f, f.second.id, () => documentsService.getDocument(admin.id, f.organizationId, sharedAdmins.id))).canManage, false)
    const list = await atPoint(f, f.second.id, () => documentsService.listDocuments(admin.id, f.organizationId, documentListSchema.parse({})))
    assert.equal(list.documents.some(d => d.id === local.id), true)
    assert.equal(list.documents.find(d => d.id === shared.id)?.canManage, false)
    const ownPointFile = await atPoint(f, f.second.id, () => documentsService.deliverDocument(admin.id, f.organizationId, local.id, 'download')); ownPointFile.stream.destroy()
    await expectCode(() => atPoint(f, f.first.id, () => documentsService.deleteDocument(admin.id, f.organizationId, shared.id)), 'INSUFFICIENT_PERMISSIONS')
    const delivered = await atPoint(f, f.first.id, () => documentsService.deliverDocument(member.id, f.organizationId, local.id, 'download')); delivered.stream.destroy()
    await atPoint(f, f.first.id, () => documentsService.assignAcknowledgements(admin.id, f.organizationId, local.id, assignmentSchema.parse({ recipients: 'members', memberIds: [f.employee.id] })))
    const notifications = await listNotificationHistory(member.id, member.email, { limit: 50, organizationId: f.organizationId })
    assert.equal(notifications.notifications.find(n => n.documentId === local.id)?.href?.includes(`location=${f.first.id}`), true)
  })
})

describe('location workflow refinements', { concurrency: false }, () => {
  it('creates multiple points at once and filters the organization directory without unassigned people', async () => {
    const f = await locationFixture()
    await prisma.organizationMember.create({ data: { organizationId: f.organizationId, userId: outsider.id } })
    await assignLocationMember(owner.id, f.organizationId, f.second.id, f.employee.id)
    const all = await atPoint(f, f.second.id, () => listMembersPage(member.id, f.organizationId, { directory: 'true', role: 'ADMIN' }))
    assert.deepEqual(all.members.map(item => item.id), [f.manager.id])
    const second = await atPoint(f, f.first.id, () => listMembersPage(member.id, f.organizationId, { directory: 'true', pointId: f.second.id }))
    assert.equal(second.members.some(item => item.id === f.employee.id), true)
    assert.equal(second.members.some(item => item.userId === outsider.id), false)
    assert.equal(second.members.find(item => item.id === f.employee.id)?.locations.length, 2)
    const created = await createOrganization(owner.id, createOrganizationBody.parse({ name: 'Две точки сразу', timezone: 'Europe/Moscow', firstLocation: { name: 'Основная', city: 'Москва', address: 'Дом 1', timezone: 'Europe/Moscow' }, locations: [{ name: 'Вторая', city: 'Тула', address: 'Дом 2', timezone: 'Europe/Moscow' }] }))
    assert.equal(created.locations.length, 2)
  })
  it('keeps an administrator role global but grants management only at their assigned points', async () => {
    const f = await locationFixture()
    assert.equal((await atPoint(f, f.second.id, () => getOrganization(admin.id, f.organizationId))).organizationRole, 'ADMIN')
    assert.equal((await atPoint(f, f.second.id, () => getOrganization(admin.id, f.organizationId))).role, 'MEMBER')
    await assignLocationMember(owner.id, f.organizationId, f.second.id, f.manager.id)
    assert.equal((await atPoint(f, f.second.id, () => getOrganization(admin.id, f.organizationId))).role, 'ADMIN')
    await atPoint(f, f.first.id, () => changeMemberRole(owner.id, f.organizationId, f.manager.id, 'MEMBER'))
    assert.equal((await atPoint(f, f.second.id, () => getOrganization(admin.id, f.organizationId))).role, 'MEMBER')
    assert.equal((await prisma.locationMember.findMany({ where: { memberId: f.manager.id } })).every(item => item.role === 'MEMBER'), true)
    await expectCode(() => atPoint(f, f.first.id, () => changeMemberRole(admin.id, f.organizationId, f.employee.id, 'ADMIN')), 'OWNER_REQUIRED')
    await changeMemberRole(owner.id, f.organizationId, f.manager.id, 'ADMIN')
    const otherAdmin = await prisma.organizationMember.create({ data: { organizationId: f.organizationId, userId: outsider.id, role: 'ADMIN' } })
    await assignLocationMember(owner.id, f.organizationId, f.second.id, otherAdmin.id)
    await expectCode(() => assignLocationMember(admin.id, f.organizationId, f.first.id, otherAdmin.id, 'MEMBER'), 'OWNER_REQUIRED')
    assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: otherAdmin.id } })).role, 'ADMIN')

  })
  it('requires a point-bound email code, records wrong attempts and protects the last active point', async () => {
    const f = await locationFixture()
    await expectCode(() => archiveLocation(owner.id, f.organizationId, f.second.id), 'VERIFICATION_REQUIRED')
    await expectCode(() => requestLocationClosure(admin.id, f.organizationId, f.second.id), 'INSUFFICIENT_PERMISSIONS')
    const closure = await requestLocationClosure(owner.id, f.organizationId, f.second.id)
    const wrong = closure.code === '000000' ? '999999' : '000000'
    await expectCode(() => archiveLocation(owner.id, f.organizationId, f.second.id, wrong), 'INVALID_VERIFICATION_CODE')
    assert.equal((await prisma.sensitiveActionToken.findFirstOrThrow({ where: { organizationId: f.organizationId, action: 'ARCHIVE_LOCATION' } })).attempts, 1)
    await expectCode(() => archiveLocation(owner.id, f.organizationId, f.first.id, closure.code), 'INVALID_VERIFICATION_CODE')
    await archiveLocation(owner.id, f.organizationId, f.second.id, closure.code)
    await expectCode(() => requestLocationClosure(owner.id, f.organizationId, f.first.id), 'LAST_LOCATION')
  })
  it('exposes all assigned point documents, hides foreign point bytes, and inherits restricted folder access', async () => {
    const f = await locationFixture()
    const metadata = { displayName: 'Доступ точки', folderId: null, visibility: 'ORGANIZATION' as const, targetMemberId: null }
    const foreign = await atPoint(f, f.second.id, () => documentsService.uploadDocument(owner.id, f.organizationId, Buffer.from('Foreign point'), 'text/plain', 'foreign.txt', metadata))
    await expectCode(() => atPoint(f, f.second.id, () => documentsService.getDocument(member.id, f.organizationId, foreign.id)), 'DOCUMENT_NOT_FOUND')
    await expectCode(() => atPoint(f, f.second.id, () => documentsService.deliverDocument(member.id, f.organizationId, foreign.id, 'download')), 'DOCUMENT_NOT_FOUND')
    const folder = await atPoint(f, f.first.id, () => documentsService.saveFolder(admin.id, f.organizationId, undefined, { name: 'Только руководители', parentId: null, visibility: 'ADMINS' }))
    const child = await atPoint(f, f.first.id, () => documentsService.saveFolder(admin.id, f.organizationId, undefined, { name: 'Вложенная', parentId: folder.id }))
    const privateDoc = await atPoint(f, f.first.id, () => documentsService.uploadDocument(admin.id, f.organizationId, Buffer.from('Restricted folder'), 'text/plain', 'restricted.txt', { ...metadata, folderId: child.id }))
    await expectCode(() => atPoint(f, f.first.id, () => documentsService.getDocument(member.id, f.organizationId, privateDoc.id)), 'DOCUMENT_NOT_FOUND')
    await expectCode(() => atPoint(f, f.first.id, () => documentsService.assignAcknowledgements(admin.id, f.organizationId, privateDoc.id, assignmentSchema.parse({ recipients: 'members', memberIds: [f.employee.id] }))), 'RECIPIENT_ACCESS_DENIED')
    const visible = await atPoint(f, f.second.id, () => documentsService.listDocuments(member.id, f.organizationId, documentListSchema.parse({})))
    assert.equal(visible.documents.some(item => item.id === foreign.id || item.id === privateDoc.id), false)
    assert.equal(visible.folders.some(item => item.id === folder.id || item.id === child.id), false)
    await assignLocationMember(owner.id, f.organizationId, f.second.id, f.employee.id)
    assert.equal((await atPoint(f, f.first.id, () => documentsService.getDocument(member.id, f.organizationId, foreign.id))).locationId, f.second.id)
    const all = await atPoint(f, f.first.id, () => documentsService.listDocuments(owner.id, f.organizationId, documentListSchema.parse({ pointId: f.second.id })))
    assert.deepEqual(all.documents.map(item => item.id), [foreign.id])
  })
  it('confirms a staffing response using only the receiving administrator and creates placement plus shift atomically', async () => {
    const f = await locationFixture()
    await removeLocationMember(owner.id, f.organizationId, f.first.id, f.manager.id)
    await assignLocationMember(owner.id, f.organizationId, f.second.id, f.manager.id)
    const staffing = (await listRequestTypes(owner.id, f.organizationId)).find(type => type.systemCode === 'STAFFING')!
    const offer = await atPoint(f, f.second.id, () => createRequest(admin.id, f.organizationId, { requestTypeId: staffing.id, staffingPositionName: 'Бариста', proposedStartDate: '2062-05-02', proposedEndDate: '2062-05-02', proposedStartTime: '09:00', proposedEndTime: '18:00' }))
    const notifications = await listNotificationHistory(member.id, member.email, { limit: 50, organizationId: f.organizationId, locationId: f.first.id })
    assert.equal(notifications.notifications.some(item => item.requestId === offer.id && item.href?.includes('tab=staffing')), true)
    assert.equal((await atPoint(f, f.first.id, () => listRequests(member.id, f.organizationId, 'staffing', { page: 1, pageSize: 20, pointId: 'all' }))).requests[0].id, offer.id)
    assert.equal((await atPoint(f, f.first.id, () => listRequests(member.id, f.organizationId, 'staffing', { page: 1, pageSize: 20, pointId: 'all', from: '2062-05-02', to: '2062-05-02' }))).pagination.total, 1)
    assert.equal((await atPoint(f, f.first.id, () => listRequests(member.id, f.organizationId, 'staffing', { page: 1, pageSize: 20, pointId: 'all', from: '2062-05-03', to: '2062-05-03' }))).pagination.total, 0)
    const response = await atPoint(f, f.second.id, () => respondToStaffing(member.id, f.organizationId, offer.id, 'Могу выйти'))
    await expectCode(() => atPoint(f, f.second.id, () => respondToStaffing(member.id, f.organizationId, offer.id)), 'ALREADY_RESPONDED')
    await expectCode(() => atPoint(f, f.first.id, () => resolveRequest(admin.id, f.organizationId, response.id, 'APPROVED', null)), 'INSUFFICIENT_PERMISSIONS')
    await atPoint(f, f.second.id, () => resolveRequest(admin.id, f.organizationId, response.id, 'APPROVED', null))
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: offer.id } })).status, 'APPROVED')
    const shift = await prisma.workShift.findFirstOrThrow({ where: { organizationId: f.organizationId, memberId: f.employee.id } })
    assert.equal(shift.locationId, f.second.id); assert.equal(shift.positionNameSnapshot, 'Бариста')
    assert.equal(await prisma.locationTransfer.count({ where: { organizationId: f.organizationId, memberId: f.employee.id, toLocationId: f.second.id, temporary: true } }), 1)
    await expectCode(() => atPoint(f, f.second.id, () => createShift(admin.id, f.organizationId, pointShift(f.employee.id, '2062-05-03'))), 'MEMBER_NOT_IN_LOCATION')
  })
  it('rolls back staffing approval on cross-point overlap and cancels responses when an offer is cancelled', async () => {
    const f = await locationFixture()
    const staffing = (await listRequestTypes(owner.id, f.organizationId)).find(type => type.systemCode === 'STAFFING')!
    const offer = await atPoint(f, f.second.id, () => createRequest(owner.id, f.organizationId, { requestTypeId: staffing.id, staffingPositionName: 'Кассир', proposedStartDate: '2063-05-02', proposedEndDate: '2063-05-02', proposedStartTime: '09:00', proposedEndTime: '18:00' }))
    const response = await atPoint(f, f.second.id, () => respondToStaffing(member.id, f.organizationId, offer.id))
    await atPoint(f, f.first.id, () => createShift(owner.id, f.organizationId, pointShift(f.employee.id, '2063-05-02')))
    await expectCode(() => atPoint(f, f.second.id, () => resolveRequest(owner.id, f.organizationId, response.id, 'APPROVED', null)), 'SHIFT_OVERLAP')
    assert.equal(await prisma.locationTransfer.count({ where: { organizationId: f.organizationId } }), 0)
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: response.id } })).status, 'PENDING')
    await atPoint(f, f.second.id, () => cancelRequest(owner.id, f.organizationId, offer.id))
    assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: response.id } })).status, 'CANCELLED')
  })
  it('preserves recipient folder access when editing a document and reports inherited restrictions', async () => {
    const f = await locationFixture()
    const metadata = { displayName: 'Ознакомление', folderId: null, visibility: 'ORGANIZATION' as const, targetMemberId: null }
    const doc = await atPoint(f, f.first.id, () => documentsService.uploadDocument(admin.id, f.organizationId, Buffer.from('Policy'), 'text/plain', 'policy.txt', metadata))
    await atPoint(f, f.first.id, () => documentsService.assignAcknowledgements(admin.id, f.organizationId, doc.id, assignmentSchema.parse({ recipients: 'members', memberIds: [f.employee.id] })))
    const restricted = await atPoint(f, f.first.id, () => documentsService.saveFolder(admin.id, f.organizationId, undefined, { name: 'Руководителям', parentId: null, visibility: 'ADMINS' }))
    const child = await atPoint(f, f.first.id, () => documentsService.saveFolder(admin.id, f.organizationId, undefined, { name: 'Вложенная', parentId: restricted.id }))
    await expectCode(() => atPoint(f, f.first.id, () => documentsService.updateDocument(admin.id, f.organizationId, doc.id, { ...metadata, folderId: child.id })), 'ACKNOWLEDGEMENT_ACCESS_CONFLICT')
    const nested = await atPoint(f, f.first.id, () => documentsService.uploadDocument(admin.id, f.organizationId, Buffer.from('Manager'), 'text/plain', 'manager.txt', { ...metadata, folderId: child.id }))
    assert.equal((await atPoint(f, f.first.id, () => documentsService.getDocument(admin.id, f.organizationId, nested.id))).accessVisibility, 'ADMINS')
    const publicFolder = await atPoint(f, f.first.id, () => documentsService.saveFolder(admin.id, f.organizationId, undefined, { name: 'Открытая папка', parentId: null }))
    await atPoint(f, f.first.id, () => documentsService.updateDocument(admin.id, f.organizationId, doc.id, { ...metadata, folderId: publicFolder.id }))
    await atPoint(f, f.first.id, () => documentsService.saveFolder(admin.id, f.organizationId, publicFolder.id, { name: 'Закрытая папка', parentId: restricted.id }))
    assert.ok((await prisma.documentAcknowledgement.findFirstOrThrow({ where: { documentId: doc.id } })).cancelledAt)

    await expectCode(() => atPoint(f, f.first.id, () => documentsService.uploadDocument(admin.id, f.organizationId, Buffer.from('Personal'), 'text/plain', 'personal.txt', { ...metadata, visibility: 'PRIVATE_MEMBER', targetMemberId: f.employee.id, folderId: child.id })), 'RECIPIENT_ACCESS_DENIED')
    const types = await listRequestTypes(member.id, f.organizationId)
    const normal = await atPoint(f, f.first.id, () => createRequest(member.id, f.organizationId, { requestTypeId: types.find(type => type.systemCode === 'OTHER')!.id, comment: 'Обычная заявка' }))
    await expectCode(() => atPoint(f, f.first.id, () => updateRequest(member.id, f.organizationId, normal.id, { requestTypeId: types.find(type => type.systemCode === 'STAFFING')!.id })), 'STAFFING_EDIT_LOCKED')
  })
  it('paginates a directory of more than 50 people and returns every employee on a busy calendar day', async () => {
    const f = await locationFixture()
    const users = Array.from({ length: 51 }, (_, index) => ({ id: randomUUID(), email: email(`directory-${index}`), passwordHash: 'test-only' }))
    await prisma.user.createMany({ data: users })
    const members = users.map(user => ({ id: randomUUID(), organizationId: f.organizationId, userId: user.id }))
    await prisma.organizationMember.createMany({ data: members })
    await prisma.locationMember.createMany({ data: members.map(person => ({ organizationId: f.organizationId, memberId: person.id, locationId: f.first.id })) })
    const page = await atPoint(f, f.second.id, () => listMembersPage(member.id, f.organizationId, { directory: 'true', page: 3, pageSize: 20 }))
    assert.equal(page.pagination.total, 54)
    assert.equal(page.members.length, 14)
    for (const person of members.slice(0, 10)) await atPoint(f, f.first.id, () => createShift(owner.id, f.organizationId, pointShift(person.id, '2064-05-02')))
    const calendar = await atPoint(f, f.first.id, () => listSchedule(member.id, f.organizationId, '2064-05-01', '2064-06-01'))
    assert.equal(calendar.shifts.length, 10)
    assert.equal(new Set(calendar.shifts.map(shift => shift.memberId)).size, 10)
    assert.equal((await atPoint(f, f.second.id, () => listSchedule(member.id, f.organizationId, '2064-05-01', '2064-06-01'))).shifts.length, 0)
  })
  it('returns today employees in each point timezone without mixing point schedules', async () => {
    const f = await locationFixture()
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
    const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-')
    await atPoint(f, f.first.id, () => createShift(owner.id, f.organizationId, pointShift(f.employee.id, today)))
    const summary = await locationOverview(member.id, f.organizationId)
    assert.equal(summary.find(point => point.id === f.first.id)?.todayMemberCount, 1)
    assert.equal(summary.find(point => point.id === f.second.id)?.todayMemberCount, 0)
    assert.equal(summary.find(point => point.id === f.first.id)?.shifts[0].memberId, f.employee.id)
  })
})
