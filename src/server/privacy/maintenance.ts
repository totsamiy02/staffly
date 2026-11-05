import { prisma, databasePool } from '../db.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { storage } from '../storage/provider.ts'
import { recordSecurityEvent } from '../security/journal.ts'
import { purgeEnabled } from './policy.ts'

// Only explicitly scheduled deletions are eligible. Existing soft-deleted rows are
// never silently backfilled. Operators can hold a job before enabling cleanup.
export async function retentionPlan() {
  const jobs = await prisma.dataDeletion.findMany({ where: { completedAt: null }, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: 100,
    select: { id: true, kind: true, subjectId: true, requestedAt: true, dueAt: true, hold: true, attempts: true, lastErrorCode: true } })
  return { cleanupEnabled: purgeEnabled(), jobs, pending: await prisma.dataDeletion.count({ where: { completedAt: null } }), expiredSecurityEvents: await prisma.securityEvent.count({ where: { expiresAt: { lt: new Date() } } }) }
}

async function purgeOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  const scope = { organizationId }
  // Explicit ordering for Restrict relations. The final delete cascades the
  // remaining tenant-only tables, including the protected resource budget.
  await tx.accountNotification.deleteMany({ where: scope })
  await tx.emailDelivery.deleteMany({ where: scope })
  await tx.reportExport.deleteMany({ where: scope })
  await tx.scheduleDraft.deleteMany({ where: scope })
  await tx.shiftOffer.deleteMany({ where: scope })
  await tx.organizationEvent.deleteMany({ where: scope })
  await tx.documentAcknowledgement.deleteMany({ where: { document: scope } })
  await tx.document.deleteMany({ where: scope })
  await tx.documentFolder.updateMany({ where: scope, data: { parentId: null } })
  await tx.documentFolder.deleteMany({ where: scope })
  await tx.employeeAbsence.deleteMany({ where: scope })
  await tx.organizationRequest.updateMany({ where: scope, data: { staffingRequestId: null } })
  await tx.organizationRequest.deleteMany({ where: scope })
  await tx.workShift.deleteMany({ where: scope })
  await tx.requestType.deleteMany({ where: scope })
  await tx.vacationCampaign.deleteMany({ where: scope })
  await tx.reportTemplate.deleteMany({ where: scope })
  await tx.shiftTemplate.deleteMany({ where: scope })
  await tx.locationTransfer.deleteMany({ where: scope })
  await tx.organizationInvite.deleteMany({ where: scope })
  await tx.sensitiveActionToken.deleteMany({ where: scope })
  await tx.demandVersion.deleteMany({ where: scope })
  await tx.demandException.deleteMany({ where: scope })
  await tx.organizationMember.deleteMany({ where: scope })
  await tx.organizationLocation.deleteMany({ where: scope })
  await tx.storedFile.deleteMany({ where: scope })
  await tx.organization.deleteMany({ where: { id: organizationId, deletedAt: { not: null } } })
}
async function anonymizeAccount(tx: Prisma.TransactionClient, userId: string) {
  await tx.authSession.deleteMany({ where: { userId } })
  await tx.authIdentity.deleteMany({ where: { userId } })
  await tx.oAuthAttempt.deleteMany({ where: { userId } })
  await tx.emailChangeToken.deleteMany({ where: { userId } })
  await tx.emailVerificationToken.deleteMany({ where: { userId } })
  await tx.passwordResetToken.deleteMany({ where: { userId } })
  await tx.accountDeletionChallenge.deleteMany({ where: { userId } })
  await tx.sensitiveActionToken.deleteMany({ where: { OR: [{ userId }, { targetUserId: userId }] } })
  await tx.emailDelivery.deleteMany({ where: { userId } })
  await tx.accountNotification.deleteMany({ where: { userId } })
  await tx.documentFolderPin.deleteMany({ where: { userId } })
  await tx.reportExport.deleteMany({ where: { userId } })
  await tx.storedFile.deleteMany({ where: { uploadedByUserId: userId, organizationId: null, purgedAt: { not: null } } })
  // A tombstone preserves historical FK references. Free-form business records
  // remain under the organization's retention policy; this is pseudonymization.
  await tx.user.update({ where: { id: userId }, data: { email: `deleted-${userId}@accounts.invalid`, firstName: 'Удалённый пользователь', lastName: null, middleName: null, phone: null, bio: null, passwordHash: null, avatarFileId: null,
    emailVerifiedAt: null, termsAcceptedAt: null, dataConsentAt: null, lastSecurityEmailAt: null, lastSeenAt: null, emailNotificationsEnabled: false, emailNotificationCategories: {}, emailPreferencesRevision: 0 } })
}

