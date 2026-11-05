import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { prisma } from '../db.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { lockAccount, invalidateSecurityChallenges, revokeOtherSessions, type AccountSession } from '../auth/account-security.ts'
import { sessionTransaction } from '../auth/session-transaction.ts'
import { deliverEmail } from '../mail/transport.ts'
import { recordSecurityEvent } from '../security/journal.ts'
import { dataPolicy, purgeEnabled } from './policy.ts'
import { closeOffer } from '../schedule/offer-service.ts'

export async function scheduleDeletion(tx: Prisma.TransactionClient, kind: 'ACCOUNT' | 'ORGANIZATION', subjectId: string, now = new Date()) {
  return tx.dataDeletion.upsert({ where: { kind_subjectId: { kind, subjectId } }, create: { kind, subjectId, requestedAt: now, dueAt: new Date(+now + 30 * 86400_000) }, update: {} })
}
const codeHash = (id: string, code: string) => createHmac('sha256', process.env.JWT_SECRET!).update(`account-deletion:${id}:${code}`).digest('hex')
async function assertNotOwner(tx: Prisma.TransactionClient, userId: string) {
  if (await tx.organizationMember.count({ where: { userId, role: 'OWNER', leftAt: null, organization: { deletedAt: null } } })) throw new ApiError(409, 'ACCOUNT_OWNS_ORGANIZATIONS', 'Сначала передайте владение действующими организациями или удалите их.')
}
export async function lifecycleStatus(userId: string) {
  const ownedOrganizations = await prisma.organizationMember.count({ where: { userId, role: 'OWNER', leftAt: null, organization: { deletedAt: null } } })
  const deletion = await prisma.dataDeletion.findUnique({ where: { kind_subjectId: { kind: 'ACCOUNT', subjectId: userId } }, select: { requestedAt: true, dueAt: true, completedAt: true, hold: true } })
  return { policy: dataPolicy, cleanupEnabled: purgeEnabled(), ownedOrganizations, deletion }
}
async function sendAccountDeletionCode(email: string, code: string) {
  if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) throw new Error('SMTP_UNAVAILABLE')
  await deliverEmail(email, {
    title: 'Удаление аккаунта', eyebrow: 'Безопасность',
    intro: 'Введите код в настройках Staffly для удаления аккаунта. Все сеансы будут завершены. Рабочая история организаций сохраняется по их правилам.',
    code, footer: 'Если вы не удаляете аккаунт, никому не сообщайте код.',
  })
}
export async function requestAccountDeletion(auth: AccountSession, sendCode = sendAccountDeletionCode) {
  const id = randomUUID(), code = randomInt(0, 1_000_000).toString().padStart(6, '0'), now = new Date()
  const email = await sessionTransaction(() => prisma.$transaction(async tx => {
    const user = await lockAccount(tx, auth); await assertNotOwner(tx, user.id)
    const previous = await tx.accountDeletionChallenge.findUnique({ where: { userId: user.id } })
    if (previous && +previous.createdAt > +now - 60_000) throw new ApiError(429, 'CODE_COOLDOWN', 'Повторный код можно запросить через минуту.')
    await tx.accountDeletionChallenge.upsert({ where: { userId: user.id }, create: { id, userId: user.id, sessionId: auth.sessionId, securityVersion: user.securityVersion, codeHash: codeHash(id, code), createdAt: now, expiresAt: new Date(+now + 600_000) }, update: { id, sessionId: auth.sessionId, securityVersion: user.securityVersion, codeHash: codeHash(id, code), attempts: 0, createdAt: now, expiresAt: new Date(+now + 600_000) } })
    await recordSecurityEvent(tx, { action: 'ACCOUNT_DELETION_REQUESTED', userId: user.id, sessionId: auth.sessionId, resourceType: 'ACCOUNT', resourceId: user.id })
    return user.email
  }))
  try { await sendCode(email, code) }
  catch { await prisma.accountDeletionChallenge.deleteMany({ where: { id } }); throw new ApiError(503, 'SECURITY_EMAIL_UNAVAILABLE', 'Письмо не отправлено. Повторите запрос позже.') }
  return { challengeId: id, expiresAt: new Date(+now + 600_000) }
}
export async function confirmAccountDeletion(auth: AccountSession, challengeId: string, code: string) {
  const result = await sessionTransaction(() => prisma.$transaction(async tx => {
    const user = await lockAccount(tx, auth), now = new Date()
    const token = await tx.accountDeletionChallenge.findFirst({ where: { id: challengeId, userId: user.id, sessionId: auth.sessionId, securityVersion: user.securityVersion, expiresAt: { gt: now }, attempts: { lt: 5 } } })
    if (!token) { await recordSecurityEvent(tx, { action: 'CONFIRMATION_FAILED', userId: user.id, resourceType: 'ACCOUNT', resourceId: user.id, outcome: 'DENIED', reasonCode: 'INVALID_CONFIRMATION' }); return null }
    const valid = timingSafeEqual(Buffer.from(token.codeHash, 'hex'), Buffer.from(codeHash(token.id, code), 'hex'))
    await tx.accountDeletionChallenge.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } })
    if (!valid) { await recordSecurityEvent(tx, { action: 'CONFIRMATION_FAILED', userId: user.id, resourceType: 'ACCOUNT', resourceId: user.id, outcome: 'DENIED', reasonCode: 'INVALID_CONFIRMATION' }); return null }
    await assertNotOwner(tx, user.id)
    const memberships = await tx.organizationMember.findMany({ where: { userId: user.id, leftAt: null }, orderBy: { organizationId: 'asc' } })
    for (const member of memberships) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${member.organizationId}, 1))::text`
      await assertNotOwner(tx, user.id)
      const offers = await tx.shiftOffer.findMany({ where: { organizationId: member.organizationId, status: { in: ['PENDING', 'AWAITING_APPROVAL'] }, OR: [{ initiatorMemberId: member.id }, { recipientMemberId: member.id }, { acceptedByMemberId: member.id }] } })
      for (const offer of offers) await closeOffer(tx, offer, 'CANCELLED', 'Аккаунт сотрудника удалён')
      await tx.organizationRequest.updateMany({ where: { organizationId: member.organizationId, createdByMemberId: member.id, status: { in: ['DRAFT', 'PENDING', 'RETURNED'] } }, data: { status: 'CANCELLED', cancelledAt: now, resolutionComment: 'Аккаунт сотрудника удалён' } })
      await tx.locationMember.updateMany({ where: { memberId: member.id, leftAt: null }, data: { leftAt: now } })
      await tx.locationTransfer.updateMany({ where: { memberId: member.id, revokedAt: null }, data: { revokedAt: now } })
      await tx.accessAssignment.deleteMany({ where: { memberId: member.id } })
      await tx.locationTeamMember.deleteMany({ where: { memberId: member.id } })
      await tx.organizationMember.update({ where: { id: member.id }, data: { leftAt: now } })
      await tx.documentAcknowledgement.updateMany({ where: { memberId: member.id, acknowledgedAt: null, cancelledAt: null }, data: { cancelledAt: now } })
      await tx.workShift.updateMany({ where: { memberId: member.id, status: 'SCHEDULED', scheduledStartAt: { gt: now }, actualStartAt: null, actualEndAt: null, actualBreakMinutes: null, attendance: 'UNCONFIRMED' }, data: { status: 'CANCELLED', cancelledAt: now, cancelledByMemberId: member.id, cancellationReason: 'Аккаунт сотрудника удалён' } })
      await recordSecurityEvent(tx, { action: 'MEMBER_DEPARTED', userId: user.id, organizationId: member.organizationId, resourceType: 'MEMBER', resourceId: member.id })
    }
    await tx.user.update({ where: { id: user.id }, data: { deletedAt: now, securityVersion: { increment: 1 }, emailNotificationsEnabled: false, lastSeenAt: null } })
    await invalidateSecurityChallenges(tx, user.id); await revokeOtherSessions(tx, user.id)
    await tx.accountDeletionChallenge.deleteMany({ where: { userId: user.id } })
    const deletion = await scheduleDeletion(tx, 'ACCOUNT', user.id, now)
    await recordSecurityEvent(tx, { action: 'ACCOUNT_DELETED', userId: user.id, resourceType: 'ACCOUNT', resourceId: user.id })
    return { deleted: true, dueAt: deletion.dueAt, cleanupEnabled: purgeEnabled() }
  }, { isolationLevel: 'Serializable', timeout: 15_000 }))
  if (!result) throw new ApiError(400, 'INVALID_VERIFICATION_CODE', 'Код неверен или срок его действия истёк.')
  return result
}
