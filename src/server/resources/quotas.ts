import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { requirePermission } from '../organizations/access/access.ts'
import type { Prisma } from '../../generated/prisma/client.ts'

export function storageQuotaError(error: unknown): never {
  if (error instanceof Error && error.message.includes('ORGANIZATION_STORAGE_QUOTA_EXCEEDED')) throw new ApiError(409,'ORGANIZATION_STORAGE_QUOTA','Хранилище организации заполнено. Удалите ненужные файлы или увеличьте квоту.')
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
  const b=await prisma.organizationResourceBudget.findUniqueOrThrow({where:{organizationId}})
  return {storage:{usedBytes:Number(b.storageBytes),limitBytes:Number(b.storageLimitBytes)},exports:{queueLimit:b.exportQueueLimit,hourLimit:b.exportHourLimit,usedThisWindow:+b.exportWindowStart+3600000>Date.now()?b.exportWindowCount:0,windowEndsAt:new Date(+b.exportWindowStart+3600000)},email:{pending:b.pendingEmails,queueLimit:b.emailQueueLimit,minuteLimit:b.emailMinuteLimit}}
}