type Removal = (key: string) => Promise<void>
export async function runDataRetention({ enabled = purgeEnabled(), removeObject = storage.delete, shouldContinue = () => true }: { enabled?: boolean; removeObject?: Removal; shouldContinue?: () => boolean } = {}) {
  if (!enabled) return { enabled: false, checked: 0, completed: 0, failed: 0, securityEventsRemoved: 0 }
  const jobs = await prisma.dataDeletion.findMany({ where: { hold: false, completedAt: null, dueAt: { lte: new Date() } }, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: 10 })
  let completed = 0, failed = 0
  nextJob: for (const candidate of jobs) {
    if (!shouldContinue()) break
    // Session advisory lock spans object I/O without holding an SQL transaction.
    // All replicas and the hold command use this same lock. Worker pool >= 2.
    const lock = await databasePool.connect()
    let acquired = false
    try {
      acquired = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 91)) AS locked', [candidate.id])).rows[0].locked
      if (!acquired) continue
      const job = await prisma.dataDeletion.findFirst({ where: { id: candidate.id, hold: false, completedAt: null, dueAt: { lte: new Date() } } })
      if (!job) continue
      const organization = job.kind === 'ORGANIZATION'
      const subject = organization ? await prisma.organization.findUnique({ where: { id: job.subjectId }, select: { deletedAt: true } }) : await prisma.user.findUnique({ where: { id: job.subjectId }, select: { deletedAt: true } })
      if (subject && !subject.deletedAt) throw new Error('SUBJECT_ACTIVE')
      if (!subject) throw new Error('SUBJECT_MISSING')
      if (!organization && await prisma.organizationMember.count({ where: { userId: job.subjectId, leftAt: null, organization: { deletedAt: null } } })) throw new Error('ACTIVE_MEMBERSHIP')
      const fileScope = organization ? { organizationId: job.subjectId } : { uploadedByUserId: job.subjectId, organizationId: null }
      const exportScope = organization ? { organizationId: job.subjectId } : { userId: job.subjectId }
      await prisma.$transaction(async tx => {
        if (organization) {
          await tx.organization.update({ where: { id: job.subjectId }, data: { logoFileId: null } })
          await tx.document.updateMany({ where: { organizationId: job.subjectId, deletedAt: null }, data: { deletedAt: new Date() } })
        } else await tx.user.update({ where: { id: job.subjectId }, data: { avatarFileId: null } })
        // Retention owns its queue. Do not enqueue these files in the ordinary
        // upload cleanup worker, which must not bypass a later operator hold.
      })
      const files = await prisma.storedFile.findMany({ where: { ...fileScope, purgedAt: null }, take: 50, orderBy: { id: 'asc' }, select: { id: true, objectKey: true } })
      for (const file of files) {
        if (!shouldContinue()) continue nextJob
        try { await removeObject(file.objectKey) } catch { throw new Error('OBJECT_DELETE_FAILED') }
        await prisma.storedFile.updateMany({ where: { id: file.id }, data: { purgedAt: new Date(), pendingDeletionAt: null, lastDeletionError: null } })
      }
      const exports = await prisma.reportExport.findMany({ where: { ...exportScope, objectKey: { not: null } }, select: { id: true, objectKey: true }, take: 50 })
      for (const report of exports) {
        if (!shouldContinue()) continue nextJob
        try { await removeObject(report.objectKey!) } catch { throw new Error('OBJECT_DELETE_FAILED') }
        await prisma.reportExport.update({ where: { id: report.id }, data: { objectKey: null } })
      }
      if (await prisma.storedFile.count({ where: { ...fileScope, purgedAt: null } }) || await prisma.reportExport.count({ where: { ...exportScope, objectKey: { not: null } } })) continue
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM data_deletions WHERE id=${job.id}::uuid FOR UPDATE`
        const current = await tx.dataDeletion.findUniqueOrThrow({ where: { id: job.id } })
        if (current.hold || current.completedAt) return
        if (organization) await purgeOrganization(tx, job.subjectId)
        else await anonymizeAccount(tx, job.subjectId)
        await tx.dataDeletion.update({ where: { id: job.id }, data: { completedAt: new Date(), lastErrorCode: null } })
        await recordSecurityEvent(tx, { action: 'DATA_PURGED', ...(organization ? { organizationId: job.subjectId } : { userId: job.subjectId }), resourceType: organization ? 'ORGANIZATION' : 'ACCOUNT', resourceId: job.subjectId })
      }, { timeout: 30_000 })
      completed++
    } catch (error) {
      failed++
      const allowed = ['SUBJECT_ACTIVE', 'SUBJECT_MISSING', 'ACTIVE_MEMBERSHIP', 'OBJECT_DELETE_FAILED']
      await prisma.dataDeletion.update({ where: { id: candidate.id }, data: { attempts: { increment: 1 }, lastErrorCode: error instanceof Error && allowed.includes(error.message) ? error.message : 'DATABASE_CLEANUP_FAILED' } })
    } finally {
      if (acquired) await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 91))', [candidate.id])
      lock.release()
    }
  }
  if (!shouldContinue()) return { enabled: true, checked: jobs.length, completed, failed, securityEventsRemoved: 0 }
  const result = await prisma.$queryRaw<{ purge_expired_security_events: number }[]>`SELECT purge_expired_security_events()`
  return { enabled: true, checked: jobs.length, completed, failed, securityEventsRemoved: result[0].purge_expired_security_events }
}

export async function holdDeletion(id: string, hold: boolean) {
  const lock = await databasePool.connect()
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 91))', [id])
    return await prisma.dataDeletion.update({ where: { id, completedAt: null }, data: { hold } })
  } finally { await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 91))', [id]); lock.release() }
}
