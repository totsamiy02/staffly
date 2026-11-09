import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { subscriptionSnapshot } from '../../src/server/subscriptions/access.ts'
import { runServiceMaintenance,runBackupSchedule } from '../../src/server/admin/service/runner.ts'
import { deletePendingFile } from '../../src/server/storage/image-service.ts'
type Browser={userId:string;email:string;cookies:Map<string,string>;ready:()=>Promise<unknown>;request:(path:string,body?:unknown)=>Promise<Response>}
export function serviceLifecycleScenarios({account,db,codes,password,organizations}:{account:(admin?:boolean)=>Promise<Browser>;db:Pool;codes:Map<string,string>;password:string;organizations:string[]}){
 const root='/api/admin',suffix=randomUUID()
 async function json(browser:Browser,url:string,body?:unknown,status=200){const response=await browser.request(url,body);assert.equal(response.status,status,await response.clone().text());return response.json()}
 async function age(b:Browser){await db.query("UPDATE staffly_admin.action_challenges SET created_at=now()-interval '2 minutes',expires_at=now()+interval '1 minute' WHERE user_id=$1",[b.userId])}
 async function act(b:Browser,spec:unknown,status=200){await age(b);const ticket=await json(b,root+'/management/actions',{password,spec});const response=await b.request(root+'/management/actions/execute',{challengeId:ticket.challengeId,code:codes.get(b.email),confirm:true});assert.equal(response.status,status,await response.clone().text());return response.json()}
 async function org(b:Browser){const value=await createBusinessOrganization(b.userId,{name:'Service '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(value.id);return value}
 it('service routes deny ordinary users and locked administrative sessions',async()=>{
  const ordinary=await account(false),admin=await account(),id=randomUUID(),routes=['/service/accounts/'+ordinary.userId,'/service/organizations/'+id,'/service/maintenance','/service/cleanup','/service/cleanup/files','/service/queues','/service/content','/service/release/checks']
  for(const route of routes)assert.equal((await ordinary.request(root+route)).status,403)
  await admin.ready();await admin.request(root+'/lock',{});for(const route of routes)assert.equal((await admin.request(root+route)).status,423)
 })
 it('shows safe account state, pages ordinary sessions and revokes only the selected session',async()=>{
  const admin=await account(),target=await account(false);await admin.ready()
  const initial=await json(admin,root+'/service/accounts/'+target.userId);assert.equal(initial.state,'active');assert.equal(initial.total,1);assert(!JSON.stringify(initial).includes('refresh_token'));assert(!JSON.stringify(initial).includes('passwordHash'))
  const session=initial.sessions[0];await act(admin,{action:'USER_SESSION_REVOKE',targetId:session.id,payload:{reason:'Requested by the account owner',userId:target.userId,lastUsedAt:session.lastUsedAt}})
  assert.equal((await target.request('/api/auth/me')).status,401);assert.equal((await admin.request('/api/auth/me')).status,200)
  assert.equal((await json(admin,root+'/service/accounts/'+target.userId)).total,0)
 })
 it('rejects a session from another account and a stale session preview',async()=>{
  const admin=await account(),target=await account(false);await admin.ready();const state=await json(admin,root+'/service/accounts/'+target.userId),session=state.sessions[0]
  await json(admin,root+'/management/actions',{password,spec:{action:'USER_SESSION_REVOKE',targetId:session.id,payload:{reason:'Wrong account must not revoke',userId:admin.userId,lastUsedAt:session.lastUsedAt}}},409)
  await json(admin,root+'/management/actions',{password,spec:{action:'USER_SESSION_REVOKE',targetId:session.id,payload:{reason:'Stale snapshot must not revoke',userId:target.userId,lastUsedAt:new Date(0).toISOString()}}},409)
  assert.equal((await target.request('/api/auth/me')).status,200)
 })
 it('directs recovery without creating a reset code, changing a password or reviving a deleted account',async()=>{
  const admin=await account(),target=await account(false);await admin.ready();const state=await json(admin,root+'/service/accounts/'+target.userId),before=await prisma.user.findUniqueOrThrow({where:{id:target.userId}}),count=await prisma.passwordResetToken.count({where:{userId:target.userId}})
  const result=await act(admin,{action:'USER_RECOVERY',targetId:target.userId,payload:{reason:'Help requested by account owner',version:state.version}}),directory=await mkdtemp(path.join(os.tmpdir(),'service-recovery-'));let content:unknown
  try{const run=await runServiceMaintenance({managementUrl:process.env.DATABASE_URL!,directory,sendRecovery:async(email,message)=>{assert.equal(email,target.email);content=message}});assert.equal(run.status,'succeeded');assert.equal(run.jobId,result.resourceId);assert(content);assert(!JSON.stringify(content).includes('"code"'));assert.equal((content as {action:{path:string}}).action.path,'/forgot-password')}finally{await rm(directory,{recursive:true,force:true})}
  assert.equal((await prisma.user.findUniqueOrThrow({where:{id:target.userId}})).passwordHash,before.passwordHash);assert.equal(await prisma.passwordResetToken.count({where:{userId:target.userId}}),count)
  await prisma.user.update({where:{id:target.userId},data:{deletedAt:new Date()}});const deleted=await json(admin,root+'/service/accounts/'+target.userId);assert.equal(deleted.email,null);assert.equal(deleted.state,'deleting');assert.equal(deleted.sessions.length,0)
 })
 it('previews suspension consequences, enforces tenant writes and resumes without changing subscription dates',async()=>{
  const admin=await account();await admin.ready();const organization=await org(admin),initial=await json(admin,root+'/service/organizations/'+organization.id),before=await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:organization.id}})
  const spec={action:'ORG_STATE',targetId:organization.id,payload:{reason:'Investigating an organization incident',version:initial.version,state:'SUSPENDED',until:new Date(Date.now()+3600000).toISOString()}},preview=await json(admin,root+'/service/preview',spec);assert(preview.allowed);assert(preview.consequences.some((v:string)=>v.includes('Файлы')))
  await act(admin,spec);await assert.rejects(getMembership(admin.userId,organization.id),{code:'ORGANIZATION_SUSPENDED'})
  await assert.rejects(prisma.documentFolder.create({data:{organizationId:organization.id,name:'Must be blocked'}}))
  const state=await json(admin,root+'/service/organizations/'+organization.id);assert.equal(state.state,'SUSPENDED');assert.equal(state.history[0].reason,spec.payload.reason)
  await act(admin,{...spec,payload:{...spec.payload,version:state.version,state:'ACTIVE',until:null}});assert((await getMembership(admin.userId,organization.id)).owner)
  assert.equal(+(await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:organization.id}})).periodEnd!,+before.periodEnd!)
 })
 it('binds organization changes to the preview version and records an atomic failure rather than a duplicate action',async()=>{
  const admin=await account();await admin.ready();const organization=await org(admin),state=await json(admin,root+'/service/organizations/'+organization.id),spec={action:'ORG_STATE',targetId:organization.id,payload:{reason:'Concurrent support update',version:state.version,state:'SUSPENDED',until:null}},ticket=await json(admin,root+'/management/actions',{password,spec})
  await prisma.organization.update({where:{id:organization.id},data:{serviceRevision:{increment:1}}})
  await json(admin,root+'/management/actions/execute',{challengeId:ticket.challengeId,code:codes.get(admin.email),confirm:true},409)
  assert.equal((await json(admin,root+'/service/organizations/'+organization.id)).state,'ACTIVE')
  assert.equal((await db.query('SELECT count(*)::int n FROM staffly_admin.action_receipts WHERE challenge_id=$1',[ticket.challengeId])).rows[0].n,0)
 })
 it('changes temporary access and quotas without writing a purchase, then safely revokes the override',async()=>{
  const admin=await account();await admin.ready();const organization=await org(admin),state=await json(admin,root+'/service/organizations/'+organization.id),before=await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:organization.id}}),purchases=await prisma.subscriptionPurchase.count({where:{organizationId:organization.id}})
  await act(admin,{action:'PLAN_ADJUST',targetId:organization.id,payload:{reason:'Temporary support compensation',version:state.subscriptionVersion,plan:'TEAM',startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),revoke:false}})
  const snapshot=await subscriptionSnapshot(organization.id);assert.equal(snapshot.effectivePlan,'TEAM');assert.equal(snapshot.limits.members,25)
  const current=await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:organization.id}});assert.equal(current.plan,before.plan);assert.equal(+current.periodEnd!,+before.periodEnd!);assert.equal(await prisma.subscriptionPurchase.count({where:{organizationId:organization.id}}),purchases)
  await act(admin,{action:'PLAN_ADJUST',targetId:organization.id,payload:{reason:'Support compensation finished',version:current.revision,plan:null,startsAt:null,endsAt:null,revoke:true}});assert.equal((await subscriptionSnapshot(organization.id)).effectivePlan,'BUSINESS')
 })
 it('explains document and ancestor access from short account numbers without returning confidential document metadata',async()=>{
  const admin=await account(),member=await account(false);await admin.ready();const organization=await org(admin),owner=await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:organization.id,userId:admin.userId}}}),target=await prisma.organizationMember.create({data:{organizationId:organization.id,userId:member.userId,role:'MEMBER'}}),folder=await prisma.documentFolder.create({data:{organizationId:organization.id,name:'private-folder-'+suffix,visibility:'ADMINS'}}),file=await prisma.storedFile.create({data:{objectKey:'documents/'+randomUUID()+'.pdf',mimeType:'application/pdf',size:1,checksumSha256:'a'.repeat(64),purpose:'DOCUMENT',organizationId:organization.id,uploadedByUserId:admin.userId}}),doc=await prisma.document.create({data:{organizationId:organization.id,storedFileId:file.id,folderId:folder.id,displayName:'private-doc-'+suffix,fileName:'private-file-'+suffix+'.pdf',visibility:'ORGANIZATION',uploadedByMemberId:owner.id}}),user=await prisma.user.findUniqueOrThrow({where:{id:member.userId}})
  const result=await json(admin,root+'/service/access-diagnostic',{userId:String(user.publicId),organizationId:String(organization.publicId),action:'documents.view',documentId:doc.id});assert.equal(result.allowed,false);assert(result.steps.some((s:{key:string;allowed:boolean})=>s.key==='folder:'+folder.id&&!s.allowed));assert(!JSON.stringify(result).includes('private-doc'));assert(!JSON.stringify(result).includes('private-file'));assert(!JSON.stringify(result).includes('private-folder'))
  const own=await json(admin,root+'/service/access-diagnostic',{userId:admin.userId,organizationId:organization.id,action:'documents.view',documentId:doc.id});assert.equal(own.allowed,true);assert.equal(target.organizationId,organization.id)
 })
 it('handles a bounded mixed queue group, leaves security messages failed and reports each result',async()=>{
  const admin=await account();await admin.ready();const safe=await prisma.emailDelivery.create({data:{userId:admin.userId,sourceKey:'service-queue-'+randomUUID(),sourceKind:'DOCUMENT',category:'documents',status:'FAILED',attempts:1}}),security=await prisma.emailDelivery.create({data:{userId:admin.userId,sourceKey:'service-security-'+randomUUID(),sourceKind:'MANDATORY',status:'FAILED',attempts:1}}),refs=[{kind:'email',id:safe.id},{kind:'email',id:security.id}],preview=await json(admin,root+'/service/queues/preview',{jobs:refs,command:'retry'})
  assert.equal(preview[0].code,'OK');assert.equal(preview[1].code,'SECURITY_MESSAGE')
  const result=await act(admin,{action:'QUEUE_ACTION',payload:{reason:'Investigating notification delivery',command:'retry',jobs:preview.map((r:{kind:string;id:string;expectedStatus:string;expectedAttempts:number})=>({kind:r.kind,id:r.id,expectedStatus:r.expectedStatus,expectedAttempts:r.expectedAttempts}))}}),batch=await json(admin,root+'/service/batches/'+result.resourceId)
  assert.equal(batch.results[0].result,'OK');assert.equal(batch.results[0].currentStatus,'PENDING');assert.equal(batch.results[1].currentStatus,'FAILED');assert.equal(batch.results[1].result,'SECURITY_MESSAGE');assert.equal((await prisma.emailDelivery.findUniqueOrThrow({where:{id:security.id}})).status,'FAILED');assert.equal((await prisma.emailDelivery.findUniqueOrThrow({where:{id:safe.id}})).status,'PENDING')
 })
 it('cancels only pending non-security messages and records the cancellation transition',async()=>{
  const admin=await account();await admin.ready();const job=await prisma.emailDelivery.create({data:{userId:admin.userId,sourceKey:'service-cancel-'+randomUUID(),sourceKind:'DOCUMENT',category:'documents'}}),preview=await json(admin,root+'/service/queues/preview',{jobs:[{kind:'email',id:job.id}],command:'cancel'})
  await act(admin,{action:'QUEUE_ACTION',payload:{reason:'Notification no longer required',command:'cancel',jobs:preview.map((r:{kind:string;id:string;expectedStatus:string;expectedAttempts:number})=>({kind:r.kind,id:r.id,expectedStatus:r.expectedStatus,expectedAttempts:r.expectedAttempts}))}})
  assert.equal((await prisma.emailDelivery.findUniqueOrThrow({where:{id:job.id}})).status,'SKIPPED');const history=await json(admin,root+'/service/queues/email/'+job.id);assert.equal(history.history.at(-1).status,'SKIPPED')
 })
 it('holds a scheduled account cleanup with an owner and a reason without running the purge',async()=>{
  const admin=await account(),target=await account(false);await admin.ready();const deletion=await prisma.dataDeletion.create({data:{kind:'ACCOUNT',subjectId:target.userId,dueAt:new Date(Date.now()+31*86400000)}})
  await act(admin,{action:'CLEANUP_CONTROL',targetId:deletion.id,payload:{reason:'Waiting for retention review',version:0,ownerId:admin.userId,hold:true,retry:false}})
  const row=await prisma.dataDeletion.findUniqueOrThrow({where:{id:deletion.id}});assert.equal(row.hold,true);assert.equal(row.completedAt,null);assert.equal((await json(admin,root+'/service/cleanup?status=held&search='+deletion.id)).items[0].owner_id,admin.userId)
 })
 it('honors a file cleanup hold before object I/O and releases exactly the selected file',async()=>{
  const admin=await account();await admin.ready();const file=await prisma.storedFile.create({data:{objectKey:'avatars/'+randomUUID()+'.webp',mimeType:'image/webp',size:1,checksumSha256:'b'.repeat(64),purpose:'USER_AVATAR',uploadedByUserId:admin.userId,pendingDeletionAt:new Date()}})
  await act(admin,{action:'FILE_CLEANUP_CONTROL',targetId:file.id,payload:{reason:'File cleanup requires review',version:0,ownerId:admin.userId,hold:true,retry:false}})
  let removed=0;assert.equal(await deletePendingFile(file.id,async()=>{removed++}),false);assert.equal(removed,0)
  await act(admin,{action:'FILE_CLEANUP_CONTROL',targetId:file.id,payload:{reason:'File cleanup review completed',version:1,ownerId:admin.userId,hold:false,retry:false}});assert.equal(await deletePendingFile(file.id,async()=>{removed++}),true);assert.equal(removed,1)
 })
 it('keeps drafts private, requires a review and publishes an immutable revision with rollback history',async()=>{
  const admin=await account(),ordinary=await account(false);await admin.ready();const key='guide:service-'+suffix,body={key,kind:'guide',version:0,title:'Published service guide',body:'## Safe content\n\nVerified instructions.',metadata:{category:'account',audience:'everyone',summary:'Service guide'},effectiveAt:new Date(Date.now()-60000).toISOString()},saved=await json(admin,root+'/service/content',body)
  assert.equal(await json(ordinary,'/api/public/content/'+encodeURIComponent(key)),null)
  await json(admin,root+'/management/actions',{password,spec:{action:'CONTENT_PUBLISH',targetId:saved.revisionId,payload:{reason:'Reviewed public instructions',version:1,effectiveAt:body.effectiveAt}}},409)
  await json(admin,root+'/service/content/'+saved.revisionId+'/review',{confirm:true});await act(admin,{action:'CONTENT_PUBLISH',targetId:saved.revisionId,payload:{reason:'Reviewed public instructions',version:1,effectiveAt:body.effectiveAt}})
  assert.equal((await json(ordinary,'/api/public/content/'+encodeURIComponent(key))).body,body.body)
  await json(admin,root+'/service/content',{...body,version:2,body:'<script>bad</script>'},400)
  const next=await json(admin,root+'/service/content',{...body,version:2,title:'New guide revision',body:'New verified text.'});await json(admin,root+'/service/content/'+next.revisionId+'/review',{confirm:true});await act(admin,{action:'CONTENT_PUBLISH',targetId:next.revisionId,payload:{reason:'Updated public instructions',version:3,effectiveAt:body.effectiveAt}})
  await act(admin,{action:'CONTENT_PUBLISH',targetId:saved.revisionId,payload:{reason:'Restore previous checked version',version:4,effectiveAt:body.effectiveAt}});assert.equal((await json(ordinary,'/api/public/content/'+encodeURIComponent(key))).body,body.body)
  assert.equal((await json(admin,root+'/service/content?key='+encodeURIComponent(key))).publications.length,3)
 })
 it('plans maintenance notices and refuses to start work without the mandatory checks',async()=>{
  const admin=await account(),ordinary=await account(false);await admin.ready();const payload={reason:'Scheduled service maintenance',version:0,ownerId:admin.userId,status:'PLANNED',startsAt:new Date(Date.now()+3600000).toISOString(),endsAt:new Date(Date.now()+7200000).toISOString(),announcement:'Maintenance test announcement',readOnly:true},result=await act(admin,{action:'MAINTENANCE_WINDOW',payload}),state=await json(admin,root+'/service/maintenance'),window=state.windows.find((w:{id:string})=>w.id===result.resourceId)
  assert(window);assert((await json(ordinary,'/api/public/service-notice')).windows.some((w:{id:string})=>w.id===window.id))
  await json(admin,root+'/management/actions',{password,spec:{action:'MAINTENANCE_WINDOW',targetId:window.id,payload:{...payload,version:window.version,status:'IN_PROGRESS'}}},409)
  await db.query("UPDATE staffly_admin.maintenance_windows SET prechecks=$2,app_version='development' WHERE id=$1",[window.id,JSON.stringify({passed:true,checkedAt:new Date(Date.now()-86400000).toISOString()})]);assert.equal((await json(admin,root+'/service/preview',{action:'MAINTENANCE_WINDOW',targetId:window.id,payload:{...payload,version:window.version,status:'IN_PROGRESS'}})).allowed,false)
  await act(admin,{action:'MAINTENANCE_WINDOW',targetId:window.id,payload:{...payload,version:window.version,status:'CANCELLED'}})
 })
 it('exports bounded safe service metadata with dates and an administrative audit event',async()=>{
  const admin=await account();await admin.ready();const from=new Date(Date.now()-86400000).toISOString(),to=new Date().toISOString(),report=await json(admin,root+'/service/reports?'+new URLSearchParams({from,to,kind:'all',limit:'1'}))
  assert.equal(report.format,'staffly-service-report-v1');assert.equal(report.entries.length,1);assert.equal(report.filters.from,from);assert.equal(report.truncated,true);assert(report.generatedAt);assert(!JSON.stringify(report).includes('password'));assert(!JSON.stringify(report).includes('private-doc'))
  assert.equal((await db.query("SELECT count(*)::int n FROM staffly_admin.audit_events WHERE user_id=$1 AND action='SERVICE_REPORT_EXPORTED'",[admin.userId])).rows[0].n,1)
  const backupId=randomUUID();await db.query("INSERT INTO staffly_admin.backups(id,file_key,size_bytes,sha256,expires_at,file_state) VALUES($1,$2,1,$3,now()+interval '30 days','AVAILABLE')",[backupId,'staffly-'+backupId+'.dump','a'.repeat(64)]);const {rows:[check]}=await db.query("INSERT INTO staffly_admin.restore_checks(backup_id,status,duration_ms,checks) VALUES($1,'FAILED',1,'{}') RETURNING id",[backupId]);const backupReport=await json(admin,root+'/service/reports?'+new URLSearchParams({from,to:new Date(Date.now()+1000).toISOString(),kind:'backups'}));assert(backupReport.entries.some((row:{id:string;action:string})=>row.id===check.id&&row.action==='RESTORE_CHECK'))
  await json(admin,root+'/service/reports?'+new URLSearchParams({from:'2020-01-01T00:00:00Z',to,kind:'all'}),undefined,400)
 })
 it('schedules at most one backup at a time and exposes next runs and the responsible administrator',async()=>{
  const admin=await account();await admin.ready();const state=await json(admin,root+'/service/maintenance'),old=state.schedule
  try{
   await act(admin,{action:'BACKUP_SCHEDULE',payload:{reason:'Enable tested automatic backup schedule',version:old.version,ownerId:admin.userId,enabled:true,createMinutes:1440,verifyMinutes:720,cleanupMinutes:1440}})
   const client=await db.connect();try{await runBackupSchedule(client);await runBackupSchedule(client)}finally{client.release()}
   const current=await json(admin,root+'/service/maintenance');assert.equal(current.schedule.owner_id,admin.userId);assert(current.schedule.owner_name);if(current.schedule.create_result)assert.equal(current.schedule.create_result.status,'PENDING');assert(current.schedule.next_create_at);assert(current.schedule.heartbeat_at)
   assert((await db.query("SELECT count(*)::int n FROM staffly_admin.backup_jobs WHERE requested_by=$1 AND kind='CREATE'",[admin.userId])).rows[0].n<=1)
  }finally{await db.query("UPDATE staffly_admin.backup_schedule SET enabled=false,owner_id=NULL,next_create_at=NULL,next_verify_at=NULL,next_cleanup_at=NULL WHERE id=1");await db.query('DELETE FROM staffly_admin.backup_jobs WHERE requested_by=$1',[admin.userId]);await db.query('DELETE FROM staffly_admin.service_jobs WHERE requested_by=$1',[admin.userId])}
 })
}
