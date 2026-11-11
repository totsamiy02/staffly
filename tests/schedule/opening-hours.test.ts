import {createRequest,listRequestTypes,resolveRequest} from '../../src/server/requests/service.ts'
import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../src/server/db.ts'
import {createOrganization} from '../../src/server/organizations/organization-service.ts'
import {createBusinessOrganization} from '../support/business-organization.ts'
import {saveLocation} from '../../src/server/organizations/location-service.ts'
import {locationBody} from '../../src/server/organizations/schemas.ts'
import {createShift,createShiftBatch,updateShift} from '../../src/server/schedule/service.ts'
import {outsideOpeningHours} from '../../src/server/schedule/opening-hours.ts'
import {emptyOpeningHours,type OpeningHours} from '../../src/shared/organization-profile.ts'
import {locationContext} from '../../src/server/organizations/location-context.ts'
import {zonedDateTimeToUtc as instant} from '../../src/server/schedule/timezone.ts'
import * as team from '../../src/server/schedule/planning/team-planning-service.ts'
import * as schemas from '../../src/server/schedule/planning/team-planning-schemas.ts'
const monday='2038-01-04',tuesday='2038-01-05',hours=():OpeningHours=>{const days=emptyOpeningHours();days[0]={day:0,status:'OPEN',start:'09:00',end:'18:00'};return days}
const range=(date:string,start:string,end:string,endDate=date,zone='Europe/Moscow')=>({start:instant(date,start,zone),end:instant(endDate,end,zone)})
const code=(value:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===value
const warning=async(fn:()=>Promise<unknown>)=>{try{await fn();assert.fail('Expected hours warning')}catch(e){assert(code('OPENING_HOURS_WARNING')(e));const details=(e as {details:{openingHoursConfirmation:string}}).details;assert.match(details.openingHoursConfirmation,/^[a-f0-9]{64}$/);return details.openingHoursConfirmation}}
const fixture=async(business=false)=>{const owner=await prisma.user.create({data:{email:randomUUID()+'@example.test',emailVerifiedAt:new Date()}}),org=await(business?createBusinessOrganization:createOrganization)(owner.id,{name:'Hours fixture',description:null,timezone:'Europe/Moscow'}),member=await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:org.id,userId:owner.id}}});await prisma.organizationLocation.update({where:{id:org.locationId},data:{openingHours:hours()}});const run=<T>(fn:()=>Promise<T>)=>locationContext.run({organizationId:org.id,locationId:org.locationId},fn);return{owner,org,member,run}}
const input=(memberId:string,startTime='08:00',endTime='19:00',startDate=monday)=>({memberId,startDate,endDate:startDate,startTime,endTime,breakMinutes:0,description:null})
after(()=>prisma.$disconnect())
test('hours compare boundaries, earlier opening, later closing and timezone as actual instants',()=>{
 const days=hours();assert.equal(new Date(monday+'T12:00Z').getUTCDay(),1)
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'09:00','18:00')),false)
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'08:59','18:00')),true)
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'09:00','18:01')),true)
 assert.equal(outsideOpeningHours(days,'Asia/Yekaterinburg',range(monday,'09:00','18:00',monday,'Asia/Yekaterinburg')),false)
 assert.equal(outsideOpeningHours(days,'Asia/Yekaterinburg',range(monday,'09:00','18:00')),true)
})
test('unknown days allow work; closed days, breaks and enormous ranges still warn',()=>{
 const days=hours();assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(tuesday,'00:00','23:59')),false)
 days[1]={day:1,status:'CLOSED'};assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(tuesday,'09:00','10:00')),true)
 days[0]={day:0,status:'OPEN',start:'09:00',end:'18:00',breakStart:'13:00',breakEnd:'14:00'}
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'12:00','15:00')),true)
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'09:00','13:00')),false)
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'09:00','18:00','2098-01-04')),true)
 assert.equal(outsideOpeningHours(emptyOpeningHours(),'Europe/Moscow',range(monday,'09:00','18:00','2098-01-04')),false)
})
test('overnight opening covers the following closed day and stops at the precise closing time',()=>{
 const days=emptyOpeningHours();days[6]={day:6,status:'OPEN',start:'22:00',end:'06:00'};days[0]={day:0,status:'CLOSED'}
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'02:00','06:00')),false)
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'02:00','06:01')),true)
 assert.equal(outsideOpeningHours(days,'Europe/Moscow',range(monday,'06:00','07:00')),true)
})
test('server requires explicit confirmation, binds it to the current hours and times, and rechecks rights',async()=>{
 const {owner,org,member,run}=await fixture(),body=input(member.id)
 const token=await warning(()=>run(()=>createShift(owner.id,org.id,body)))
 assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),0)
 await warning(()=>run(()=>createShift(owner.id,org.id,{...body,endTime:'20:00',openingHoursConfirmation:token})))
 await prisma.organizationLocation.update({where:{id:org.locationId},data:{revision:{increment:1}}})
 const fresh=await warning(()=>run(()=>createShift(owner.id,org.id,{...body,openingHoursConfirmation:token})));assert.notEqual(fresh,token)
 const shift=await run(()=>createShift(owner.id,org.id,{...body,openingHoursConfirmation:fresh}));assert(shift.id)
 await warning(()=>run(()=>updateShift(owner.id,org.id,shift.id,{...body,startTime:'07:00'})))
 const stranger=await prisma.user.create({data:{email:randomUUID()+'@example.test'}})
 await assert.rejects(run(()=>createShift(stranger.id,org.id,{...body,openingHoursConfirmation:fresh})),code('ORGANIZATION_NOT_FOUND'))
 const manager=await prisma.user.create({data:{email:randomUUID()+'@example.test',emailVerifiedAt:new Date()}}),staff=await prisma.organizationMember.create({data:{organizationId:org.id,userId:manager.id}})
 await prisma.locationMember.create({data:{organizationId:org.id,locationId:org.locationId,memberId:staff.id,role:'ADMIN'}})
 const later=input(staff.id,'08:00','19:00','2038-01-11'),issued=await warning(()=>run(()=>createShift(manager.id,org.id,later)))
 await prisma.locationMember.update({where:{locationId_memberId:{locationId:org.locationId,memberId:staff.id}},data:{role:'MEMBER'}})
 await assert.rejects(run(()=>createShift(manager.id,org.id,{...later,openingHoursConfirmation:issued})),code('INSUFFICIENT_PERMISSIONS'))
 assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),1)
})
test('batch warning rolls back every shift and the complete batch can be explicitly confirmed',async()=>{
 const {owner,org,member,run}=await fixture(),batch=[input(member.id),input(member.id,'08:00','19:00',tuesday)]
 const token=await warning(()=>run(()=>createShiftBatch(owner.id,org.id,batch)))
 assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),0)
 const result=await run(()=>createShiftBatch(owner.id,org.id,batch,false,token));assert.equal(result.shifts.length,2)
})
test('point settings change the policy for later assignments without rewriting existing shifts',async()=>{
 const {owner,org,member,run}=await fixture(),body=input(member.id,'09:00','18:00')
 const first=await run(()=>createShift(owner.id,org.id,body)),point=await prisma.organizationLocation.findUniqueOrThrow({where:{id:org.locationId}}),days=hours();days[1]={day:1,status:'OPEN',start:'10:00',end:'16:00'}
 await run(()=>saveLocation(owner.id,org.id,point.id,locationBody.parse({...point,kind:'REMOTE',openingHours:days})))
 await warning(()=>run(()=>createShift(owner.id,org.id,input(member.id,'09:00','18:00',tuesday))))
 assert.equal(+(await prisma.workShift.findUniqueOrThrow({where:{id:first.id}})).scheduledStartAt,+instant(monday,'09:00','Europe/Moscow'))
})
test('draft validation warns and application cannot bypass the point hours',async()=>{
 const {owner,org,member,run}=await fixture(true)
 await prisma.organization.update({where:{id:org.id},data:{discussionEnabled:true}})
 const draft=await run(()=>team.createDraft(owner.id,org.id,schemas.draftCreateBody.parse({title:'Hours draft',fromDate:monday,toDate:monday})))
 await run(()=>team.changeDraftProposals(owner.id,org.id,draft.id,schemas.draftProposalBody.parse({revision:draft.revision,kind:'CREATE',shifts:[input(member.id)]})))
 const act=async(action:string,patch={})=>{const current=await run(()=>team.getDraft(owner.id,org.id,draft.id));return run(()=>team.actOnDraft(owner.id,org.id,draft.id,schemas.draftActionBody.parse({revision:current.revision,action,...patch})))}
 assert((await run(()=>team.validateDraft(owner.id,org.id,draft.id))).warnings.some(w=>w.code==='OPENING_HOURS_WARNING'))
 await act('PUBLISH',{deadline:new Date(Date.now()+86400000).toISOString()});await act('CLOSE',{confirm:true,explanation:'Синтетическое раннее завершение'})
 const token=await warning(()=>act('APPLY'));assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),0)
 await act('APPLY',{openingHoursConfirmation:token});assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),1)
})

