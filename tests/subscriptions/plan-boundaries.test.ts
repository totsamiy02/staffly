import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import express from 'express'
import {SignJWT} from 'jose'
import {prisma} from '../../src/server/db.ts'
import {createOrganization} from '../../src/server/organizations/organization-service.ts'
import organizationRouter from '../../src/server/organizations/routes.ts'
import {selectOrganizationPlan,subscriptionDetails} from '../../src/server/subscriptions/service.ts'
import {reportAccess} from '../../src/server/schedule/reports/report-service.ts'
import {saveAccessRole} from '../../src/server/organizations/access/access-service.ts'
import {createDraft} from '../../src/server/schedule/planning/team-planning-service.ts'
import {draftCreateBody} from '../../src/server/schedule/planning/team-planning-schemas.ts'
import {createShift} from '../../src/server/schedule/service.ts'
import {plans} from '../../src/app/subscriptions/plans.ts'
const code=(c:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===c
const fixture=async()=>{const owner=await prisma.user.create({data:{email:randomUUID()+'@example.test',emailVerifiedAt:new Date()}}),org=await createOrganization(owner.id,{name:'Plan boundary',description:null,timezone:'Europe/Moscow'});return{owner,org}}
after(()=>prisma.$disconnect())
test('Free point limit is enforced by the real HTTP route; owner can add the point only after selecting Team',async()=>{
 const {owner,org}=await fixture(),session=await prisma.authSession.create({data:{userId:owner.id,refreshTokenHash:randomUUID(),idleExpiresAt:new Date(Date.now()+60000),absoluteExpiresAt:new Date(Date.now()+60000)}})
 const token=await new SignJWT({sid:session.id}).setProtectedHeader({alg:'HS256'}).setSubject(owner.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET!))
 const app=express();app.use(express.json());app.use('/api',organizationRouter);app.use((e:any,_q:any,s:any,_n:any)=>s.status(e.status??500).json({code:e.code}))
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string')
 const url='http://127.0.0.1:'+address.port+'/api/organizations/'+org.id+'/locations',headers={Authorization:'Bearer '+token,'Content-Type':'application/json'},body=JSON.stringify({name:'Вторая точка',kind:'REMOTE',timezone:'Europe/Moscow'})
 try{
  const denied=await fetch(url,{method:'POST',headers,body});assert.equal(denied.status,409);assert.equal((await denied.json() as {code:string}).code,'SUBSCRIPTION_LIMIT_REACHED');assert.equal(await prisma.organizationLocation.count({where:{organizationId:org.id}}),1)
  await selectOrganizationPlan(owner.id,org.id,'TEAM',(await subscriptionDetails(owner.id,org.id)).revision)
  assert.equal((await fetch(url,{method:'POST',headers,body})).status,201);assert.equal(await prisma.organizationLocation.count({where:{organizationId:org.id}}),2)
 }finally{await new Promise<void>(r=>server.close(()=>r()))}
})
test('every tariff matches the server feature matrix while ordinary shifts remain available on Free',async()=>{
 for(const plan of ['FREE','TEAM','BUSINESS'] as const){
  const {owner,org}=await fixture();await selectOrganizationPlan(owner.id,org.id,plan,(await subscriptionDetails(owner.id,org.id)).revision)
  const snapshot=await subscriptionDetails(owner.id,org.id);assert.equal(snapshot.subscription.effectivePlan,plan);assert.deepEqual(snapshot.subscription.features,plans[plan].features);assert.equal(snapshot.subscription.limits.storageBytes,plans[plan].storageBytes)
  if(plan==='FREE')await assert.rejects(reportAccess(owner.id,org.id),code('SUBSCRIPTION_FEATURE_REQUIRED'));else await reportAccess(owner.id,org.id)
  const custom=()=>saveAccessRole(owner.id,org.id,null,{name:'Дополнительная роль',description:'',permissions:[]})
  if(plan==='BUSINESS')await custom();else await assert.rejects(custom(),code('SUBSCRIPTION_FEATURE_REQUIRED'))
  await prisma.organization.update({where:{id:org.id},data:{discussionEnabled:true}})
  const draft=()=>createDraft(owner.id,org.id,draftCreateBody.parse({title:'Tariff draft',fromDate:'2038-03-01',toDate:'2038-03-02'}))
  if(plan==='BUSINESS')await draft();else await assert.rejects(draft(),code('SUBSCRIPTION_FEATURE_REQUIRED'))
  const member=await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:org.id,userId:owner.id}}})
  await createShift(owner.id,org.id,{memberId:member.id,startDate:'2038-03-01',endDate:'2038-03-01',startTime:'09:00',endTime:'18:00',breakMinutes:0,description:null})
 }
})
