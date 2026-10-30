import { startBackgroundTask } from '../background-task.ts'
import { prisma } from '../db.ts'
import { maintainShiftOffers } from '../schedule/offer-service.ts'
import { markRequestNoticesRead,publishRequestNotices } from './request-notifications.ts'
import { loadReviewerContext,reviewersFromContext } from './reviewers.ts'
import { reconcileShiftRequests } from './shift-conflicts.ts'
export async function maintainRequests(now=new Date(),shouldContinue=()=>true){
  await maintainShiftOffers(shouldContinue)
  const orgs=await prisma.organization.findMany({where:{deletedAt:null},select:{id:true}})
  for(const org of orgs){
    if (!shouldContinue()) return
    await reconcileShiftRequests(org.id,true)
    await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${org.id},1))::text`
      const expired=await tx.organizationRequest.findMany({where:{organizationId:org.id,status:'PENDING',systemCodeSnapshot:{in:['SHIFT_PROPOSAL','STAFFING','STAFFING_RESPONSE']},proposedStartAt:{lte:now}},include:{creator:true},orderBy:[{proposedStartAt:'asc'},{id:'asc'}],take:100})
      for(const r of expired){const changed=await tx.organizationRequest.updateMany({where:{id:r.id,status:'PENDING',updatedAt:r.updatedAt},data:{status:'EXPIRED',cancelledAt:now,resolutionComment:'Предложенное время истекло.'}});if(!changed.count)continue;await tx.requestEvent.create({data:{requestId:r.id,actorMemberId:r.createdByMemberId,type:'EXPIRED',comment:'Автоматическое закрытие: предложенное время истекло.',changes:{automatic:true}}});await markRequestNoticesRead(tx, {requestId:r.id,readAt:null}, now);await publishRequestNotices(tx, [{organizationId:org.id,userId:r.creator.userId,requestId:r.id,type:'REQUEST_CANCELLED',title:'Срок обращения истёк',message:r.typeNameSnapshot}])}
      const overdue=await tx.organizationRequest.findMany({where:{organizationId:org.id,status:'PENDING',systemCodeSnapshot:{notIn:['STAFFING','STAFFING_RESPONSE']},dueAt:{lte:now},remindedAt:null},orderBy:[{dueAt:'asc'},{id:'asc'}],take:100})
      if (overdue.length) {
        const context = await loadReviewerContext(tx, org.id)
        const notifications = overdue.flatMap(r => reviewersFromContext(context,r).map(m => ({organizationId:org.id,userId:m.userId,requestId:r.id,type:'REQUEST_CREATED' as const,title:'Обращение на рассмотрении',message:r.typeNameSnapshot})))
        if (notifications.length) await publishRequestNotices(tx, notifications)
        await tx.organizationRequest.updateMany({where:{id:{in:overdue.map(r=>r.id)}},data:{remindedAt:now}})
      }
      const campaigns=await tx.vacationCampaign.findMany({where:{organizationId:org.id,closedAt:null,dueAt:{lte:now}},include:{requests:{select:{createdByMemberId:true},distinct:['createdByMemberId']}},orderBy:[{dueAt:'asc'},{id:'asc'}],take:10})
      if (campaigns.length) {
        const missing = campaigns.map(c => { const answered = new Set(c.requests.map(r=>r.createdByMemberId)); return {campaign:c,ids:c.memberIds.filter(id=>!answered.has(id))} })
        const ids = [...new Set(missing.flatMap(c=>c.ids))]
        const members = ids.length ? await tx.organizationMember.findMany({where:{organizationId:org.id,id:{in:ids},leftAt:null,user:{deletedAt:null}},select:{id:true,userId:true}}) : []
        const byId = new Map(members.map(m=>[m.id,m.userId]))
        const notifications = missing.flatMap(({campaign:c,ids})=>ids.flatMap(id=> { const userId=byId.get(id); return userId ? [{organizationId:org.id,userId,type:'REQUEST_VACATION_REMINDER' as const,vacationCampaignId:c.id,title:'Срок выбора отпуска прошёл',message:c.title}] : [] }))
        if (notifications.length) await publishRequestNotices(tx, notifications)
        await tx.vacationCampaign.updateMany({where:{id:{in:campaigns.map(c=>c.id)}},data:{closedAt:now}})
      }
    })
  }
}
export function startRequestMaintenance(){return startBackgroundTask({name:'Request maintenance',intervalMs:60_000,retryExpiredTransaction:true,run:shouldContinue=>maintainRequests(new Date(),shouldContinue)})}