test('Free cannot assign new shifts to legacy points beyond its location quota',async()=>{
 const {owner,org,member}=await fixture(true)
 const second=await saveLocation(owner.id,org.id,null,locationBody.parse({name:'Вторая точка',kind:'REMOTE',timezone:'Europe/Moscow'}))
 await prisma.organizationSubscription.update({where:{organizationId:org.id},data:{plan:'FREE',periodEnd:null,trialEndsAt:null}})
 await assert.rejects(locationContext.run({organizationId:org.id,locationId:second.id},()=>createShift(owner.id,org.id,input(member.id))),code('SUBSCRIPTION_LIMIT_REACHED'))
 assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),0)
})

test('applying a draft cannot create shifts in legacy points beyond the Business maximum',async()=>{
 const {owner,org,member}=await fixture(true)
 const extra=Array.from({length:10},(_,index)=>({id:randomUUID(),organizationId:org.id,name:'Legacy point '+index,kind:'REMOTE',city:'',address:'',timezone:'Europe/Moscow',createdAt:new Date(Date.now()+index)}))
 await prisma.organizationLocation.createMany({data:extra})
 const point=extra.at(-1)!
 await prisma.locationMember.create({data:{organizationId:org.id,locationId:point.id,memberId:member.id}})
 await prisma.organization.update({where:{id:org.id},data:{discussionEnabled:true}})
 const run=<T>(fn:()=>Promise<T>)=>locationContext.run({organizationId:org.id,locationId:point.id},fn)
 const draft=await run(()=>team.createDraft(owner.id,org.id,schemas.draftCreateBody.parse({title:'Legacy quota',fromDate:monday,toDate:monday})))
 await run(()=>team.changeDraftProposals(owner.id,org.id,draft.id,schemas.draftProposalBody.parse({revision:draft.revision,kind:'CREATE',shifts:[input(member.id)]})))
 const act=async(action:string,patch={})=>{const current=await run(()=>team.getDraft(owner.id,org.id,draft.id));return run(()=>team.actOnDraft(owner.id,org.id,draft.id,schemas.draftActionBody.parse({revision:current.revision,action,...patch})))}
 await act('PUBLISH',{deadline:new Date(Date.now()+86400000).toISOString()});await act('CLOSE',{confirm:true,explanation:'Синтетическое раннее завершение'})
 await assert.rejects(act('APPLY'),code('SUBSCRIPTION_LIMIT_REACHED'))
 assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),0)
 assert.equal((await prisma.scheduleDraft.findUniqueOrThrow({where:{id:draft.id}})).status,'CLOSED')
})

