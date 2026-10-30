import { subscriptionSnapshot } from '../subscriptions/access.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { requirePermission } from '../organizations/access/access.ts'
import type { Prisma } from '../../generated/prisma/client.ts'

export function storageQuotaError(error: unknown): never {
  if (error instanceof Error && error.message.includes('ORGANIZATION_STORAGE_QUOTA_EXCEEDED')) throw new ApiError(409,'ORGANIZATION_STORAGE_QUOTA','Хранилище организации заполнено. Освободите место, удалив файлы из журнала удалений, или обратитесь к владельцу.')
  throw error
}
// Caller holds the shared export admission lock. Counters survive job cleanup.
export async function reserveOrganizationExport(tx: Prisma.TransactionClient, organizationId: string) {
  const budget = await tx.organizationResourceBudget.findUniqueOrThrow({where:{organizationId}})
  const now = new Date()
  const active = await tx.reportExport.count({where:{organizationId,status:{in:['PENDING','RUNNING']},expiresAt:{gt:now}}})
  if (active >= budget.exportQueueLimit) throw new ApiError(429,'ORGANIZATION_EXPORT_QUEUE','Очередь экспортов организации заполнена. Дождитесь завершения текущих отчётов.')
  const [reserved] = await tx.$queryRaw<Array<{organization_id:string}>>`
    UPDATE organization_resource_budgets SET
      export_window_count=CASE WHEN export_window_start<=now()-interval '1 hour' THEN 1 ELSE export_window_count+1 END,
      export_window_start=CASE WHEN export_window_start<=now()-interval '1 hour' THEN now() ELSE export_window_start END
    WHERE organization_id=${organizationId}::uuid AND (export_window_start<=now()-interval '1 hour' OR export_window_count<export_hour_limit)
    RETURNING organization_id`
  if (!reserved) throw new ApiError(429,'ORGANIZATION_EXPORT_RATE','Достигнут часовой лимит экспортов организации. Повторите позже.')
}
export async function organizationResources(userId:string, organizationId:string) {
  const actor = await getMembership(userId,organizationId)
  requirePermission(actor,'organization.edit',null)
  return prisma.$transaction(async db => {
  const b=await db.organizationResourceBudget.findUniqueOrThrow({where:{organizationId}})
  const subscription = await subscriptionSnapshot(organizationId, db)
  const groups = await db.storedFile.groupBy({ by: ['purpose'], where: { organizationId, purgedAt: null, pendingDeletionAt: null }, _sum: { size: true } })
  const archived = await db.storedFile.aggregate({ where: { organizationId, purgedAt: null, pendingDeletionAt: null, document: { is: { deletedAt: { not: null } } } }, _sum: { size: true } })
  const pending = await db.storedFile.aggregate({ where: { organizationId, purgedAt: null, pendingDeletionAt: { not: null } }, _sum: { size: true } })
  const bytes = (purpose: string) => groups.find(group => group.purpose === purpose)?._sum.size ?? 0
  const breakdown = { documentsBytes: Math.max(0, bytes('DOCUMENT') - (archived._sum.size ?? 0)), requestAttachmentsBytes: bytes('REQUEST_ATTACHMENT'), brandingBytes: bytes('ORGANIZATION_LOGO'), archivedBytes: archived._sum.size ?? 0, pendingBytes: pending._sum.size ?? 0 }
  return {storage:{usedBytes:Number(b.storageBytes),breakdown,limitBytes:Math.min(Number(b.storageLimitBytes),subscription.limits.storageBytes),archivedBytes:archived._sum.size ?? 0,pendingDeletionBytes:pending._sum.size ?? 0},exports:{queueLimit:b.exportQueueLimit,hourLimit:b.exportHourLimit,usedThisWindow:+b.exportWindowStart+3600000>Date.now()?b.exportWindowCount:0,windowEndsAt:new Date(+b.exportWindowStart+3600000)},email:{pending:b.pendingEmails,queueLimit:b.emailQueueLimit,minuteLimit:b.emailMinuteLimit}}
  }, { isolationLevel: 'RepeatableRead' })
}
