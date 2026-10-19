import { prisma } from '../db.ts'
import { startBackgroundTask } from '../background-task.ts'
import { enqueueEmail, processEmailDeliveries } from './email-outbox.ts'
import { zonedDateAndTime, addDays } from '../../app/schedule/date-utils.ts'

export async function scheduleEmailReminders(now = new Date()) {
  const soon = new Date(+now + 86400_000)
  const wants = (category: string) => ({ deletedAt: null, emailNotificationsEnabled: true, emailNotificationCategories: { path: [category], equals: true } })
  const documents = await prisma.documentAcknowledgement.findMany({ where: { acknowledgedAt: null, cancelledAt: null, deadline: { gte: new Date(+now - 86400_000), lte: new Date(+now + 2*86400_000) }, member: { leftAt: null, user: wants('documents') }, document: { deletedAt: null, organization: { deletedAt: null } } }, include: { member: true, document: { include: { organization: true, location: true } } } })
  for (const ack of documents) {
    const zone = ack.document.location?.timezone ?? ack.document.organization.timezone
    const tomorrow = addDays(zonedDateAndTime(now.toISOString(),zone).date,1)
    if (ack.deadline!.toISOString().slice(0,10) !== tomorrow) continue
    await enqueueEmail(prisma,{ userId:ack.member.userId,organizationId:ack.document.organizationId,sourceKind:'DOCUMENT_REMINDER',sourceId:ack.id,sourceKey:`document-reminder:${ack.id}:${tomorrow}`,category:'documents' })
  }
  const drafts = await prisma.draftRecipient.findMany({ where: { draft: { status:'OPEN',deadline:{gt:now,lte:soon},organization:{deletedAt:null} },member:{leftAt:null,user:wants('scheduleDiscussion')} }, include:{member:true,draft:true} })
  for (const r of drafts) {
    if (r.response && r.respondedRevision === r.requiredRevision) continue
    await enqueueEmail(prisma,{userId:r.member.userId,organizationId:r.organizationId,sourceKind:'DRAFT_REMINDER',sourceId:r.draftId,sourceKey:`draft-reminder:${r.draftId}:${r.memberId}:${r.draft.deadline!.toISOString()}`,category:'scheduleDiscussion'})
  }
  const campaigns = await prisma.vacationCampaign.findMany({where:{closedAt:null,dueAt:{gt:now,lte:soon},organization:{deletedAt:null}},include:{requests:{select:{createdByMemberId:true}}}})
  for (const c of campaigns) {
    const members=await prisma.organizationMember.findMany({where:{organizationId:c.organizationId,id:{in:c.memberIds.filter(id=>!c.requests.some(r=>r.createdByMemberId===id))},leftAt:null,user:wants('vacationCollection')},select:{id:true,userId:true}})
    for(const m of members) await enqueueEmail(prisma,{userId:m.userId,organizationId:c.organizationId,sourceKind:'VACATION_REMINDER',sourceId:c.id,sourceKey:`vacation-reminder:${c.id}:${m.id}:${c.dueAt.toISOString()}`,category:'vacationCollection'})
  }
}
export function startEmailNotifications() {
  let lastMaintenance=0
  return startBackgroundTask({ name: 'Email worker', intervalMs: 1_000, run: async shouldContinue => {
      if(Date.now()-lastMaintenance>=60_000){await scheduleEmailReminders();lastMaintenance=Date.now();await prisma.emailDelivery.deleteMany({where:{status:{in:['SENT','SKIPPED','FAILED']},createdAt:{lt:new Date(Date.now()-30*86400_000)}}})}
      if (shouldContinue()) await processEmailDeliveries({ shouldContinue })
  } })
}
