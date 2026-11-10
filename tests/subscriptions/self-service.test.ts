import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import express from 'express'
import {SignJWT} from 'jose'
import {ZodError} from 'zod'
import {prisma} from '../../src/server/db.ts'
import {createOrganization} from '../../src/server/organizations/organization-service.ts'
import {selectOrganizationPlan,subscriptionDetails} from '../../src/server/subscriptions/service.ts'
import {plans,nextMonth} from '../../src/app/subscriptions/plans.ts'
import router from '../../src/server/subscriptions/routes.ts'
const code=(c:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===c
const fixture=async()=>{const [owner,manager]=await Promise.all(['owner','manager'].map(firstName=>prisma.user.create({data:{email:randomUUID()+'@example.test',firstName,emailVerifiedAt:new Date()}})));const org=await createOrganization(owner.id,{name:'Self-service fixture',description:null,timezone:'Europe/Moscow'});await prisma.organizationMember.create({data:{organizationId:org.id,userId:manager.id,role:'ADMIN'}});return{owner,manager,org}}
after(()=>prisma.$disconnect())
test('owner selects every plan without payment, preserving tenant isolation and server storage limits',async()=>{
 const {owner,org}=await fixture(),other=await createOrganization(owner.id,{name:'Other tenant',description:null,timezone:'Europe/Moscow'})
 let details=await subscriptionDetails(owner.id,org.id);assert.equal(details.selfService,true);assert.equal(details.paymentRequired,false)
 for(const plan of ['TEAM','BUSINESS','FREE'] as const){const result=await selectOrganizationPlan(owner.id,org.id,plan,details.revision);assert.equal(result.subscription.effectivePlan,plan);assert.equal(Number((await prisma.organizationResourceBudget.findUniqueOrThrow({where:{organizationId:org.id}})).storageLimitBytes),plans[plan].storageBytes);details=await subscriptionDetails(owner.id,org.id)}
 assert.equal((await subscriptionDetails(owner.id,other.id)).subscription.effectivePlan,'FREE');assert.equal(await prisma.subscriptionPurchase.count({where:{organizationId:org.id}}),0)
})
test('lost response and simultaneous renewals with one revision extend the month only once',async()=>{
 const {owner,org}=await fixture(),before=await subscriptionDetails(owner.id,org.id)
 const results=await Promise.all([selectOrganizationPlan(owner.id,org.id,'TEAM',before.revision),selectOrganizationPlan(owner.id,org.id,'TEAM',before.revision)])
 assert.equal(results[0].subscription.validUntil,results[1].subscription.validUntil);assert.equal(results[0].revision,results[1].revision)
 const oldEnd=new Date(results[0].subscription.validUntil!),revision=results[0].revision
 const renewal=await Promise.all([selectOrganizationPlan(owner.id,org.id,'TEAM',revision),selectOrganizationPlan(owner.id,org.id,'TEAM',revision)])
 assert.equal(renewal[0].subscription.validUntil,nextMonth(oldEnd).toISOString());assert.equal(renewal[1].subscription.validUntil,renewal[0].subscription.validUntil)
 assert.equal(await prisma.accessAudit.count({where:{organizationId:org.id,action:'SUBSCRIPTION_PLAN_SELECTED'}}),2)
 await selectOrganizationPlan(owner.id,org.id,'BUSINESS',renewal[0].revision)
 await assert.rejects(selectOrganizationPlan(owner.id,org.id,'TEAM',revision),code('SUBSCRIPTION_CHANGED'))
})
test('nonowners, foreign users and a former owner cannot activate a plan',async()=>{
 const {owner,manager,org}=await fixture(),revision=(await subscriptionDetails(owner.id,org.id)).revision
 await assert.rejects(selectOrganizationPlan(manager.id,org.id,'BUSINESS',revision),code('OWNER_REQUIRED'))
 const outsider=await prisma.user.create({data:{email:randomUUID()+'@example.test'}})
 await assert.rejects(selectOrganizationPlan(outsider.id,org.id,'BUSINESS',revision),code('ORGANIZATION_NOT_FOUND'))
 await prisma.organizationMember.update({where:{organizationId_userId:{organizationId:org.id,userId:owner.id}},data:{role:'MEMBER'}})
 await assert.rejects(selectOrganizationPlan(owner.id,org.id,'BUSINESS',revision),code('OWNER_REQUIRED'))
})
test('downgrade refuses excessive members, locations and bytes without modifying the plan',async()=>{
 const {owner,org}=await fixture(),before=await subscriptionDetails(owner.id,org.id),business=await selectOrganizationPlan(owner.id,org.id,'BUSINESS',before.revision)
 const extras=await Promise.all(Array.from({length:4},()=>prisma.user.create({data:{email:randomUUID()+'@example.test'}})))
 await prisma.organizationMember.createMany({data:extras.map(u=>({organizationId:org.id,userId:u.id}))})
 await assert.rejects(selectOrganizationPlan(owner.id,org.id,'FREE',business.revision),code('SUBSCRIPTION_DOWNGRADE_LIMIT'))
 await prisma.organizationMember.updateMany({where:{organizationId:org.id,userId:{in:extras.map(u=>u.id)}},data:{leftAt:new Date()}})
 const point=await prisma.organizationLocation.create({data:{organizationId:org.id,name:'Extra',city:'',address:'',timezone:'Europe/Moscow'}})
 await assert.rejects(selectOrganizationPlan(owner.id,org.id,'FREE',business.revision),code('SUBSCRIPTION_DOWNGRADE_LIMIT'))
 await prisma.organizationLocation.update({where:{id:point.id},data:{archivedAt:new Date()}})
 await prisma.organizationResourceBudget.update({where:{organizationId:org.id},data:{storageBytes:BigInt(plans.FREE.storageBytes+1)}})
 await assert.rejects(selectOrganizationPlan(owner.id,org.id,'FREE',business.revision),code('SUBSCRIPTION_DOWNGRADE_LIMIT'))
 assert.equal((await subscriptionDetails(owner.id,org.id)).revision,business.revision)
})
test('explicit choice replaces temporary admin access and scheduled changes using the existing record',async()=>{
 const {owner,org}=await fixture()
 const record=await prisma.organizationSubscription.update({where:{organizationId:org.id},data:{supportPlan:'TEAM',supportStartsAt:new Date(),supportEndsAt:new Date(Date.now()+86400000),nextPlan:'FREE',nextStartsAt:new Date(Date.now()+86400000),revision:{increment:1}}})
 await selectOrganizationPlan(owner.id,org.id,'BUSINESS',record.revision)
 const saved=await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:org.id}})
 assert.equal(saved.supportPlan,null);assert.equal(saved.nextPlan,null);assert.equal(saved.trialEndsAt,null);assert.equal(saved.plan,'BUSINESS')
})
test('HTTP selection requires confirmation and rejects bank data',async()=>{
 const {owner,org}=await fixture(),details=await subscriptionDetails(owner.id,org.id)
 const session=await prisma.authSession.create({data:{userId:owner.id,refreshTokenHash:randomUUID(),idleExpiresAt:new Date(Date.now()+60000),absoluteExpiresAt:new Date(Date.now()+60000)}})
 const token=await new SignJWT({sid:session.id}).setProtectedHeader({alg:'HS256'}).setSubject(owner.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET!))
 const app=express();app.use(express.json());app.use('/api',router);app.use((e:any,_q:any,s:any,_n:any)=>s.status(e instanceof ZodError?400:e.status??500).json({code:e.code}))
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string')
 const url='http://127.0.0.1:'+address.port+'/api/organizations/'+org.id+'/subscription/select',headers={Authorization:'Bearer '+token,'Content-Type':'application/json'},body={plan:'TEAM',revision:details.revision,confirm:true}
 try{for(const invalid of [{plan:'TEAM',revision:details.revision},{...body,cvc:'123'},{...body,revision:-1}])assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(invalid)})).status,400);assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(body)})).status,200);assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(body)})).status,200)}finally{await new Promise<void>(r=>server.close(()=>r()))}
})
