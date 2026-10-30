import assert from 'node:assert/strict'
import { before, after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization as createOrganization } from '../support/business-organization.ts'
import { stageStoredFile, deletePendingFile } from '../../src/server/storage/image-service.ts'
import { enqueueExport, claimReportExport } from '../../src/server/schedule/reports/export-jobs.ts'
import { claimEmailDelivery, enqueueEmail } from '../../src/server/mail/email-outbox.ts'
import { organizationResources } from '../../src/server/resources/quotas.ts'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'

const tenants:Array<{id:string;userId:string;point:string}>=[], users:string[]=[]
const code=(c:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code===c
const budget=(id:string)=>prisma.organizationResourceBudget.findUniqueOrThrow({where:{organizationId:id}})
const input=(point:string,day=1)=>({from:`2038-01-${String(day).padStart(2,'0')}`,to:`2038-01-${String(day).padStart(2,'0')}`,locationIds:[point],memberIds:[],includeFormer:false,config:defaultReportConfig()})
before(async()=>{
 await prisma.emailDelivery.deleteMany()
 for(let i=0;i<2;i++) {
  const user=await prisma.user.create({data:{email:`quota-${randomUUID()}@example.test`,passwordHash:'test',emailVerifiedAt:new Date(),emailNotificationsEnabled:true,emailNotificationCategories:{documents:true}}});users.push(user.id)
  const org=await createOrganization(user.id,{name:'Quota tenant',description:null,timezone:'Europe/Moscow'})
  tenants.push({id:org.id,userId:user.id,point:org.locationId})
 }
})
after(async()=>{
 try {
  const ids=tenants.map(t=>t.id)
  const files=await prisma.storedFile.findMany({where:{organizationId:{in:ids}},select:{id:true}})
  await prisma.storedFile.updateMany({where:{id:{in:files.map(f=>f.id)}},data:{pendingDeletionAt:new Date()}})
  for(const file of files)await deletePendingFile(file.id)
  await prisma.emailDelivery.deleteMany({where:{userId:{in:users}}})
  await prisma.organizationEvent.deleteMany({where:{organizationId:{in:ids}}})
  await prisma.documentFolder.deleteMany({where:{organizationId:{in:ids}}})
  await prisma.organization.deleteMany({where:{id:{in:ids}}})
  await prisma.user.deleteMany({where:{id:{in:users}}})
 }finally{await prisma.$disconnect()}
})
it('reserves storage atomically across concurrent uploads and isolates tenant capacity',async()=>{
 const [a,b]=tenants
 await prisma.organizationResourceBudget.update({where:{organizationId:a.id},data:{storageLimitBytes:100}})
 const upload=(t:typeof a)=>stageStoredFile({objectKey:`organizations/${t.id}/documents/${randomUUID()}.txt`,organizationId:t.id,uploadedByUserId:t.userId,purpose:'DOCUMENT',size:10,mimeType:'text/plain',checksumSha256:'0'.repeat(64)},Buffer.alloc(10))
 const results=await Promise.allSettled(Array.from({length:25},()=>upload(a)))
 assert.equal(results.filter(r=>r.status==='fulfilled').length,10)
 for(const result of results)if(result.status==='rejected')assert.ok(code('ORGANIZATION_STORAGE_QUOTA')(result.reason),String(result.reason))
 assert.equal((await budget(a.id)).storageBytes,100n)
 assert.equal((await upload(b)).size,10)
 const file=results.find(r=>r.status==='fulfilled')!;assert.equal(file.status,'fulfilled');if(file.status!=='fulfilled')return
 assert.equal(await deletePendingFile(file.value.id,async()=>{throw new Error('Synthetic delete failure')}),false)
 assert.equal((await budget(a.id)).storageBytes,100n)
 await assert.rejects(upload(a),code('ORGANIZATION_STORAGE_QUOTA'))
 assert.equal(await deletePendingFile(file.value.id),true)
 assert.equal((await budget(a.id)).storageBytes,90n)
 await upload(a);assert.equal((await budget(a.id)).storageBytes,100n)
 const usage=await organizationResources(a.userId,a.id);assert.equal(usage.storage.usedBytes,100)
 await assert.rejects(organizationResources(b.userId,a.id),code('ORGANIZATION_NOT_FOUND'))
})
it('rolls back byte reservations and prevents metadata growth from bypassing the quota',async()=>{
 const [a,b]=tenants,before=(await budget(b.id)).storageBytes
 await assert.rejects(prisma.$transaction(async tx=>{
   await tx.storedFile.create({data:{objectKey:`organizations/${b.id}/documents/${randomUUID()}.txt`,organizationId:b.id,uploadedByUserId:b.userId,purpose:'DOCUMENT',size:11,mimeType:'text/plain',checksumSha256:'0'.repeat(64)}})
   throw new Error('rollback')
 }),/rollback/)
 assert.equal((await budget(b.id)).storageBytes,before)
 const file=await prisma.storedFile.findFirstOrThrow({where:{organizationId:a.id}})
 await assert.rejects(prisma.storedFile.update({where:{id:file.id},data:{size:20}}))
 assert.equal((await budget(a.id)).storageBytes,100n)
})
it('shares export queue/rate limits across users, preserves idempotency and leaves the other tenant available',async()=>{
 const [a,b]=tenants
 await prisma.organizationResourceBudget.update({where:{organizationId:a.id},data:{exportQueueLimit:2,exportHourLimit:3}})
 const additional=await prisma.user.create({data:{email:`quota-extra-${randomUUID()}@example.test`,passwordHash:'test',emailVerifiedAt:new Date()}});users.push(additional.id)
 const role=await prisma.accessRole.create({data:{organizationId:a.id,name:'Exporter',permissions:['reports.export']}})
 await prisma.organizationMember.create({data:{organizationId:a.id,userId:additional.id,accessConfigured:true,accessRoleId:role.id}})
 await enqueueExport(a.userId,a.id,input(a.point,1))
 const calls=await Promise.allSettled([enqueueExport(additional.id,a.id,input(a.point,2)),enqueueExport(additional.id,a.id,input(a.point,3))])
 assert.equal(calls.filter(r=>r.status==='fulfilled').length,1)
 const failed=calls.find(r=>r.status==='rejected');assert.ok(failed?.status==='rejected'&&code('ORGANIZATION_EXPORT_QUEUE')(failed.reason))
 const job=await prisma.reportExport.findFirstOrThrow({where:{organizationId:a.id,userId:a.userId}})
 assert.equal((await enqueueExport(a.userId,a.id,input(a.point,1))).id,job.id)
 assert.equal((await budget(a.id)).exportWindowCount,2)
 await prisma.reportExport.deleteMany({where:{organizationId:a.id}})
 await enqueueExport(a.userId,a.id,input(a.point,4))
 await prisma.reportExport.deleteMany({where:{organizationId:a.id}})
 await assert.rejects(enqueueExport(additional.id,a.id,input(a.point,5)),code('ORGANIZATION_EXPORT_RATE'))
 assert.equal((await budget(a.id)).exportWindowCount,3)
 await enqueueExport(b.userId,b.id,input(b.point))
 await prisma.organizationResourceBudget.update({where:{organizationId:a.id},data:{exportWindowStart:new Date(Date.now()-3601000)}})
 await enqueueExport(a.userId,a.id,input(a.point,6));assert.equal((await budget(a.id)).exportWindowCount,1)
})
it('claims at most one export per tenant across workers and recovers an expired lease',async()=>{
 const [a,b]=tenants
 await prisma.reportExport.deleteMany({where:{organizationId:{in:[a.id,b.id]}}})
 for(const t of tenants)for(let i=1;i<=2;i++)await enqueueExport(t.userId,t.id,input(t.point,i))
 const claims=await Promise.all(Array.from({length:6},()=>claimReportExport(randomUUID())))
 const active=claims.filter(r=>r!==null)
 assert.equal(active.length,2);assert.equal(new Set(active.map(j=>j.organizationId)).size,2)
 const old=active.find(j=>j.organizationId===a.id)!
 await prisma.reportExport.update({where:{id:old.id},data:{leaseUntil:new Date(Date.now()-1)}})
 const recovered=await claimReportExport(randomUUID());assert.ok(recovered);assert.equal(recovered.organizationId,a.id)
 const running=await prisma.reportExport.count({where:{organizationId:a.id,status:'RUNNING',leaseUntil:{gt:new Date()}}});assert.equal(running,1)
 await prisma.reportExport.updateMany({where:{id:{in:active.map(j=>j.id)}},data:{status:'READY',leaseUntil:null}})
})
it('caps optional email backlog without rolling back notifications; duplicates do not leak reservations',async()=>{
 const [a,b]=tenants
 await prisma.organizationResourceBudget.update({where:{organizationId:a.id},data:{emailQueueLimit:2,emailMinuteLimit:1}})
 const data={userId:a.userId,organizationId:a.id,sourceKey:`quota:${randomUUID()}`,sourceKind:'DOCUMENT_REMINDER',category:'documents' as const}
 await Promise.all(Array.from({length:10},()=>enqueueEmail(prisma,data)))
 assert.equal((await budget(a.id)).pendingEmails,1)
 for(let i=0;i<4;i++)await enqueueEmail(prisma,{...data,sourceKey:`quota:${randomUUID()}`})
 assert.equal(await prisma.emailDelivery.count({where:{organizationId:a.id,status:'PENDING'}}),2)
 assert.equal((await budget(a.id)).pendingEmails,2)
 assert.equal(await prisma.emailDelivery.count({where:{organizationId:a.id,status:'SKIPPED',skipReason:'ORGANIZATION_QUEUE_QUOTA'}}),3)
 await enqueueEmail(prisma,{...data,userId:b.userId,organizationId:b.id,sourceKey:`quota:${randomUUID()}`})
 const message=await prisma.accountNotification.create({data:{organizationId:a.id,userId:a.userId,type:'DOCUMENT_ASSIGNED',title:'Quota does not lose in-app event',message:'Test'}})
 assert.ok(await prisma.accountNotification.findUnique({where:{id:message.id}}))
 assert.equal((await budget(a.id)).pendingEmails,2)
})
it('enforces shared mail rate and leases, rotates tenants, and keeps security mail outside tenant quotas',async()=>{
 const [a,b]=tenants,now=new Date()
 const first=await claimEmailDelivery(now),second=await claimEmailDelivery(now)
 assert.ok(first&&second);assert.notEqual(first.organizationId,second.organizationId)
 assert.equal(await claimEmailDelivery(now),null)
 await prisma.emailDelivery.updateMany({where:{id:{in:[first.id,second.id]}},data:{status:'SENT',lockedUntil:null}})
 assert.equal((await budget(a.id)).pendingEmails,1)
 assert.equal(await claimEmailDelivery(now),null) // the second A job is rate limited
 await enqueueEmail(prisma,{userId:a.userId,sourceKey:`security:${randomUUID()}`,sourceKind:'MANDATORY',content:{title:'Security',intro:'Test'}})
 const security=await claimEmailDelivery(new Date(Date.now()+10));assert.ok(security);assert.equal(security.category,null)
 const later=await claimEmailDelivery(new Date(+now+61000));assert.ok(later);assert.equal(later.organizationId,a.id)
 await prisma.emailDelivery.deleteMany({where:{organizationId:{in:[a.id,b.id]}}})
 assert.equal((await budget(a.id)).pendingEmails,0);assert.equal((await budget(b.id)).pendingEmails,0)
})

it('bounds reminder production per tenant and advances beyond the first batch without starving a smaller tenant',async()=>{
 const {scheduleEmailReminders}=await import('../../src/server/mail/email-worker.ts')
 const [a,b]=tenants,now=new Date(),dueAt=new Date(+now+3600000)
 await prisma.emailDelivery.deleteMany({where:{organizationId:{in:[a.id,b.id]}}})
 await prisma.organizationResourceBudget.updateMany({where:{organizationId:{in:[a.id,b.id]}},data:{emailQueueLimit:100}})
 for(const [t,n] of [[a,30],[b,2]] as const) {
  await prisma.user.update({where:{id:t.userId},data:{emailNotificationCategories:{vacationCollection:true}}})
  const member=await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:t.id,userId:t.userId}}})
  await prisma.vacationCampaign.createMany({data:Array.from({length:n},()=>({organizationId:t.id,createdByMemberId:member.id,title:'Quota reminder',year:now.getUTCFullYear(),dueAt,memberIds:[member.id]}))})
 }
 await scheduleEmailReminders(now)
 assert.equal(await prisma.emailDelivery.count({where:{organizationId:a.id}}),25)
 assert.equal(await prisma.emailDelivery.count({where:{organizationId:b.id}}),2)
 await scheduleEmailReminders(now)
 assert.equal(await prisma.emailDelivery.count({where:{organizationId:a.id}}),30)
 await scheduleEmailReminders(now)
 assert.equal(await prisma.emailDelivery.count({where:{organizationId:a.id}}),30)
})
it('limits event maintenance per tenant and processes another tenant in the same pass',async()=>{
 const {deliverEventStarts}=await import('../../src/server/events/service.ts')
 const [a,b]=tenants,now=new Date(),startAt=new Date(+now-20*60000)
 for(const [t,n] of [[a,30],[b,2]] as const) {
  const member=await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:t.id,userId:t.userId}}})
  await prisma.organizationEvent.createMany({data:Array.from({length:n},()=>({organizationId:t.id,createdByMemberId:member.id,updatedByMemberId:member.id,title:'Quota event',startAt,timezone:'Europe/Moscow',shared:true,audienceMode:'ALL' as const}))})
 }
 await deliverEventStarts(now)
 assert.equal(await prisma.organizationEvent.count({where:{organizationId:a.id,startNotifiedAt:{not:null}}}),10)
 assert.equal(await prisma.organizationEvent.count({where:{organizationId:b.id,startNotifiedAt:{not:null}}}),2)
 await deliverEventStarts(now)
 assert.equal(await prisma.organizationEvent.count({where:{organizationId:a.id,startNotifiedAt:{not:null}}}),20)
})
