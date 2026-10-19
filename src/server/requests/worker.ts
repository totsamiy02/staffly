import { maintainShiftOffers } from '../schedule/offer-service.ts'
import { prisma } from '../db.ts'
import { notifyStage } from './workflow.ts'
import { reconcileShiftRequests } from './shift-conflicts.ts'
import { startBackgroundTask } from '../background-task.ts'
export async function maintainRequests(now=new Date(),shouldContinue=()=>true){
  await maintainShiftOffers(shouldContinue)
  const orgs=await prisma.organization.findMany({where:{deletedAt:null},select:{id:true}})
  for(const org of orgs){
    if (!shouldContinue()) return
    await reconcileShiftRequests(org.id)
    await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${org.id},1))::text`
      const expired=await tx.organizationRequest.findMany({where:{organizationId:org.id,status:'PENDING',systemCodeSnapshot:{in:['SHIFT_PROPOSAL','STAFFING','STAFFING_RESPONSE']},proposedStartAt:{lte:now}},include:{creator:true}})
      for(const r of expired){const changed=await tx.organizationRequest.updateMany({where:{id:r.id,status:'PENDING',updatedAt:r.updatedAt},data:{status:'EXPIRED',cancelledAt:now,resolutionComment:'Предложенное время истекло.'}});if(!changed.count)continue;await tx.requestEvent.create({data:{requestId:r.id,actorMemberId:r.createdByMemberId,type:'EXPIRED',comment:'Автоматическое закрытие: предложенное время истекло.',changes:{automatic:true}}});await tx.accountNotification.updateMany({where:{requestId:r.id,readAt:null},data:{readAt:now}});await tx.accountNotification.create({data:{organizationId:org.id,userId:r.creator.userId,requestId:r.id,type:'REQUEST_CANCELLED',title:'Срок обращения истёк',message:r.typeNameSnapshot}})}
      const overdue=await tx.organizationRequest.findMany({where:{organizationId:org.id,status:'PENDING',systemCodeSnapshot:{notIn:['STAFFING','STAFFING_RESPONSE']},dueAt:{lte:now},remindedAt:null},take:100})
      for(const r of overdue){await notifyStage(tx,r);await tx.organizationRequest.update({where:{id:r.id},data:{remindedAt:now}})}
      const campaigns=await tx.vacationCampaign.findMany({where:{organizationId:org.id,closedAt:null,dueAt:{lte:now}},include:{requests:{select:{createdByMemberId:true}}}})
      for(const c of campaigns){const members=await tx.organizationMember.findMany({where:{organizationId:org.id,id:{in:c.memberIds.filter(id=>!c.requests.some(r=>r.createdByMemberId===id))},leftAt:null}});if(members.length)await tx.accountNotification.createMany({data:members.map(m=>({organizationId:org.id,userId:m.userId,type:'REQUEST_VACATION_REMINDER',vacationCampaignId:c.id,title:'Срок выбора отпуска прошёл',message:c.title}))});await tx.vacationCampaign.update({where:{id:c.id},data:{closedAt:now}})}
    })
  }
}
export function startRequestMaintenance(){return startBackgroundTask({name:'Request maintenance',intervalMs:60_000,retryExpiredTransaction:true,run:shouldContinue=>maintainRequests(new Date(),shouldContinue)})}
