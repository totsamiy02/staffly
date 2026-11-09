import assert from 'node:assert/strict'
import { before,after,it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma,databasePool } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { organizationAvailable } from '../../src/server/organizations/service-state.ts'
import { effectiveSubscription } from '../../src/app/subscriptions/plans.ts'
import { subscriptionSnapshot } from '../../src/server/subscriptions/access.ts'
import { actionSpec } from '../../src/server/admin/management/schemas.ts'
import { contentChecks } from '../../src/server/admin/service/content.ts'
let userId:string,orgId:string
before(async()=>{const user=await prisma.user.create({data:{email:'service-'+randomUUID()+'@example.test',emailVerifiedAt:new Date()}});userId=user.id;orgId=(await createBusinessOrganization(user.id,{name:'Service lifecycle test',description:null,timezone:'Europe/Moscow'})).id})
after(async()=>{if(orgId)await prisma.organization.update({where:{id:orgId},data:{deletedAt:new Date()}});await prisma.$disconnect()})
it('keeps the normal subscription intact while a temporary support plan starts and expires exactly',()=>{
 const base={plan:'FREE',periodStart:null,periodEnd:null,trialEndsAt:null,nextPlan:null,nextStartsAt:null,nextEndsAt:null,supportPlan:'BUSINESS',supportStartsAt:new Date('2026-11-08T00:00:00Z'),supportEndsAt:new Date('2026-11-09T00:00:00Z')}
 assert.equal(effectiveSubscription(base,new Date('2026-11-07T23:59:59Z')).effectivePlan,'FREE')
 const active=effectiveSubscription(base,new Date('2026-11-08T00:00:00Z'));assert.equal(active.effectivePlan,'BUSINESS');assert.equal(active.plan,'FREE');assert.equal(active.limits.members,100)
 assert.equal(effectiveSubscription(base,new Date('2026-11-09T00:00:00Z')).effectivePlan,'FREE')
})
it('enforces the same support storage quota in SQL and the application snapshot',async()=>{
 await prisma.organizationSubscription.update({where:{organizationId:orgId},data:{plan:'FREE',periodEnd:null,trialEndsAt:null,supportPlan:'TEAM',supportStartsAt:new Date(Date.now()-60000),supportEndsAt:new Date(Date.now()+60000)}})
 const snapshot=await subscriptionSnapshot(orgId),{rows:[row]}=await databasePool.query('SELECT public.staffly_subscription_storage_limit($1) AS limit',[orgId]);assert.equal(snapshot.effectivePlan,'TEAM');assert.equal(Number(row.limit),snapshot.limits.storageBytes)
})
it('blocks live membership checks while suspended and resumes at the specified deadline',async()=>{
 await prisma.organization.update({where:{id:orgId},data:{serviceState:'SUSPENDED',serviceReason:'Test support suspension',serviceUntil:new Date(Date.now()+60000)}})
 await assert.rejects(getMembership(userId,orgId),{code:'ORGANIZATION_SUSPENDED'})
 assert.equal((await databasePool.query('SELECT public.platform_organization_available($1) available',[orgId])).rows[0].available,false)
 await prisma.organization.update({where:{id:orgId},data:{serviceUntil:new Date(Date.now()-1000)}})
 assert.equal((await getMembership(userId,orgId)).owner,true)
 assert(organizationAvailable({serviceState:'SUSPENDED',serviceUntil:new Date(0)}))
})
it('rejects forged service actions without a live elevated actor',async()=>{
 const {rows:[row]}=await databasePool.query('SELECT * FROM staffly_admin.execute_management_action($1,$2,$3,$4,$5,$6,$7)',[userId,randomUUID(),randomUUID(),'0'.repeat(64),randomUUID(),'0'.repeat(64),'0'.repeat(64)])
 assert.notEqual(row.result,'OK')
})
it('never permits a queue retry or cancellation to reactivate a mandatory security message',async()=>{
 const job=await prisma.emailDelivery.create({data:{userId,sourceKey:'service-security-'+randomUUID(),sourceKind:'MANDATORY',status:'FAILED',attempts:1}})
 for(const command of ['retry','cancel'])assert.equal((await databasePool.query('SELECT staffly_admin.queue_action_reason($1,$2,$3) reason',['email',job.id,command])).rows[0].reason,'SECURITY_MESSAGE')
})
it('records actual queue transitions without copying the message payload',async()=>{
 const marker='PRIVATE-'+randomUUID(),job=await prisma.emailDelivery.create({data:{userId,sourceKey:'service-history-'+randomUUID(),sourceKind:'MANDATORY',payload:{secret:marker}}})
 await prisma.emailDelivery.update({where:{id:job.id},data:{attempts:1,status:'FAILED',lastErrorCode:'ETIMEDOUT'}})
 const {rows}=await databasePool.query('SELECT * FROM staffly_admin.queue_history WHERE job_id=$1 ORDER BY id',[job.id]);assert.equal(rows.length,2);assert.equal(rows[1].error_code,'ETIMEDOUT');assert(!JSON.stringify(rows).includes(marker))
})
it('validates reasons, short-lived grants, queue selection limits and duplicate jobs',()=>{
 assert.equal(actionSpec.safeParse({action:'ORG_STATE',targetId:orgId,payload:{version:1,state:'SUSPENDED',until:null,reason:'x'}}).success,false)
 const job={kind:'report',id:randomUUID(),expectedStatus:'FAILED',expectedAttempts:1}
 assert.equal(actionSpec.safeParse({action:'QUEUE_ACTION',payload:{reason:'Support request',command:'retry',jobs:[job,job]}}).success,false)
 assert.equal(actionSpec.safeParse({action:'PLAN_ADJUST',targetId:orgId,payload:{version:1,plan:'BUSINESS',startsAt:'2026-01-01T00:00:00Z',endsAt:'2028-01-01T00:00:00Z',revoke:false,reason:'Support compensation'}}).success,false)
})
it('checks executable markup and unsafe URLs before a public revision can be reviewed',()=>{
 assert.equal(contentChecks('[click](javascript:alert(1))').passed,false);assert.equal(contentChecks('<script>bad</script>').passed,false);assert.equal(contentChecks('[guide](/guide)\n\nSafe **content**').passed,true)
})
it('does not invent a full backup set, restore success or a configured external channel',async()=>{
 const {rows:[settings]}=await databasePool.query('SELECT enabled FROM staffly_admin.delivery_settings WHERE id=1');assert.equal(settings.enabled,false)
 assert.equal((await databasePool.query('SELECT count(*)::int n FROM staffly_admin.backup_components WHERE backup_id=$1',[orgId])).rows[0].n,0)
 assert.equal((await databasePool.query('SELECT count(*)::int n FROM staffly_admin.restore_checks WHERE backup_id=$1',[orgId])).rows[0].n,0)
})
