import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createEmailInvitation, previewEmailInvitation, resendEmailInvitation } from '../../src/server/organizations/invitation-service.ts'
import { createBusinessOrganization as createOrganization } from '../support/business-organization.ts'
import { getEmailPreferences, saveEmailPreferences, emailPreferencesBody } from '../../src/server/mail/email-preferences.ts'
import { defaultEmailCategories } from '../../src/app/notifications/email-preferences.ts'
import { enqueueEmail, passwordChangedEmail, processEmailDeliveries } from '../../src/server/mail/email-outbox.ts'
import { buildDeliveryContent } from '../../src/server/mail/email-content.ts'
import { scheduleEmailReminders } from '../../src/server/mail/email-worker.ts'
import { recordShiftNotification } from '../../src/server/organizations/notification-service.ts'
import { createEvent } from '../../src/server/events/service.ts'
import { eventBody } from '../../src/server/events/schemas.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { addDays, zonedDateAndTime } from '../../src/app/schedule/date-utils.ts'

let owner: string, employee: string, standalone: string, org: string, other: string, location: string, member: string, ownerMember: string
const ids: string[] = [], orgs: string[] = []
const code = (value: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === value
const send = async () => {}
async function configure(userId: string, categories: Record<string, boolean>, enabled = true) { const current = await getEmailPreferences(userId); return saveEmailPreferences(userId, { enabled, categories, revision: current.revision, confirmDisable: true }) }
async function shift(offset = 4) {
  return prisma.workShift.create({ data: { organizationId: org, locationId: location, memberId: member, createdByMemberId: ownerMember, scheduledStartAt: new Date(Date.now()+offset*3600_000), scheduledEndAt: new Date(Date.now()+(offset+1)*3600_000) }, include: { member: true } })
}
async function notice(type: 'SHIFT_ASSIGNED'|'SHIFT_CHANGED'|'SHIFT_CANCELLED', s: Awaited<ReturnType<typeof shift>>) { return prisma.$transaction(tx=>recordShiftNotification(tx,s,type,'Europe/Moscow')) }
async function ready() { await prisma.emailDelivery.updateMany({where:{userId:{in:ids},status:'PENDING'},data:{availableAt:new Date(0)}}) }

before(async()=>{
  for (let i=0;i<3;i++) { const u=await prisma.user.create({data:{email:`mail-qa-${randomUUID()}@example.test`,passwordHash:'test-only',emailVerifiedAt:new Date()}});ids.push(u.id) }
  ;[owner,employee,standalone]=ids
  const a=await createOrganization(owner,{name:'Mail tests',description:null,timezone:'Europe/Moscow'}),b=await createOrganization(owner,{name:'Other mail tests',description:null,timezone:'Europe/Moscow'})
  org=a.id;other=b.id;location=a.locationId;orgs.push(org,other)
  await prisma.organization.update({where:{id:org},data:{discussionEnabled:true}})
  ownerMember=(await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:org,userId:owner}}})).id
  const m=await prisma.organizationMember.create({data:{organizationId:org,userId:employee,role:'MEMBER'}});member=m.id
  await prisma.locationMember.create({data:{organizationId:org,locationId:location,memberId:member,role:'MEMBER'}})
})
beforeEach(async()=>{
  // Sequential suites share the dedicated test DB; earlier suites do not run a mail worker.
  await prisma.emailDelivery.deleteMany()
  await prisma.user.updateMany({where:{id:{in:ids}},data:{emailNotificationsEnabled:false,emailNotificationCategories:{},emailPreferencesRevision:0}})
})
after(async()=>{
  const where={organizationId:{in:orgs}}
  await prisma.accountNotification.deleteMany({where})
  await prisma.shiftOffer.deleteMany({where})
  await prisma.organizationRequest.deleteMany({where})
  await prisma.organizationEvent.deleteMany({where})
  await prisma.documentAcknowledgement.deleteMany({where:{document:{organizationId:{in:orgs}}}})
  await prisma.document.deleteMany({where})
  await prisma.scheduleDraft.deleteMany({where})
  await prisma.vacationCampaign.deleteMany({where})
  await prisma.workShift.deleteMany({where})
  await prisma.employeeAbsence.deleteMany({where})
  await prisma.documentFolder.deleteMany({where})
  await prisma.organization.deleteMany({where:{id:{in:orgs}}})
  await prisma.user.deleteMany({where:{id:{in:ids}}})
  await prisma.$disconnect()
})

