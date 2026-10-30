import { prisma } from '../db.ts'
import { startBackgroundTask } from '../background-task.ts'
import { enqueueEmail, processEmailDeliveries } from './email-outbox.ts'
import { zonedDateAndTime, addDays } from '../../app/schedule/date-utils.ts'

export async function scheduleEmailReminders(now = new Date()) {
  const soon = new Date(+now + 86400_000)
  const documentIds = await prisma.$queryRaw<Array<{id:string}>>`
    WITH eligible AS (
      SELECT a.id, row_number() OVER(PARTITION BY d.organization_id ORDER BY a.id) AS turn
      FROM document_acknowledgements a JOIN documents d ON d.id=a.document_id
      JOIN organizations o ON o.id=d.organization_id JOIN organization_resource_budgets b ON b.organization_id=o.id
      JOIN organization_members m ON m.id=a.member_id JOIN users u ON u.id=m.user_id
      LEFT JOIN organization_locations l ON l.id=d.location_id
      WHERE a.acknowledged_at IS NULL AND a.cancelled_at IS NULL AND d.deleted_at IS NULL AND o.deleted_at IS NULL
      AND m.left_at IS NULL AND u.deleted_at IS NULL AND u.email_notifications_enabled AND u.email_notification_categories->'documents'='true'::jsonb
      AND b.pending_emails<b.email_queue_limit
      AND a.deadline=(((${now}::timestamptz AT TIME ZONE COALESCE(l.timezone,o.timezone))::date)+1)
      AND NOT EXISTS(SELECT 1 FROM email_deliveries e WHERE e.source_key='document-reminder:'||a.id::text||':'||a.deadline::text)
    ) SELECT id FROM eligible WHERE turn<=25 ORDER BY turn,id LIMIT 250`
  const documents = documentIds.length ? await prisma.documentAcknowledgement.findMany({where:{id:{in:documentIds.map(r=>r.id)}}, include: { member: true, document: { include: { organization: true, location: true } } } }) : []
  for (const ack of documents) {
    const zone = ack.document.location?.timezone ?? ack.document.organization.timezone
    const tomorrow = addDays(zonedDateAndTime(now.toISOString(),zone).date,1)
    if (ack.deadline!.toISOString().slice(0,10) !== tomorrow) continue
    await enqueueEmail(prisma,{ userId:ack.member.userId,organizationId:ack.document.organizationId,sourceKind:'DOCUMENT_REMINDER',sourceId:ack.id,sourceKey:`document-reminder:${ack.id}:${tomorrow}`,category:'documents' })
  }
  const draftIds = await prisma.$queryRaw<Array<{draftId:string;memberId:string}>>`
    WITH eligible AS (
      SELECT r.draft_id AS "draftId",r.member_id AS "memberId",row_number() OVER(PARTITION BY r.organization_id ORDER BY r.draft_id,r.member_id) AS turn
      FROM draft_recipients r JOIN schedule_drafts d ON d.id=r.draft_id JOIN organizations o ON o.id=r.organization_id
      JOIN organization_resource_budgets b ON b.organization_id=o.id JOIN organization_members m ON m.id=r.member_id JOIN users u ON u.id=m.user_id
      WHERE d.status='OPEN' AND d.deadline>${now}::timestamptz AND d.deadline<=${soon}::timestamptz AND o.deleted_at IS NULL
      AND m.left_at IS NULL AND u.deleted_at IS NULL AND u.email_notifications_enabled AND u.email_notification_categories->'scheduleDiscussion'='true'::jsonb
      AND b.pending_emails<b.email_queue_limit AND (r.response IS NULL OR r.responded_revision IS DISTINCT FROM r.required_revision)
      AND NOT EXISTS(SELECT 1 FROM email_deliveries e WHERE e.source_key='draft-reminder:'||d.id::text||':'||m.id::text||':'||to_char(d.deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ) SELECT "draftId","memberId" FROM eligible WHERE turn<=25 ORDER BY turn,"draftId","memberId" LIMIT 250`
  const drafts = draftIds.length ? await prisma.draftRecipient.findMany({where:{OR:draftIds.map(r=>({draftId:r.draftId,memberId:r.memberId}))},include:{member:true,draft:true}}) : []
  for (const r of drafts) {
    if (r.response && r.respondedRevision === r.requiredRevision) continue
    await enqueueEmail(prisma,{userId:r.member.userId,organizationId:r.organizationId,sourceKind:'DRAFT_REMINDER',sourceId:r.draftId,sourceKey:`draft-reminder:${r.draftId}:${r.memberId}:${r.draft.deadline!.toISOString()}`,category:'scheduleDiscussion'})
  }
  const campaignRows = await prisma.$queryRaw<Array<{id:string;organizationId:string;memberId:string;userId:string;dueAt:Date}>>`
    WITH eligible AS (
      SELECT c.id,c.organization_id AS "organizationId",m.id AS "memberId",m.user_id AS "userId",c.due_at AS "dueAt",
        row_number() OVER(PARTITION BY c.organization_id ORDER BY c.due_at,c.id,m.id) AS turn
      FROM vacation_campaigns c JOIN organizations o ON o.id=c.organization_id JOIN organization_resource_budgets b ON b.organization_id=o.id
      JOIN organization_members m ON m.organization_id=o.id AND m.id=ANY(c.member_ids) JOIN users u ON u.id=m.user_id
      WHERE c.closed_at IS NULL AND c.due_at>${now}::timestamptz AND c.due_at<=${soon}::timestamptz AND o.deleted_at IS NULL
      AND m.left_at IS NULL AND u.deleted_at IS NULL AND u.email_notifications_enabled AND u.email_notification_categories->'vacationCollection'='true'::jsonb
      AND b.pending_emails<b.email_queue_limit
      AND NOT EXISTS(SELECT 1 FROM requests r WHERE r.campaign_id=c.id AND r.created_by_member_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM email_deliveries e WHERE e.source_key='vacation-reminder:'||c.id::text||':'||m.id::text||':'||to_char(c.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ) SELECT id,"organizationId","memberId","userId","dueAt" FROM eligible WHERE turn<=25 ORDER BY turn,id,"memberId" LIMIT 250`
  for (const c of campaignRows) await enqueueEmail(prisma,{userId:c.userId,organizationId:c.organizationId,sourceKind:'VACATION_REMINDER',sourceId:c.id,sourceKey:`vacation-reminder:${c.id}:${c.memberId}:${c.dueAt.toISOString()}`,category:'vacationCollection'})
}
export function startEmailNotifications() {
  let lastMaintenance=0
  return startBackgroundTask({ name: 'Email worker', intervalMs: 1_000, run: async shouldContinue => {
      if(Date.now()-lastMaintenance>=60_000){await scheduleEmailReminders();lastMaintenance=Date.now();await prisma.emailDelivery.deleteMany({where:{status:{in:['SENT','SKIPPED','FAILED']},createdAt:{lt:new Date(Date.now()-30*86400_000)}}})}
      if (shouldContinue()) await processEmailDeliveries({ shouldContinue })
  } })
}
