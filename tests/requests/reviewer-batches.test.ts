import { maintainRequests } from '../../src/server/requests/worker.ts'
import assert from 'node:assert/strict'
import { before, after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization as createOrganization } from '../support/business-organization.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { hasPermission, permissionRecipients } from '../../src/server/organizations/access/access.ts'
import { stageReviewers, ensureReviewers, loadReviewerContext, reviewersFromContext, validateAnswers, type ReviewerItem } from '../../src/server/requests/workflow.ts'
import { definitionOf } from '../../src/app/requests/workflow.ts'
import { performanceSnapshot } from '../../src/server/performance.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'

let org:string, first:string, second:string, owner:string, ownerMember:string, reviewerRole:string, vacationRole:string, legacyRole:string
const users:string[]=[], members:Record<string,string>={}
const permissions=['requests.resolve','vacations.resolve']
const count=()=>performanceSnapshot().measurements.sql?.count??0
const code=(c:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code===c
async function member(name:string,locationId=first,options:{legacy?:boolean;global?:boolean;left?:boolean;deleted?:boolean;roleId?:string}={}) {
  const user=await prisma.user.create({data:{email:`batch-${randomUUID()}@example.test`,passwordHash:'test',emailVerifiedAt:new Date(),deletedAt:options.deleted?new Date():null}});users.push(user.id)
  const m=await prisma.organizationMember.create({data:{organizationId:org,userId:user.id,role:options.legacy?'ADMIN':'MEMBER',accessConfigured:!options.legacy,accessRoleId:options.global?options.roleId??reviewerRole:null,leftAt:options.left?new Date():null}})
  await prisma.locationMember.create({data:{organizationId:org,locationId,memberId:m.id,role:options.legacy?'ADMIN':'MEMBER'}})
  if(!options.legacy&&!options.global)await prisma.accessAssignment.create({data:{organizationId:org,locationId,memberId:m.id,roleId:options.roleId??reviewerRole}})
  members[name]=m.id;return m
}
const item=(patch:Partial<ReviewerItem>={}):ReviewerItem=>({organizationId:org,locationId:first,createdByMemberId:members.creator,formSnapshot:{version:1},approvalStep:0,systemCodeSnapshot:null,...patch})
const ids=(rows:Array<{id:string}>)=>rows.map(r=>r.id).sort()
before(async()=>{
  const user=await prisma.user.create({data:{email:`batch-owner-${randomUUID()}@example.test`,passwordHash:'test',emailVerifiedAt:new Date()}});owner=user.id;users.push(owner)
  const o=await createOrganization(owner,{name:'Reviewer batching',description:null,timezone:'Europe/Moscow',firstLocation:{name:'First',city:'Test',address:'Test',timezone:'Europe/Moscow'},locations:[{name:'Second',city:'Test',address:'Test',timezone:'Europe/Moscow'}]});org=o.id;[first,second]=o.locations.map(l=>l.id);ownerMember=(await getMembership(owner,org)).id
  reviewerRole=(await prisma.accessRole.create({data:{organizationId:org,name:'Reviewers',permissions}})).id
  vacationRole=(await prisma.accessRole.create({data:{organizationId:org,name:'Vacation only',permissions:['vacations.resolve']}})).id
  legacyRole=(await prisma.accessRole.findFirstOrThrow({where:{organizationId:org,systemCode:'ADMIN'}})).id
  for(const name of ['creator','one','two'])await member(name)
  await member('otherPoint',second);await member('global',first,{global:true});await member('legacy',first,{legacy:true});await member('left',first,{left:true});await member('deleted',first,{deleted:true});await member('vacation',first,{roleId:vacationRole})
})
after(async()=>{
  try {
    await prisma.accountNotification.deleteMany({where:{organizationId:org}})
    await prisma.organizationRequest.deleteMany({where:{organizationId:org}})
    await prisma.documentFolder.deleteMany({where:{organizationId:org}})
    await prisma.organization.deleteMany({where:{id:org}})
    await prisma.user.deleteMany({where:{id:{in:users}}})
  } finally { await prisma.$disconnect() }
})

// Independent reference for the pre-batching algorithm; compare actual DB roles
// and selected-point contexts, not just a fixture-specific list of IDs.
async function reference(request:ReviewerItem) {
  return prisma.$transaction(async tx=>{
    const stage=definitionOf(request.formSnapshot).stages[request.approvalStep], result=[]
    for(const m of await permissionRecipients(tx,org,request.systemCodeSnapshot==='VACATION'?'vacations.resolve':'requests.resolve',request.locationId)) {
      const raw=await tx.organizationMember.findUniqueOrThrow({where:{id:m.id},include:{accessAssignments:true,locationMemberships:true}})
      const actor=await getMembership(raw.userId,org,tx)
      if(m.id===request.createdByMemberId&&!hasPermission(actor,'requests.selfResolve',request.locationId)&&!actor.owner)continue
      if(stage?.memberId&&stage.memberId!==m.id)continue
      if(stage?.roleId){const role=await tx.accessRole.findUnique({where:{id:stage.roleId}});if(raw.accessRoleId!==stage.roleId&&!raw.accessAssignments.some(a=>a.locationId===request.locationId&&a.roleId===stage.roleId)&&!(!raw.accessConfigured&&role?.systemCode&&raw.locationMemberships.some(l=>l.locationId===request.locationId&&l.leftAt===null&&l.role===role.systemCode)))continue}
      result.push(m)
    }return result
  })
}
it('preserves multi-reviewer routes, local/global/legacy roles and point isolation',async()=>{
  const variants=[item(),item({locationId:second}),item({systemCodeSnapshot:'VACATION'}),item({createdByMemberId:ownerMember}),
    item({formSnapshot:{stages:[{name:'Named reviewer',memberId:members.one},{name:'Role reviewers',roleId:reviewerRole}]}}),
    item({approvalStep:1,formSnapshot:{stages:[{name:'Named reviewer',memberId:members.one},{name:'Role reviewers',roleId:reviewerRole}]}}),
    item({formSnapshot:{stages:[{name:'Legacy admins',roleId:legacyRole}]}}),item({formSnapshot:{stages:[{name:'Missing role',roleId:randomUUID()}]}})]
  for(const selected of [undefined,first,second])for(const request of variants) {
    await locationContext.run({organizationId:org,locationId:selected},async()=>{
      assert.deepEqual(ids(await stageReviewers(prisma,request)),ids(await reference(request)))
    })
  }
  const result=ids(await stageReviewers(prisma,item()))
  for(const key of ['one','two','global','legacy'])assert.ok(result.includes(members[key]),key)
  for(const key of ['creator','left','deleted','otherPoint','vacation'])assert.ok(!result.includes(members[key]),key)
  await assert.rejects(ensureReviewers(prisma,item({formSnapshot:{stages:[{name:'Former reviewer',memberId:members.left}]}})),code('NO_REVIEWER'))
})
it('rechecks self-approval and role revocation on the next operation',async()=>{
  await prisma.accessRole.update({where:{id:reviewerRole},data:{permissions:[...permissions,'requests.selfResolve']}})
  assert.ok(ids(await stageReviewers(prisma,item())).includes(members.creator))
  await prisma.accessRole.update({where:{id:reviewerRole},data:{permissions:[]}})
  assert.ok(!ids(await stageReviewers(prisma,item())).includes(members.one))
  await prisma.accessRole.update({where:{id:reviewerRole},data:{permissions}})
})
it('keeps SQL query count constant for 100 additional reviewers and reuses a batch across stages without SQL',async()=>{
  let before=count();await stageReviewers(prisma,item());const small=count()-before
  for(let i=0;i<100;i++)await member(`extra-${i}`)
  before=count();const result=await stageReviewers(prisma,item());const large=count()-before
  assert.equal(large,small);assert.ok(large<=8,`Queries: ${large}`);assert.ok(result.length>=100)
  before=count();const previous=await reference(item());const previousQueries=count()-before
  assert.deepEqual(ids(result),ids(previous));assert.ok(previousQueries>large*10)
  await prisma.$transaction(async tx=>{
    const context=await loadReviewerContext(tx,org), reads=count()
    for(let i=0;i<20;i++)assert.ok(reviewersFromContext(context,item({locationId:i%2?first:second})).length)
    assert.equal(count(),reads)
    assert.throws(()=>reviewersFromContext(context,item({organizationId:randomUUID()})),/another organization/)
  })
  console.log(JSON.stringify({reviewerBatch:{additionalMembers:100,smallQueries:small,largeQueries:large,previousQueriesIncludingTransaction:previousQueries,reviewers:result.length}}))
})
it('validates many visible reference fields in two reads and ignores hidden references',async()=>{
  const fields=Array.from({length:20},(_,i)=>({key:`field${i}`,label:`Field ${i}`,kind:i%2?'LOCATION':'MEMBER'}))
  const definition=definitionOf({fields:[...fields,{key:'toggle',label:'Toggle',kind:'TEXT'},{key:'hidden',label:'Hidden',kind:'MEMBER',when:{field:'toggle',equals:'yes'}}]})
  const answers=Object.fromEntries(fields.map((f,i)=>[f.key,i%2?second:members.one]));answers.hidden=randomUUID()
  const before=count(),result=await validateAnswers(prisma,org,first,definition,answers)
  assert.equal(count()-before,2);assert.equal(Object.keys(result).length,20);assert.equal(result.hidden,undefined)
  await assert.rejects(validateAnswers(prisma,org,first,definition,{...answers,field0:members.otherPoint}),code('INVALID_MEMBER'))
  await assert.rejects(validateAnswers(prisma,org,first,definition,{...answers,field1:randomUUID()}),code('INVALID_LOCATION'))
  await assert.rejects(validateAnswers(prisma,org,first,definition,{...answers,field0:members.deleted}),code('INVALID_MEMBER'))
})

it('sends reminders for multiple routes and campaign audiences once, excluding departed/deleted members',async()=>{
  const now=new Date('2038-01-01T00:00:00Z'), dueAt=new Date(now.getTime()-1000)
  const type=await prisma.requestType.findFirstOrThrow({where:{organizationId:org,systemCode:'VACATION'}})
  const campaigns=[]
  for(const memberIds of [[members.one,members.two,members.left],[members.creator,members.deleted]])campaigns.push(await prisma.vacationCampaign.create({data:{organizationId:org,locationId:first,createdByMemberId:ownerMember,title:'Batch reminders',year:2038,dueAt,memberIds}}))
  const requests=[]
  for(const [i,locationId] of [first,second].entries())requests.push(await prisma.organizationRequest.create({data:{organizationId:org,locationId,createdByMemberId:members.one,requestTypeId:type.id,systemCodeSnapshot:'VACATION',typeNameSnapshot:'Batch request',formSnapshot:{stages:[{name:'Named',memberId:members.two},{name:'Role',roleId:reviewerRole}]},approvalStep:i,dueAt,...(i===0?{campaignId:campaigns[0].id}:{})}}))
  const expected=await Promise.all(requests.map(r=>stageReviewers(prisma,r)))
  await maintainRequests(now)
  for(const [i,r] of requests.entries()) {
    const notifications=await prisma.accountNotification.findMany({where:{requestId:r.id,type:'REQUEST_CREATED'}})
    assert.deepEqual(notifications.map(n=>n.userId).sort(),expected[i].map(m=>m.userId).sort())
    assert.ok((await prisma.organizationRequest.findUniqueOrThrow({where:{id:r.id}})).remindedAt)
  }
  const memberUsers=await prisma.organizationMember.findMany({where:{id:{in:[members.two,members.creator]}},select:{userId:true}})
  const notifications=await prisma.accountNotification.findMany({where:{vacationCampaignId:{in:campaigns.map(c=>c.id)}}})
  assert.deepEqual(notifications.map(n=>n.userId).sort(),memberUsers.map(m=>m.userId).sort())
  assert.equal(await prisma.vacationCampaign.count({where:{id:{in:campaigns.map(c=>c.id)},closedAt:{not:null}}}),2)
  const total=await prisma.accountNotification.count({where:{organizationId:org}})
  await maintainRequests(now)
  assert.equal(await prisma.accountNotification.count({where:{organizationId:org}}),total)
})