test('approving a shift proposal cannot bypass hours and a warning leaves the request pending',async()=>{
 const {owner,org,run}=await fixture(),employee=await prisma.user.create({data:{email:randomUUID()+'@example.test',emailVerifiedAt:new Date()}}),member=await prisma.organizationMember.create({data:{organizationId:org.id,userId:employee.id}})
 await prisma.locationMember.create({data:{organizationId:org.id,locationId:org.locationId,memberId:member.id}})
 const type=(await run(()=>listRequestTypes(owner.id,org.id))).find(t=>t.systemCode==='SHIFT_PROPOSAL')!
 const request=await run(()=>createRequest(employee.id,org.id,{requestTypeId:type.id,comment:'Синтетическое предложение смены',proposedStartDate:monday,proposedEndDate:monday,proposedStartTime:'08:00',proposedEndTime:'19:00'}))
 const token=await warning(()=>run(()=>resolveRequest(owner.id,org.id,request.id,'APPROVED',null)))
 assert.equal((await prisma.organizationRequest.findUniqueOrThrow({where:{id:request.id}})).status,'PENDING');assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),0)
 await run(()=>resolveRequest(owner.id,org.id,request.id,'APPROVED',null,false,false,false,token))
 assert.equal((await prisma.organizationRequest.findUniqueOrThrow({where:{id:request.id}})).status,'APPROVED');assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),1)
})