describe('personal email choices and delivery', {concurrency:false},()=>{
  it('enables main employee categories for a new account without changing existing opt-outs',async()=>{
    const fresh=await prisma.user.create({data:{email:`mail-defaults-${randomUUID()}@example.test`,passwordHash:'test-only',emailVerifiedAt:new Date()}});ids.push(fresh.id)
    const defaults=await getEmailPreferences(fresh.id)
    assert.equal(defaults.enabled,true);assert.deepEqual(defaults.categories,defaultEmailCategories())
    assert.equal(Object.values(defaults.categories).filter(Boolean).length,7)
    assert.equal(defaults.categories.vacationCollection,false);assert.equal(defaults.categories.urgentAbsences,false);assert.equal(defaults.categories.actionDigest,false)
    assert.equal(defaults.availableCategories.includes('actionDigest'),false)
    for (const userId of [owner,employee,standalone]) { const p=await getEmailPreferences(userId);assert.equal(p.enabled,false);assert.ok(Object.values(p.categories).every(value=>!value)) }
    const p=await configure(standalone,{shiftChanges:true});assert.equal(p.enabled,true);assert.equal(p.categories.shiftChanges,true);assert.equal(p.availableCategories.includes('actionDigest'),false)
    assert.equal(emailPreferencesBody.safeParse({revision:0,categories:{security:false}}).success,false)
    assert.equal(emailPreferencesBody.safeParse({revision:0,userId:owner,enabled:true}).success,false)
    await assert.rejects(()=>configure(standalone,{actionDigest:true}),code('EMAIL_CATEGORY_UNAVAILABLE'))
  })
  it('requires confirmation, retains categories and never resurrects queued mail after re-enable',async()=>{
    const p=await configure(employee,{shiftChanges:true,documents:true})
    await assert.rejects(()=>saveEmailPreferences(employee,{enabled:false,revision:p.revision}),code('EMAIL_DISABLE_CONFIRMATION'))
    const s=await shift();await notice('SHIFT_ASSIGNED',s)
    assert.equal(await prisma.emailDelivery.count({where:{userId:employee,status:'PENDING'}}),1)
    const off=await saveEmailPreferences(employee,{enabled:false,revision:p.revision,confirmDisable:true})
    assert.equal(off.categories.shiftChanges,true);assert.equal(off.categories.documents,true)
    const on=await saveEmailPreferences(employee,{enabled:true,revision:off.revision})
    assert.equal(on.categories.shiftChanges,true)
    assert.equal(await prisma.emailDelivery.count({where:{userId:employee,status:'PENDING'}}),0)
  })
  it('uses one account preference across organizations and prevents lost updates',async()=>{
    const p=await configure(owner,{requestResults:true})
    await prisma.accountNotification.createMany({data:[org,other].map(organizationId=>({organizationId,userId:owner,type:'REQUEST_APPROVED' as const,title:'Approved',message:'Test'}))})
    assert.equal(await prisma.emailDelivery.count({where:{userId:owner}}),2)
    await assert.rejects(()=>saveEmailPreferences(owner,{enabled:false,confirmDisable:true,revision:p.revision-1}),code('EMAIL_PREFERENCES_CHANGED'))
    assert.equal((await getEmailPreferences(owner)).enabled,true)
  })
  it('does not queue history or unselected categories, even after later opt-in',async()=>{
    const s=await shift(6);await notice('SHIFT_ASSIGNED',s)
    assert.equal(await prisma.emailDelivery.count({where:{userId:employee}}),0)
    await configure(employee,{documents:true})
    await notice('SHIFT_CHANGED',s)
    await configure(employee,{shiftChanges:true})
    assert.equal(await prisma.emailDelivery.count({where:{userId:employee}}),0)
  })
  it('rolls mail back with a failed business transaction',async()=>{
    await configure(employee,{shiftChanges:true})
    const s=await shift(8)
    await assert.rejects(()=>prisma.$transaction(async tx=>{await recordShiftNotification(tx,s,'SHIFT_ASSIGNED','Europe/Moscow');throw new Error('rollback')}),/rollback/)
    assert.equal(await prisma.emailDelivery.count({where:{userId:employee}}),0)
  })
  it('queues every shift event immediately without coalescing or a cooldown',async()=>{
    await configure(employee,{shiftChanges:true})
    const s=await shift(10),otherShift=await shift(12)
    await notice('SHIFT_ASSIGNED',s);await notice('SHIFT_CHANGED',s);await notice('SHIFT_CANCELLED',s);await notice('SHIFT_ASSIGNED',otherShift)
    const queued=await prisma.$queryRaw<Array<{ready:boolean}>>`SELECT available_at<=CURRENT_TIMESTAMP AS ready FROM email_deliveries WHERE user_id=${employee}::uuid AND status='PENDING'`
    assert.equal(queued.length,4);assert.ok(queued.every(job=>job.ready))
    const messages:string[]=[]
    await processEmailDeliveries({send:async(_to,msg)=>{messages.push(msg.subject)}})
    assert.equal(messages.length,4);assert.ok(messages.some(m=>m.includes('отменена')));assert.ok(messages.some(m=>m.includes('назначена')));assert.ok(messages.some(m=>m.includes('изменена')))
    // Another cancellation in the same hour is not blocked.
    await notice('SHIFT_CANCELLED',otherShift);await ready();await processEmailDeliveries({send:async(_to,msg)=>{messages.push(msg.subject)}})
    assert.equal(messages.length,5)
  })
  it('drains more than thirty emails and accepts subsequent events in the same minute',async()=>{
    await configure(employee,{shiftChanges:true})
    const s=await shift(18)
    await prisma.accountNotification.createMany({data:Array.from({length:40},()=>({organizationId:org,userId:employee,shiftId:s.id,type:'SHIFT_ASSIGNED' as const,title:'Shift',message:'Test'}))})
    let sent=0
    assert.equal(await processEmailDeliveries({send:async()=>{sent++}}),40)
    assert.equal(sent,40)
    await notice('SHIFT_CHANGED',s);await notice('SHIFT_CANCELLED',s)
    assert.equal(await processEmailDeliveries({send:async()=>{sent++}}),2)
    assert.equal(sent,42)
  })
  it('delivers each manager request without daily or time-of-day restrictions and rechecks resolution',async()=>{
    await configure(owner,{actionDigest:true})
    const type=await prisma.requestType.findFirstOrThrow({where:{organizationId:org,systemCode:'DAY_OFF'}})
    const requests=[]
    for(let i=0;i<2;i++) {
      const request=await prisma.organizationRequest.create({data:{organizationId:org,locationId:location,createdByMemberId:member,requestTypeId:type.id,typeNameSnapshot:type.name,systemCodeSnapshot:'DAY_OFF'}})
      requests.push(request)
      await prisma.accountNotification.create({data:{organizationId:org,userId:owner,requestId:request.id,type:'REQUEST_CREATED',title:'New request',message:'Test'}})
    }
    const jobs=await prisma.emailDelivery.findMany({where:{userId:owner,category:'actionDigest'},orderBy:{eventOrder:'asc'}})
    assert.equal(jobs.length,2)
    const night=new Date();night.setUTCHours(22,0,0,0)
    for(const job of jobs)assert.ok((await buildDeliveryContent(job,night))?.title.includes('вашего решения'))
    await prisma.organizationRequest.update({where:{id:requests[0].id},data:{status:'APPROVED'}})
    assert.equal(await buildDeliveryContent(jobs[0],night),null)
    assert.ok(await buildDeliveryContent(jobs[1],night))
    let sent=0;await processEmailDeliveries({send:async()=>{sent++}});assert.equal(sent,1)
  })
  it('queues each closed draft for review and rejects stale drafts and recipients without permission',async()=>{
    await configure(owner,{actionDigest:true})
    await prisma.user.update({where:{id:employee},data:{emailNotificationsEnabled:true,emailNotificationCategories:{actionDigest:true}}})
    const draft=await prisma.scheduleDraft.create({data:{organizationId:org,locationId:location,authorMemberId:ownerMember,title:'Review graph',fromDate:new Date('2030-01-01'),toDate:new Date('2030-01-02'),timezone:'Europe/Moscow',status:'OPEN',publishedAt:new Date(),deadline:new Date()}})
    await prisma.scheduleDraft.update({where:{id:draft.id},data:{status:'CLOSED'}})
    const jobs=await prisma.emailDelivery.findMany({where:{sourceId:draft.id,sourceKind:'DRAFT_REVIEW'}})
    assert.equal(jobs.length,2)
    const ownerJob=jobs.find(job=>job.userId===owner)!,employeeJob=jobs.find(job=>job.userId===employee)!
    assert.ok((await buildDeliveryContent(ownerJob,new Date()))?.title.includes('вашего решения'))
    assert.equal(await buildDeliveryContent(employeeJob,new Date()),null)
    await prisma.scheduleDraft.update({where:{id:draft.id},data:{status:'OPEN',revision:{increment:1}}})
    assert.equal(await buildDeliveryContent(ownerJob,new Date()),null)
    await prisma.scheduleDraft.update({where:{id:draft.id},data:{status:'CLOSED'}})
    assert.equal(await prisma.emailDelivery.count({where:{sourceId:draft.id,sourceKind:'DRAFT_REVIEW',userId:owner}}),2)
    let sent=0;await processEmailDeliveries({send:async()=>{sent++}});assert.equal(sent,1)
  })
  it('notifies the independent reviewer for accepted shift offers and skips closed offers',async()=>{
    await configure(owner,{actionDigest:true})
    const u=await prisma.user.create({data:{email:`mail-offer-${randomUUID()}@example.test`,passwordHash:'test-only',emailVerifiedAt:new Date()}});ids.push(u.id)
    const acceptor=await prisma.organizationMember.create({data:{organizationId:org,userId:u.id}})
    const s=await shift(20)
    const offer=await prisma.shiftOffer.create({data:{organizationId:org,locationId:location,initiatorMemberId:member,acceptedByMemberId:acceptor.id,sourceShiftId:s.id,kind:'TRANSFER',mode:'APPROVAL',status:'AWAITING_APPROVAL',sourceSnapshot:{}}})
    const n=await prisma.accountNotification.create({data:{organizationId:org,userId:owner,shiftOfferId:offer.id,type:'SHIFT_OFFER_APPROVAL',title:'Approval',message:'Test'}})
    const job=await prisma.emailDelivery.findFirstOrThrow({where:{sourceId:n.id}})
    assert.equal(job.category,'actionDigest')
    assert.ok((await buildDeliveryContent(job,new Date()))?.title.includes('согласовать'))
    assert.equal(await buildDeliveryContent({...job,userId:employee},new Date()),null)
    await prisma.shiftOffer.update({where:{id:offer.id},data:{status:'COMPLETED'}})
    assert.equal(await buildDeliveryContent(job,new Date()),null)
  })
  it('rechecks opt-out and membership before actual delivery',async()=>{
    await configure(employee,{shiftChanges:true})
    const s=await shift(14);await notice('SHIFT_ASSIGNED',s);await ready()
    await prisma.organizationMember.update({where:{id:member},data:{leftAt:new Date()}})
    let sent=0
    await processEmailDeliveries({send:async()=>{sent++}})
    assert.equal(sent,0)
    await prisma.organizationMember.update({where:{id:member},data:{leftAt:null}})
    await notice('SHIFT_CHANGED',s);await ready()
    await prisma.user.update({where:{id:employee},data:{emailNotificationsEnabled:false}})
    await processEmailDeliveries({send:async()=>{sent++}});assert.equal(sent,0)
  })
  it('keeps mandatory mail enabled, persists retries and deduplicates concurrent workers',async()=>{
    await enqueueEmail(prisma,{userId:standalone,sourceKind:'MANDATORY',sourceKey:'mail-test:'+randomUUID(),content:passwordChangedEmail()})
    const failed=await prisma.emailDelivery.findFirstOrThrow({where:{userId:standalone}})
    await processEmailDeliveries({send:async()=>{throw new Error('SMTP temporary failure')}})
    const retry=await prisma.emailDelivery.findUniqueOrThrow({where:{id:failed.id}})
    assert.equal(retry.status,'PENDING');assert.equal(retry.attempts,1);assert.ok(retry.availableAt>failed.availableAt)
    await ready();let sent=0
    await Promise.all([processEmailDeliveries({send:async()=>{sent++;await new Promise(r=>setTimeout(r,20))}}),processEmailDeliveries({send:async()=>{sent++}})])
    assert.equal(sent,1);assert.equal((await prisma.emailDelivery.findUniqueOrThrow({where:{id:failed.id}})).status,'SENT')
  })
  it('uses absolute UTC availability and delivery times even in a non-UTC producer transaction',async()=>{
    const due=new Date(Date.now()+5000),key='timezone-test:'+randomUUID()
    await prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Tokyo'`
      await enqueueEmail(tx,{userId:standalone,sourceKind:'MANDATORY',sourceKey:key,content:passwordChangedEmail(),availableAt:due})
    })
    const [queued]=await prisma.$queryRaw<Array<{at:number}>>`SELECT extract(epoch FROM available_at)::float8*1000 AS at FROM email_deliveries WHERE source_key=${key}`
    assert.ok(Math.abs(queued.at-+due)<1)
    let sent=0
    assert.equal(await processEmailDeliveries({now:new Date(+due-1),send:async()=>{sent++}}),0)
    assert.equal(await processEmailDeliveries({now:due,send:async()=>{sent++}}),1)
    assert.equal(sent,1)
    const [delivered]=await prisma.$queryRaw<Array<{at:number}>>`SELECT extract(epoch FROM delivered_at)::float8*1000 AS at FROM email_deliveries WHERE source_key=${key}`
    assert.ok(Math.abs(delivered.at-+due)<1)
  })
  it('skips ordinary events, sends important ones only to actual recipients and rechecks revocation',async()=>{
    await configure(employee,{importantEvents:true})
    const at=<T>(fn:()=>Promise<T>)=>locationContext.run({organizationId:org,locationId:location},fn)
    const day=addDays(zonedDateAndTime(new Date().toISOString(),'Europe/Moscow').date,5)
    const input=(important:boolean)=>eventBody.parse({title:'Mail event',important,startDate:day,startTime:'10:00',shared:false,locationIds:[location],audienceMode:'SELECTED',memberIds:[member]})
    const ordinary=await at(()=>createEvent(owner,org,input(false)))
    const normalJob=await prisma.emailDelivery.findFirstOrThrow({where:{userId:employee,sourceId:(await prisma.accountNotification.findFirstOrThrow({where:{eventId:ordinary.id,userId:employee}})).id}})
    assert.equal(await buildDeliveryContent(normalJob,new Date()),null)
    const important=await at(()=>createEvent(owner,org,input(true)))
    const n=await prisma.accountNotification.findFirstOrThrow({where:{eventId:important.id,userId:employee}})
    const job=await prisma.emailDelivery.findFirstOrThrow({where:{sourceId:n.id}})
    assert.ok((await buildDeliveryContent(job,new Date()))?.title.includes('событие'))
    await prisma.eventRecipient.updateMany({where:{eventId:important.id,memberId:member},data:{removedAt:new Date()}})
    assert.equal(await buildDeliveryContent(job,new Date()),null)
  })
  it('creates only one reminder per deadline and stops after the participant answers',async()=>{
    await configure(employee,{scheduleDiscussion:true,vacationCollection:true})
    const now=new Date(),deadline=new Date(+now+20*3600_000)
    const draft=await prisma.scheduleDraft.create({data:{organizationId:org,locationId:location,authorMemberId:ownerMember,title:'Reminder graph',fromDate:new Date('2030-01-01'),toDate:new Date('2030-01-02'),timezone:'Europe/Moscow',status:'OPEN',publishedAt:now,deadline,recipients:{create:{memberId:member,requiredRevision:1}}}})
    await scheduleEmailReminders(now);await scheduleEmailReminders(now)
    const jobs=await prisma.emailDelivery.findMany({where:{sourceId:draft.id,sourceKind:'DRAFT_REMINDER'}})
    assert.equal(jobs.length,1);assert.ok(await buildDeliveryContent(jobs[0],now))
    await prisma.draftRecipient.update({where:{draftId_memberId:{draftId:draft.id,memberId:member}},data:{response:'NO_OBJECTIONS',respondedRevision:1}})
    assert.equal(await buildDeliveryContent(jobs[0],now),null)
    await processEmailDeliveries({send})
  })
  it('sends document reminders in the point timezone and skips acknowledged or late retries',async()=>{
    await configure(employee,{documents:true})
    const now=new Date('2032-02-10T20:30:00Z')
    await prisma.organizationLocation.update({where:{id:location},data:{timezone:'Asia/Vladivostok'}})
    const file=await prisma.storedFile.create({data:{objectKey:'mail-qa/'+randomUUID(),mimeType:'text/plain',size:0,checksumSha256:'0'.repeat(64),purpose:'DOCUMENT',uploadedByUserId:owner,organizationId:org}})
    const doc=await prisma.document.create({data:{organizationId:org,locationId:location,storedFileId:file.id,displayName:'Документ для ознакомления',fileName:'test.txt',visibility:'ORGANIZATION',uploadedByMemberId:ownerMember}})
    const ack=await prisma.documentAcknowledgement.create({data:{documentId:doc.id,memberId:member,assignedByMemberId:ownerMember,deadline:new Date('2032-02-12')}})
    await scheduleEmailReminders(now);await scheduleEmailReminders(now)
    const jobs=await prisma.emailDelivery.findMany({where:{sourceKind:'DOCUMENT_REMINDER',sourceId:ack.id}})
    assert.equal(jobs.length,1)
    assert.ok((await buildDeliveryContent(jobs[0],now))?.title.includes('срок'))
    assert.equal(await buildDeliveryContent(jobs[0],new Date(+now+86400_000)),null)
    await prisma.documentAcknowledgement.update({where:{id:ack.id},data:{acknowledgedAt:now}})
    assert.equal(await buildDeliveryContent(jobs[0],now),null)
    await prisma.organizationLocation.update({where:{id:location},data:{timezone:'Europe/Moscow'}})
  })
  it('builds one personal graph after application and rejects another member or organization',async()=>{
    await configure(employee,{publishedSchedule:true})
    const draft=await prisma.scheduleDraft.create({data:{organizationId:org,locationId:location,authorMemberId:ownerMember,title:'Applied graph',fromDate:new Date('2033-01-01'),toDate:new Date('2033-01-31'),timezone:'Europe/Moscow',status:'APPLIED',publishedAt:new Date()}})
    await enqueueEmail(prisma,{userId:employee,organizationId:org,sourceKind:'SCHEDULE',sourceId:draft.id,sourceKey:'schedule-test:'+draft.id,category:'publishedSchedule'})
    const job=await prisma.emailDelivery.findFirstOrThrow({where:{sourceId:draft.id,sourceKind:'SCHEDULE'}})
    const content=await buildDeliveryContent(job,new Date())
    assert.ok(content?.title.includes('график опубликован'));assert.ok(content?.action?.path.includes('view=mine'))
    assert.equal(await buildDeliveryContent({...job,userId:standalone},new Date()),null)
    assert.equal(await buildDeliveryContent({...job,organizationId:other},new Date()),null)
  })
  it('does not expose absence reasons in manager email and ignores unrelated shifts',async()=>{
    await configure(owner,{urgentAbsences:true})
    const s=await shift(16)
    const day=zonedDateAndTime(s.scheduledStartAt.toISOString(),'Europe/Moscow').date
    const absence=await prisma.employeeAbsence.create({data:{organizationId:org,memberId:member,type:'SICK',startDate:new Date(day),endDate:new Date(day),reason:'ILLNESS',comment:'Private health details'}})
    const n=await prisma.accountNotification.create({data:{organizationId:org,userId:owner,absenceId:absence.id,type:'ABSENCE_REPORTED',title:'Отсутствие',message:'Private health details'}})
    const job=await prisma.emailDelivery.findFirstOrThrow({where:{sourceId:n.id}})
    const content=await buildDeliveryContent(job,new Date())
    assert.ok(content?.title.includes('ближайшую смену'))
    assert.ok(!JSON.stringify(content).includes('Private health details'))
    assert.equal(await buildDeliveryContent({...job,userId:employee},new Date()),null)
    await prisma.employeeAbsence.update({where:{id:absence.id},data:{cancelledAt:new Date()}})
    assert.equal(await buildDeliveryContent(job,new Date()),null)
    await prisma.accountNotification.deleteMany({where:{absenceId:absence.id}})
    await prisma.employeeAbsence.delete({where:{id:absence.id}})
  })

  it('resends an active invitation without duplicate records and keeps tenant and expiry checks',async()=>{
    const user=await prisma.user.findUniqueOrThrow({where:{id:standalone}})
    const invite=await createEmailInvitation(owner,org,user.email)
    assert.ok(await previewEmailInvitation(user.email,invite.token))
    const resent=await resendEmailInvitation(owner,org,invite.invitation.id)
    assert.equal(+resent.expiresAt,+invite.invitation.expiresAt)
    assert.notEqual(resent.token,invite.token)
    await assert.rejects(()=>previewEmailInvitation(user.email,invite.token))
    assert.ok(await previewEmailInvitation(user.email,resent.token))
    await assert.rejects(()=>resendEmailInvitation(standalone,org,invite.invitation.id))
    await assert.rejects(()=>resendEmailInvitation(owner,other,invite.invitation.id))
    await prisma.organizationInvite.update({where:{id:invite.invitation.id},data:{expiresAt:new Date(0)}})
    await assert.rejects(()=>resendEmailInvitation(owner,org,invite.invitation.id))
  })

})
