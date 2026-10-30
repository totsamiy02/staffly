import { z } from 'zod'
import { definitionOf,vacationDays } from '../../app/requests/workflow.ts'
import { ApiError } from '../api-error.ts'
import { prisma } from '../db.ts'
import { hasPermission,locationsFor,requirePermission } from '../organizations/access/access.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { date } from '../schedule/schemas.ts'
import { addCalendarDays,startOfZonedDate } from '../schedule/timezone.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { notifyStage,publishRequestNotices } from './request-notifications.ts'
import { ensureReviewers } from './reviewers.ts'
export const campaignBody=z.object({title:z.string().trim().min(3).max(120),year:z.number().int().min(2020).max(2200),dueAt:z.iso.datetime(),locationId:z.uuid().nullable().default(null),memberIds:z.array(z.uuid()).min(1).max(1000),standardDays:z.number().int().min(28).max(366).default(28)})
export const vacationResponseBody=z.object({memberId:z.uuid().optional(),submissionKey:z.string().min(8).max(80),periods:z.array(z.object({startDate:date,endDate:date}).refine(p=>p.startDate<=p.endDate&&Date.parse(p.endDate)-Date.parse(p.startDate)<=366*86400000,'Проверьте период.')).min(1).max(20),comment:z.string().trim().max(2000).default('')})
export async function listVacationPlanning(userId: string, org: string, year: number) {
  const actor = await getMembership(userId, org), view = hasPermission(actor, 'vacations.view'), ids = locationsFor(actor, 'vacations.view')
  if (!view) requirePermission(actor, 'requests.own')
  const campaigns = await prisma.vacationCampaign.findMany({ where: { organizationId: org, year, ...(actor.owner ? {} : view ? { OR: [{ locationId: { in: ids } }, { memberIds: { has: actor.id } }, { locationId: null, ...(hasPermission(actor, 'vacations.view', null) ? {} : { memberIds: { has: actor.id } }) }] } : { memberIds: { has: actor.id } }) }, include: { organization: { select: { timezone: true } } }, orderBy: { createdAt: 'desc' } })
  const pointIds = [...new Set(campaigns.flatMap(c => c.locationId ? [c.locationId] : []))]
  const points = pointIds.length ? await prisma.organizationLocation.findMany({ where: { organizationId: org, id: { in: pointIds } }, select: { id: true, timezone: true } }) : []
  const pointTimezones = new Map(points.map(point => [point.id, point.timezone]))
  const first = new Date(`${year}-01-01`), last = new Date(`${year}-12-31`)
  const requests = await prisma.organizationRequest.findMany({ where: { organizationId: org, systemCodeSnapshot: 'VACATION', AND: [actor.owner ? {} : view ? { OR: [{ locationId: { in: ids } }, { createdByMemberId: actor.id }] } : { createdByMemberId: actor.id }, { OR: [{ absence: { is: { startDate: { lte: last }, endDate: { gte: first } } } }, { absence: { is: null }, startDate: { lte: last }, endDate: { gte: first } }, { campaignId: { in: campaigns.map(c => c.id) } }] }] }, include: { creator: { include: { user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true } } } }, absence: true }, orderBy: { startDate: 'asc' } })
  const name = (m: { firstName: string | null; lastName: string | null; middleName: string | null }) => [m.lastName, m.firstName, m.middleName].filter(Boolean).join(' ') || 'Сотрудник'
  const members = await prisma.organizationMember.findMany({ where: { organizationId: org, id: { in: [...new Set(campaigns.flatMap(c => c.memberIds))] } }, include: { user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true } } } })
  return {
    campaigns: campaigns.map(c => {
      const manage = hasPermission(actor, 'vacations.collect', c.locationId)
      const { organization, ...campaign } = c
      return { ...campaign, timezone: (c.locationId ? pointTimezones.get(c.locationId) : undefined) ?? organization.timezone, canManage: manage, memberIds: manage ? c.memberIds : c.memberIds.filter(id => id === actor.id), members: members.filter(m => c.memberIds.includes(m.id) && (manage || m.id === actor.id)).map(m => ({ id: m.id, name: name(m.user), avatarUrl: mediaUrl(m.user.avatarFileId), responded: requests.some(r => r.campaignId === c.id && r.createdByMemberId === m.id && !['DRAFT', 'CANCELLED'].includes(r.status)) })) }
    }),
    requests: requests.filter(r => !(r.amendmentOfId && r.status === 'APPROVED')).filter(r => r.status !== 'DRAFT' || r.createdByMemberId === actor.id).map(r => ({ id: r.id, locationId: r.locationId, memberId: r.createdByMemberId, memberName: name(r.creator.user), avatarUrl: mediaUrl(r.creator.user.avatarFileId), campaignId: r.campaignId, status: r.status, startDate: r.startDate?.toISOString().slice(0, 10), endDate: r.endDate?.toISOString().slice(0, 10), currentStartDate: (r.absence?.startDate ?? r.startDate)?.toISOString().slice(0, 10), currentEndDate: (r.absence?.endDate ?? r.endDate)?.toISOString().slice(0, 10), cancelled: !!r.absence?.cancelledAt, days: r.startDate && r.endDate ? vacationDays(r.startDate.toISOString().slice(0, 10), r.endDate.toISOString().slice(0, 10)) : 0 })),
    standardDays: actor.organization.vacationStandardDays, holidays: actor.organization.vacationHolidays, enabled: !!await prisma.requestType.findFirst({ where: { organizationId: org, systemCode: 'VACATION', isActive: true } }),
  }
}
export async function createCampaign(userId:string,org:string,data:z.infer<typeof campaignBody>){
  const actor=await getMembership(userId,org);requirePermission(actor,'vacations.collect',data.locationId)
  if(new Date(data.dueAt)<=new Date())throw new ApiError(400,'DEADLINE_PAST','Срок ответа должен быть в будущем.')
  return prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${org},1))::text`
    if(!await tx.requestType.findFirst({where:{organizationId:org,systemCode:'VACATION',isActive:true}}))throw new ApiError(409,'VACATIONS_DISABLED','Новая подача отпусков отключена.')
    if(data.locationId&&!await tx.organizationLocation.findFirst({where:{organizationId:org,id:data.locationId,archivedAt:null}}))throw new ApiError(400,'LOCATION_NOT_FOUND','Точка недоступна.')
    const memberIds=[...new Set(data.memberIds)],members=await tx.organizationMember.findMany({where:{organizationId:org,id:{in:memberIds},leftAt:null,user:{deletedAt:null},...(data.locationId?{locationMemberships:{some:{locationId:data.locationId,leftAt:null}}}:{})}})
    if(members.length!==memberIds.length)throw new ApiError(400,'INVALID_MEMBERS','Проверьте сотрудников и область сбора.')
    const campaign=await tx.vacationCampaign.create({data:{...data,dueAt:new Date(data.dueAt),memberIds,organizationId:org,createdByMemberId:actor.id}})
    await publishRequestNotices(tx, members.map(m=>({organizationId:org,userId:m.userId,type:'REQUEST_VACATION_COLLECTION',vacationCampaignId:campaign.id,title:'Выберите даты отпуска',message:`${data.title}. Ответьте до ${data.dueAt.slice(0,10)}.`})))
    return campaign
  })
}
export async function answerCampaign(userId:string,org:string,id:string,input:z.infer<typeof vacationResponseBody>){
  const actor=await getMembership(userId,org),memberId=input.memberId??actor.id
  return prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${org},1))::text`
    const campaign=await tx.vacationCampaign.findFirst({where:{id,organizationId:org}})
    if(!campaign||!campaign.memberIds.includes(memberId))throw new ApiError(404,'CAMPAIGN_NOT_FOUND','Сбор недоступен.')
    if(campaign.closedAt)throw new ApiError(409,'CAMPAIGN_CLOSED','Сбор закрыт. Используйте индивидуальное обращение.')
    if(memberId!==actor.id)requirePermission(actor,'requests.onBehalf',campaign.locationId);else requirePermission(actor,'requests.create')
    const member=await tx.organizationMember.findFirst({where:{id:memberId,organizationId:org,leftAt:null},include:{locationMemberships:{where:{leftAt:null,location:{archivedAt:null}}}}})
    const locationId=campaign.locationId??member?.locationMemberships[0]?.locationId
    if(!member||!locationId)throw new ApiError(409,'MEMBER_UNAVAILABLE','Сотрудник должен состоять в действующей точке.')
    if(memberId!==actor.id)requirePermission(actor,'requests.onBehalf',locationId)
    const type=await tx.requestType.findFirst({where:{organizationId:org,systemCode:'VACATION',isActive:true}})
    if(!type)throw new ApiError(409,'VACATIONS_DISABLED','Новая подача отпусков отключена.')
    const existing=await tx.organizationRequest.findMany({where:{organizationId:org,submissionKey:{startsWith:input.submissionKey+':'},campaignId:id,createdByMemberId:memberId,authorMemberId:actor.id},orderBy:{startDate:'asc'}});if(existing.length)return existing
    const periods=[...input.periods].sort((a,b)=>a.startDate.localeCompare(b.startDate))
    if(periods.some((p,i)=>Number(p.startDate.slice(0,4))!==campaign.year||!vacationDays(p.startDate,p.endDate)||i>0&&periods[i-1].endDate>=p.startDate))throw new ApiError(400,'INVALID_PERIODS','Периоды должны начинаться в году сбора и не пересекаться.')
    if(await tx.organizationRequest.count({where:{organizationId:org,campaignId:id,createdByMemberId:memberId,status:{in:['PENDING','APPROVED','RETURNED']}}}))throw new ApiError(409,'ALREADY_ANSWERED','Ответ уже сохранён. Изменяйте периоды через их карточки.')
    const reviewers = await ensureReviewers(tx,{organizationId:org,locationId,createdByMemberId:memberId,formSnapshot:definitionOf(type.definition),approvalStep:0,systemCodeSnapshot:'VACATION'})
    const result=[]
    for(let i=0;i<periods.length;i++){const p=periods[i],request=await tx.organizationRequest.create({data:{organizationId:org,locationId,createdByMemberId:memberId,authorMemberId:actor.id,submissionKey:input.submissionKey+':'+i,requestTypeId:type.id,typeNameSnapshot:type.name,systemCodeSnapshot:'VACATION',formSnapshot:definitionOf(type.definition),campaignId:id,startDate:new Date(p.startDate),endDate:new Date(p.endDate),comment:input.comment,dueAt:new Date(Date.now()+7*86400000)}});await notifyStage(tx,request,reviewers);await tx.requestEvent.create({data:{requestId:request.id,actorMemberId:actor.id,type:'SUBMITTED',changes:{periods:JSON.parse(JSON.stringify(input.periods))}}});result.push(request)}return result
  },{isolationLevel:'Serializable'})
}
export async function closeCampaign(userId:string,org:string,id:string){const actor=await getMembership(userId,org),c=await prisma.vacationCampaign.findFirst({where:{id,organizationId:org}});if(!c)throw new ApiError(404,'CAMPAIGN_NOT_FOUND','Сбор не найден.');requirePermission(actor,'vacations.collect',c.locationId);return prisma.vacationCampaign.update({where:{id},data:{closedAt:new Date()}})}
export async function vacationWarnings(userId:string,org:string,start:string,end:string,memberId?:string){
  const actor=await getMembership(userId,org);requirePermission(actor,'requests.own')
  const target=memberId??actor.id
  if(target!==actor.id){requirePermission(actor,'requests.onBehalf');if(!await prisma.organizationMember.findFirst({where:{id:target,organizationId:org,leftAt:null,locationMemberships:{some:{locationId:actor.locationId,leftAt:null}}}}))throw new ApiError(404,'MEMBER_NOT_FOUND','Сотрудник недоступен.')}
  const total=await prisma.employeeAbsence.count({where:{organizationId:org,type:'VACATION',cancelledAt:null,memberId:{not:target},member:{locationMemberships:{some:{locationId:actor.locationId,leftAt:null}}},startDate:{lte:new Date(end)},endDate:{gte:new Date(start)}}})
  const shifts=await prisma.workShift.count({where:{organizationId:org,memberId:target,status:'SCHEDULED',scheduledStartAt:{lt:startOfZonedDate(addCalendarDays(end,1),actor.organization.timezone)},scheduledEndAt:{gt:startOfZonedDate(start,actor.organization.timezone)}}})
  return {days:vacationDays(start,end,actor.organization.vacationHolidays),otherEmployees:total,shifts}
}

export const vacationSettingsBody=z.object({standardDays:z.number().int().min(28).max(366),holidays:z.array(date).max(100).default([])})
export async function vacationSettings(userId:string,org:string,input?:z.infer<typeof vacationSettingsBody>){const actor=await getMembership(userId,org);if(input){requirePermission(actor,'requestTypes.manage',null);await prisma.organization.update({where:{id:org},data:{vacationStandardDays:input.standardDays,vacationHolidays:[...new Set(input.holidays)]}});return input}return {standardDays:actor.organization.vacationStandardDays,holidays:actor.organization.vacationHolidays}}
