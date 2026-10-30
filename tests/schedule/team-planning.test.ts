import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization as createOrganization } from '../support/business-organization.ts'
import { saveLocation } from '../../src/server/organizations/location-service.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { saveAccessRole, saveMemberAccess } from '../../src/server/organizations/access/access-service.ts'
import { listNotificationHistory } from '../../src/server/organizations/notification-service.ts'
import { planningData } from '../../src/server/schedule/planning/planning.ts'
import { createOffer, actOnOffer, saveOfferModes, offerBody } from '../../src/server/schedule/offer-service.ts'
import { listRequestTypes, createRequest, respondToStaffing, resolveRequest } from '../../src/server/requests/service.ts'
import { createShift, createShiftBatch, cancelShift, updateShift, listSchedule } from '../../src/server/schedule/service.ts'
import * as team from '../../src/server/schedule/planning/team-planning-service.ts'
import * as schema from '../../src/server/schedule/planning/team-planning-schemas.ts'
import { addDays } from '../../src/app/schedule/date-utils.ts'
let org:string,first:string,second:string,foreign:string,position:string,sequence=0
const people:Record<string,{id:string;memberId:string;email:string}>={}
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===expected
const at=<T>(task:()=>Promise<T>,point?:string)=>locationContext.run({organizationId:org,locationId:point??first},task)
const owner=()=>people.owner.id
const input=(date:string,who='employee',patch:Record<string,unknown>={})=>({memberId:people[who].memberId,positionId:position,startDate:date,endDate:date,startTime:'08:00',endTime:'16:00',breakMinutes:0,description:null,...patch})
const detail=(id:string,who='owner')=>at(()=>team.getDraft(people[who].id,org,id))
async function makeDraft(importCurrent=false,date=addDays('2038-01-01',sequence++*4)) {
  return at(()=>team.createDraft(owner(),org,schema.draftCreateBody.parse({title:'График '+randomUUID().slice(0,6),fromDate:date,toDate:addDays(date,2),importCurrent})))
}
async function propose(id:string,shifts:ReturnType<typeof input>[],patch:Record<string,unknown>={}) {
  const d=await detail(id)
  return at(()=>team.changeDraftProposals(owner(),org,id,schema.draftProposalBody.parse({revision:d.revision,kind:'CREATE',shifts,...patch})))
}
async function act(id:string,action:string,patch:Record<string,unknown>={}) {
  const d=await detail(id)
  return at(()=>team.actOnDraft(owner(),org,id,schema.draftActionBody.parse({revision:d.revision,action,...patch})))
}
const publish=(id:string)=>act(id,'PUBLISH',{deadline:new Date(Date.now()+24*3600000).toISOString()})
const close=(id:string)=>act(id,'CLOSE',{confirm:true,explanation:'Команда ознакомилась, завершаю досрочно'})
async function cleanupDrafts(){await prisma.scheduleDraft.deleteMany({where:{organizationId:org}})}
before(async()=>{
  for(const who of ['owner','employee','colleague','outsider','editor','alien']) {const u=await prisma.user.create({data:{email:`planning-${randomUUID()}@example.test`,passwordHash:'test-only',firstName:who,emailVerifiedAt:new Date()}});people[who]={id:u.id,email:u.email,memberId:''}}
  const created=await createOrganization(owner(),{name:'Team planning tests',description:null,timezone:'Europe/Moscow',firstLocation:{name:'Центр',city:'Москва',address:'Тест',timezone:'Europe/Moscow'},locations:[{name:'Парк',city:'Москва',address:'Тест',timezone:'Asia/Vladivostok'}]})
  org=created.id;[first,second]=created.locations.map(l=>l.id)
  people.owner.memberId=(await prisma.organizationMember.findFirstOrThrow({where:{organizationId:org,userId:owner()}})).id
  for(const who of ['employee','colleague','outsider','editor']) {const m=await prisma.organizationMember.create({data:{organizationId:org,userId:people[who].id}});people[who].memberId=m.id;await prisma.locationMember.create({data:{organizationId:org,locationId:who==='outsider'?second:first,memberId:m.id}})}
  const other=await createOrganization(people.alien.id,{name:'Foreign planning',description:null,timezone:'Europe/Moscow'});foreign=other.id
  const role=await prisma.organizationPosition.create({data:{organizationId:org,name:'Повар'}});position=role.id
  await prisma.memberPosition.createMany({data:['employee','colleague','editor'].map(who=>({memberId:people[who].memberId,positionId:position}))})
  const editorRole=await saveAccessRole(owner(),org,null,{name:'Редактор графика',description:'',permissions:['drafts.edit','members.view']})
  await saveMemberAccess(owner(),org,people.editor.memberId,{organizationRoleId:null,assignments:[{locationId:first,roleId:editorRole.id}]})
})
after(async()=>{
  const organizationId={in:[org,foreign].filter(Boolean)}
  if(org)await cleanupDrafts()
  await prisma.accountNotification.deleteMany({where:{organizationId}})
  await prisma.shiftOffer.deleteMany({where:{organizationId}})
  await prisma.organizationRequest.deleteMany({where:{organizationId}})
  await prisma.employeeAbsence.deleteMany({where:{organizationId}})
  await prisma.workShift.deleteMany({where:{organizationId}})
  await prisma.demandException.deleteMany({where:{organizationId}})
  await prisma.demandVersion.deleteMany({where:{organizationId}})
  await prisma.documentFolder.deleteMany({where:{organizationId}})
  await prisma.organization.deleteMany({where:{id:organizationId}})
  await prisma.user.deleteMany({where:{id:{in:Object.values(people).map(p=>p.id)}}})
  await prisma.$disconnect()
})
describe('optional demand and draft schedule lifecycle',{concurrency:false},()=>{
  it('starts disabled and enables both features for the entire organization from either point',async()=>{
    assert.deepEqual(await at(()=>team.getTeamSettings(owner(),org)),{coverageEnabled:false,discussionEnabled:false,discussionHours:24})
    await assert.rejects(makeDraft(),code('DISCUSSION_DISABLED'))
    await assert.rejects(at(()=>team.saveTeamSettings(people.employee.id,org,{coverageEnabled:true,discussionEnabled:true,discussionHours:24})),code('INSUFFICIENT_PERMISSIONS'))
    await at(()=>team.saveTeamSettings(owner(),org,{coverageEnabled:true,discussionEnabled:true,discussionHours:24}))
    assert.deepEqual(await at(()=>team.getTeamSettings(owner(),org),second),{coverageEnabled:true,discussionEnabled:true,discussionHours:24})
    assert.equal((await team.getTeamSettings(people.alien.id,foreign)).coverageEnabled,false)
    assert.deepEqual((await at(()=>team.getCoverage(owner(),org,'2038-01-01','2038-01-02'))).days[0].source,'unconfigured')
  })
  it('includes newly created locations without another feature toggle',async()=>{
    const location=await saveLocation(owner(),org,null,{name:'Новая точка',city:'Москва',address:'Тест',timezone:'Europe/Moscow',teamNames:[]})
    assert.equal((await at(()=>team.getTeamSettings(owner(),org),location.id)).coverageEnabled,true)
    assert.equal((await at(()=>team.getTeamSettings(owner(),org),location.id)).discussionEnabled,true)
    assert.equal((await at(()=>team.getDemand(owner(),org),location.id)).versions.length,0)
  })
  it('requires organization-wide settings permission rather than a role at one location',async()=>{
    const role=await saveAccessRole(owner(),org,null,{name:'Настройки расписания',description:'',permissions:['schedule.settings']})
    const settings={coverageEnabled:true,discussionEnabled:true,discussionHours:24}
    try {
      await saveMemberAccess(owner(),org,people.outsider.memberId,{organizationRoleId:null,assignments:[{locationId:second,roleId:role.id}]})
      await assert.rejects(at(()=>team.saveTeamSettings(people.outsider.id,org,settings),second),code('INSUFFICIENT_PERMISSIONS'))
      await saveMemberAccess(owner(),org,people.outsider.memberId,{organizationRoleId:role.id,assignments:[]})
      await at(()=>team.saveTeamSettings(people.outsider.id,org,settings),second)
      assert.equal((await at(()=>team.getTeamSettings(owner(),org))).discussionEnabled,true)
    } finally {
      await prisma.accessAssignment.deleteMany({where:{memberId:people.outsider.memberId}})
      await prisma.organizationMember.update({where:{id:people.outsider.memberId},data:{accessConfigured:false,accessRoleId:null}})
    }
  })
  it('keeps effective template versions and replaces/reset date exceptions without altering shifts',async()=>{
    const days=Array.from({length:7},()=>[{positionId:position,startTime:'08:00',endTime:'16:00',endDayOffset:0,needed:1}])
    await at(()=>team.saveDemand(owner(),org,{effectiveFrom:'2038-01-01',days}))
    await at(()=>team.saveDemand(owner(),org,{effectiveFrom:'2038-02-01',days:days.map(day=>day.map(row=>({...row,needed:2})))}))
    assert.equal((await at(()=>team.getDemand(owner(),org))).versions.length,2)
    assert.equal((await at(()=>team.getDemand(owner(),org),second)).versions.length,0)
    await at(()=>team.saveDemand(owner(),org,{date:'2038-01-03',intervals:[]}))
    const exception=(await at(()=>team.getCoverage(owner(),org,'2038-01-03','2038-01-04'))).days[0]
    assert.equal(exception.noDemand,true);assert.equal(exception.source,'exception')
    await at(()=>team.saveDemand(owner(),org,{date:'2038-01-03',intervals:null}))
    assert.equal((await at(()=>team.getCoverage(owner(),org,'2038-01-03','2038-01-04'))).days[0].source,'template')
    await assert.rejects(at(()=>team.saveDemand(owner(),org,{date:'2038-01-03',intervals:[{...days[0][0],endDayOffset:1,endTime:'10:00'}]})),code('DEMAND_DURATION'))
  })
  it('recalculates coverage after 15-date assignment, time change and cancellation',async()=>{
    const day='2038-01-10',shifts=Array.from({length:15},(_,i)=>input(addDays(day,i)))
    const saved=await at(()=>createShiftBatch(owner(),org,shifts))
    assert.equal((await at(()=>team.getCoverage(owner(),org,day,addDays(day,15)))).days.filter(d=>d.shortageIntervals).length,0)
    await at(()=>updateShift(owner(),org,saved.shifts[0].id,input(day,'employee',{startTime:'08:01'})))
    assert.equal((await at(()=>team.getCoverage(owner(),org,day,addDays(day,1)))).days[0].shortageIntervals,1)
    await at(()=>cancelShift(owner(),org,saved.shifts[1].id,'Тестовая отмена'))
    assert.equal((await at(()=>team.getCoverage(owner(),org,addDays(day,1),addDays(day,2)))).days[0].shortageIntervals,1)
  })
  it('keeps draft shifts out of work calendar, notifications and statistics tables',async()=>{
    const d=await makeDraft(false,'2038-02-10'),before=await prisma.workShift.count({where:{organizationId:org}}),notices=await prisma.accountNotification.count({where:{organizationId:org}})
    await propose(d.id,[input(d.fromDate)])
    assert.equal(await prisma.workShift.count({where:{organizationId:org}}),before)
    assert.equal(await prisma.accountNotification.count({where:{organizationId:org}}),notices)
    assert.equal((await at(()=>listSchedule(owner(),org,d.fromDate,addDays(d.toDate,1)))).shifts.length,0)
    const view=await detail(d.id);assert.equal(view.shifts.length,1);assert.equal(view.counts.create,1)
    await assert.rejects(detail(d.id,'employee'),code('DRAFT_NOT_FOUND'))
    await assert.rejects(at(()=>team.getDraft(people.alien.id,org,d.id)),code('ORGANIZATION_NOT_FOUND'))
    await assert.rejects(at(()=>team.getDraft(owner(),org,d.id),second),code('DRAFT_NOT_FOUND'))
  })
  it('loads current shifts without duplicates and empty drafts never cancel unspecified shifts',async()=>{
    const day='2038-03-01',s=await at(()=>createShift(owner(),org,input(day))),d=await makeDraft(true,day)
    const view=await detail(d.id);assert.equal(view.proposals[0].kind,'KEEP');assert.equal(view.shifts.filter(s=>s.id===view.proposals[0].sourceShiftId).length,1)
    await publish(d.id);await close(d.id);await act(d.id,'APPLY')
    assert.equal(await prisma.workShift.count({where:{organizationId:org,scheduledStartAt:s.scheduledStartAt,status:'SCHEDULED'}}),1)
    const empty=await makeDraft(false,day);await publish(empty.id);await close(empty.id);await act(empty.id,'APPLY')
    assert.equal((await prisma.workShift.findUniqueOrThrow({where:{id:s.id}})).status,'SCHEDULED')
  })
  it('prevents overlapping active periods and disabling an unfinished process',async()=>{
    const d=await makeDraft(false,'2038-03-10')
    await assert.rejects(makeDraft(false,d.fromDate),code('DRAFT_PERIOD_OVERLAP'))
    await assert.rejects(at(()=>team.saveTeamSettings(owner(),org,{coverageEnabled:true,discussionEnabled:false,discussionHours:24})),code('ACTIVE_DISCUSSION'))
    await assert.rejects(at(()=>team.saveTeamSettings(owner(),org,{coverageEnabled:true,discussionEnabled:false,discussionHours:24}),second),code('ACTIVE_DISCUSSION'))
    const other=await at(()=>team.saveTeamSettings(owner(),org,{coverageEnabled:true,discussionEnabled:true,discussionHours:24}),second)
    assert.equal(other.discussionEnabled,true)
    await at(()=>team.createDraft(owner(),org,schema.draftCreateBody.parse({title:'Другой график',fromDate:d.fromDate,toDate:d.toDate})),second)
  })
  it('snapshots a permitted audience and hides coworkers even when ordinary calendar is public',async()=>{
    const d=await makeDraft(false,'2038-04-01');await propose(d.id,[input(d.fromDate),input(d.fromDate,'colleague')]);await publish(d.id)
    const manager=await detail(d.id),employee=await detail(d.id,'employee')
    assert.ok(manager.recipients.some(r=>r.memberId===people.employee.memberId));assert.ok(!manager.recipients.some(r=>r.memberId===people.outsider.memberId))
    assert.equal(employee.shifts.length,1);assert.equal(employee.recipients.length,1);assert.ok(employee.proposals.every(p=>p.proposed.memberId===people.employee.memberId))
    await assert.rejects(detail(d.id,'outsider'),code('DRAFT_NOT_FOUND'))
    const history=await at(()=>listNotificationHistory(people.employee.id,people.employee.email,{organizationId:org,locationId:first,category:'SCHEDULE',limit:50}))
    const notice=history.notifications.find(n=>n.scheduleDraftId===d.id);assert.ok(notice?.href?.includes(`/schedule/drafts/${d.id}`));assert.ok(notice?.href?.includes(`location=${first}`))
    assert.equal(manager.counts.unanswered,manager.counts.participants)
    assert.equal((await detail(d.id,'employee')).recipients[0].response,null)
    await close(d.id);await act(d.id,'APPLY')
    const listed=await at(()=>team.listDrafts(people.employee.id,org))
    assert.ok(!JSON.stringify(listed).includes('appliedSnapshot'))
    assert.ok(!JSON.stringify(listed).includes(people.colleague.memberId))
    assert.ok((await detail(d.id,'employee')).shifts.every(s=>s.memberId===people.employee.memberId))
  })
  it('ties comments to own proposals and revisions, permits decisions and withdrawal without changing shifts',async()=>{
    const d=await makeDraft(false,'2038-04-10');await propose(d.id,[input(d.fromDate),input(d.fromDate,'colleague')]);await publish(d.id)
    const view=await detail(d.id),own=view.proposals.find(p=>p.proposed.memberId===people.employee.memberId)!,other=view.proposals.find(p=>p.proposed.memberId===people.colleague.memberId)!
    await assert.rejects(at(()=>team.commentOnDraft(people.employee.id,org,d.id,schema.draftCommentBody.parse({revision:view.revision,proposalId:other.id,text:'Чужая смена'}))),code('OWN_SHIFT_REQUIRED'))
    const c=await at(()=>team.commentOnDraft(people.employee.id,org,d.id,schema.draftCommentBody.parse({revision:view.revision,proposalId:own.id,text:'На эту дату согласовано отсутствие'})))
    assert.equal(c.status,'OPEN');assert.equal((await detail(d.id)).counts.objections,1)
    assert.equal(await prisma.workShift.count({where:{organizationId:org,scheduledStartAt:new Date(own.proposed.scheduledStartAt)}}),0)
    await assert.rejects(at(()=>team.respondToDraft(people.employee.id,org,d.id,{revision:view.revision,response:'NO_OBJECTIONS'})),code('OWN_OPEN_COMMENT'))
    await assert.rejects(at(()=>team.decideDraftComment(owner(),org,d.id,c.id,{action:'REJECTED',text:''})),code('EXPLANATION_REQUIRED'))
    await at(()=>team.decideDraftComment(owner(),org,d.id,c.id,{action:'RESOLVED',text:'Проверил отсутствие и исправил предложение'}))
    const c2=await at(()=>team.commentOnDraft(people.employee.id,org,d.id,{revision:view.revision,text:'Другое замечание'}))
    await at(()=>team.decideDraftComment(people.employee.id,org,d.id,c2.id,{action:'WITHDRAWN',text:''}))
    assert.equal((await detail(d.id)).comments.find(c=>c.id===c2.id)?.status,'WITHDRAWN')
  })
  it('invalidates only materially affected answers; cosmetic edits and other employees keep acknowledgements',async()=>{
    const d=await makeDraft(false,'2038-05-01');await propose(d.id,[input(d.fromDate),input(d.fromDate,'colleague')]);await publish(d.id)
    let view=await detail(d.id)
    for(const who of ['employee','colleague'])await at(()=>team.respondToDraft(people[who].id,org,d.id,{revision:view.revision,response:'NO_OBJECTIONS'}))
    await at(()=>team.editDraft(owner(),org,d.id,{revision:view.revision,title:'Новое название',description:'Описание'}));view=await detail(d.id)
    assert.equal(view.counts.noObjections,2)
    const own=view.proposals.find(p=>p.proposed.memberId===people.employee.memberId)!
    await assert.rejects(propose(d.id,[input(d.fromDate,'employee',{startTime:'09:00'})],{proposalId:own.id}),code('RESPONSE_WINDOW_REQUIRED'))
    await propose(d.id,[input(d.fromDate,'employee',{startTime:'09:00'})],{proposalId:own.id,confirmResponseWindow:true})
    view=await detail(d.id)
    const changed=view.recipients.find(r=>r.memberId===people.employee.memberId)!,kept=view.recipients.find(r=>r.memberId===people.colleague.memberId)!
    assert.notEqual(changed.respondedRevision,changed.requiredRevision);assert.equal(kept.respondedRevision,kept.requiredRevision)
    assert.ok(view.history.some(h=>h.action==='RESPONSE'))
  })
  it('expires without applying, requires explanation for early close, and reopens with notifications',async()=>{
    const d=await makeDraft(false,'2038-05-10');await propose(d.id,[input(d.fromDate)]);await publish(d.id)
    await assert.rejects(act(d.id,'CLOSE'),code('EXPLANATION_REQUIRED'))
    await prisma.scheduleDraft.update({where:{id:d.id},data:{deadline:new Date(Date.now()-1000)}})
    const expired=await detail(d.id);assert.equal(expired.status,'CLOSED')
    assert.equal(await prisma.workShift.count({where:{organizationId:org,scheduledStartAt:new Date(expired.proposals[0].proposed.scheduledStartAt)}}),0)
    await assert.rejects(at(()=>team.respondToDraft(people.employee.id,org,d.id,{revision:expired.revision,response:'NO_OBJECTIONS'})),code('DISCUSSION_CLOSED'))
    await act(d.id,'EXTEND',{deadline:new Date(Date.now()+3600000).toISOString()});assert.equal((await detail(d.id)).status,'OPEN')
    await assert.rejects(act(d.id,'APPLY'),code('DISCUSSION_NOT_CLOSED'))
  })
  it('blocks silently rebasing changed sources and explicitly refreshes the source snapshot',async()=>{
    const day='2038-06-01',s=await at(()=>createShift(owner(),org,input(day))),d=await makeDraft(true,day)
    const p=(await detail(d.id)).proposals[0]
    await propose(d.id,[input(day,'employee',{startTime:'09:00'})],{kind:'UPDATE',proposalId:p.id})
    await publish(d.id);await close(d.id)
    await at(()=>updateShift(owner(),org,s.id,input(day,'employee',{endTime:'17:00'})))
    assert.ok((await at(()=>team.validateDraft(owner(),org,d.id))).errors.some(e=>e.code==='SOURCE_CHANGED'))
    await assert.rejects(act(d.id,'APPLY'),code('DRAFT_CONFLICTS'))
    await propose(d.id,[],{kind:'REFRESH',proposalId:p.id,confirmResponseWindow:true,deadline:new Date(Date.now()+3600000).toISOString()})
    assert.ok(!(await at(()=>team.validateDraft(owner(),org,d.id))).errors.some(e=>e.code==='SOURCE_CHANGED'))
    await close(d.id);await act(d.id,'APPLY')
    assert.equal((await prisma.workShift.findUniqueOrThrow({where:{id:s.id}})).scheduledStartAt.toISOString(),day+'T06:00:00.000Z')
  })
  it('rechecks newly approved absence and organization-wide overlap at application',async()=>{
    const d=await makeDraft(false,'2038-06-10');await propose(d.id,[input(d.fromDate)]);await publish(d.id);await close(d.id)
    const absence=await prisma.employeeAbsence.create({data:{organizationId:org,memberId:people.employee.memberId,type:'VACATION',startDate:new Date(d.fromDate),endDate:new Date(d.fromDate)}})
    await assert.rejects(act(d.id,'APPLY'),code('DRAFT_CONFLICTS'));await prisma.employeeAbsence.delete({where:{id:absence.id}})
    const overlap=await at(()=>createShift(owner(),org,input(d.fromDate)))
    await assert.rejects(act(d.id,'APPLY'),code('DRAFT_CONFLICTS'));await at(()=>cancelShift(owner(),org,overlap.id,'Освобождаем время'))
    await act(d.id,'APPLY');assert.equal((await detail(d.id)).status,'APPLIED')
  })
  it('keeps editing separate from actual shift/apply grants and revokes participant access on departure',async()=>{
    const d=await makeDraft(false,'2038-07-01');await propose(d.id,[input(d.fromDate)]);await publish(d.id);await close(d.id)
    const view=await detail(d.id)
    await assert.rejects(at(()=>team.actOnDraft(people.editor.id,org,d.id,schema.draftActionBody.parse({revision:view.revision,action:'APPLY'}))),code('INSUFFICIENT_PERMISSIONS'))
    await prisma.organizationMember.update({where:{id:people.employee.memberId},data:{leftAt:new Date()}})
    try{await assert.rejects(detail(d.id,'employee'),code('ORGANIZATION_NOT_FOUND'));await assert.rejects(act(d.id,'APPLY'),code('DRAFT_CONFLICTS'))}finally{await prisma.organizationMember.update({where:{id:people.employee.memberId},data:{leftAt:null}})}
  })
  it('requires explicit explanation for open objections, applies once concurrently and preserves immutable history',async()=>{
    const d=await makeDraft(false,'2038-07-10');await propose(d.id,[input(d.fromDate)]);await publish(d.id)
    let view=await detail(d.id)
    await at(()=>team.commentOnDraft(people.employee.id,org,d.id,{revision:view.revision,text:'Прошу проверить назначение'}));await close(d.id)
    await assert.rejects(act(d.id,'APPLY'),code('OPEN_COMMENTS'))
    view=await detail(d.id)
    const args=schema.draftActionBody.parse({revision:view.revision,action:'APPLY',confirm:true,explanation:'Смена необходима, замечание рассмотрено руководителем'})
    const results=await Promise.allSettled([at(()=>team.actOnDraft(owner(),org,d.id,args)),at(()=>team.actOnDraft(owner(),org,d.id,args))])
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    const applied=await detail(d.id),shiftId=applied.proposals[0].appliedShiftId!
    assert.equal(await prisma.accountNotification.count({where:{shiftId,type:'SHIFT_ASSIGNED'}}),1)
    await assert.rejects(act(d.id,'APPLY'),code('DRAFT_CLOSED'))
    const previous=applied.shifts[0].scheduledEndAt
    await at(()=>updateShift(owner(),org,shiftId,input(d.fromDate,'employee',{endTime:'17:00'})))
    assert.equal((await detail(d.id)).shifts[0].scheduledEndAt,previous)
    assert.ok((await detail(d.id)).history.some(h=>h.action==='APPLY'&&h.details && typeof h.details==='object' && 'explanation' in h.details))
  })
  it('rolls back the whole application and notifications when the second shift fails',async()=>{
    const d=await makeDraft(false,'2038-08-01');await propose(d.id,[input(d.fromDate),input(addDays(d.fromDate,1))]);await publish(d.id);await close(d.id)
    const shiftIds=(await detail(d.id)).proposals.map(p=>p.proposed.memberId)
    assert.equal(shiftIds.length,2)
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_test_draft_shift() RETURNS trigger AS $$ BEGIN IF NEW.organization_id='${org}'::uuid AND (SELECT count(*) FROM work_shifts WHERE organization_id='${org}'::uuid AND scheduled_start_at >= '${d.fromDate}'::date AND scheduled_start_at < '${addDays(d.toDate,1)}'::date) > 0 THEN RAISE EXCEPTION 'test atomic failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_test_draft_shift BEFORE INSERT ON work_shifts FOR EACH ROW EXECUTE FUNCTION reject_test_draft_shift()')
    const before=await prisma.accountNotification.count({where:{organizationId:org}})
    try{await assert.rejects(act(d.id,'APPLY'));assert.equal(await prisma.workShift.count({where:{organizationId:org,scheduledStartAt:{gte:new Date(d.fromDate),lt:new Date(addDays(d.toDate,1))}}}),0);assert.equal(await prisma.accountNotification.count({where:{organizationId:org}}),before);assert.equal((await detail(d.id)).status,'CLOSED')}finally{await prisma.$executeRawUnsafe('DROP TRIGGER reject_test_draft_shift ON work_shifts');await prisma.$executeRawUnsafe('DROP FUNCTION reject_test_draft_shift()')}
    await act(d.id,'APPLY')
  })
  it('allows aggregate coverage and demand editing without exposing the staff directory or shifts',async()=>{
    const role=await saveAccessRole(owner(),org,null,{name:'Только потребность',description:'',permissions:['coverage.manage']})
    await saveMemberAccess(owner(),org,people.colleague.memberId,{organizationRoleId:null,assignments:[{locationId:first,roleId:role.id}]})
    try {
      const planning=await at(()=>planningData(people.colleague.id,org))
      assert.ok(planning.positions.some(p=>p.id===position));assert.equal(planning.assignments.length,0)
      const schedule=await at(()=>listSchedule(people.colleague.id,org,'2039-01-01','2039-01-02'))
      assert.equal(schedule.shifts.length,0);assert.equal(schedule.absences.length,0)
      const coverage=await at(()=>team.getCoverage(people.colleague.id,org,'2039-01-01','2039-01-02'))
      assert.ok(coverage.days[0].segments.length);assert.ok(!JSON.stringify(coverage).includes(people.employee.memberId))
      await assert.rejects(at(()=>team.saveTeamSettings(people.colleague.id,org,{coverageEnabled:false,discussionEnabled:true,discussionHours:24})),code('INSUFFICIENT_PERMISSIONS'))
    } finally {await prisma.accessAssignment.deleteMany({where:{memberId:people.colleague.memberId}});await prisma.organizationMember.update({where:{id:people.colleague.memberId},data:{accessConfigured:false}})}
  })
  it('resolves same-effective-date revisions deterministically while retaining all versions',async()=>{
    const days=Array.from({length:7},()=>[{positionId:position,startTime:'08:00',endTime:'16:00',endDayOffset:0,needed:3}])
    await at(()=>team.saveDemand(owner(),org,{effectiveFrom:'2039-01-01',days}))
    await at(()=>team.saveDemand(owner(),org,{effectiveFrom:'2039-01-01',days:days.map(day=>day.map(row=>({...row,needed:4})))}))
    const versions=(await at(()=>team.getDemand(owner(),org))).versions.filter(v=>v.effectiveFrom==='2039-01-01')
    assert.equal(versions.length,2);assert.equal((await at(()=>team.getCoverage(owner(),org,'2039-01-01','2039-01-02'))).days[0].segments[0].needed,4)
  })
  it('adds new point participants explicitly without resetting earlier answers',async()=>{
    const d=await makeDraft(false,'2039-02-01');await propose(d.id,[input(d.fromDate)]);await publish(d.id)
    let v=await detail(d.id);await at(()=>team.respondToDraft(people.employee.id,org,d.id,{revision:v.revision,response:'NO_OBJECTIONS'}))
    await prisma.locationMember.create({data:{organizationId:org,locationId:first,memberId:people.outsider.memberId}})
    try {await assert.rejects(detail(d.id,'outsider'),code('DRAFT_NOT_FOUND'));await act(d.id,'REFRESH_RECIPIENTS');v=await detail(d.id);assert.equal(v.recipients.find(r=>r.memberId===people.employee.memberId)?.response,'NO_OBJECTIONS');assert.equal((await detail(d.id,'outsider')).recipients[0].response,null)}
    finally{await prisma.locationMember.delete({where:{locationId_memberId:{locationId:first,memberId:people.outsider.memberId}}})}
  })
  it('keeps reassignment snapshots private and preserves what an employee acknowledged',async()=>{
    const day='2039-03-01',source=await at(()=>createShift(owner(),org,input(day))),d=await makeDraft(true,day)
    const p=(await detail(d.id)).proposals[0];await propose(d.id,[input(day,'colleague')],{kind:'UPDATE',proposalId:p.id});await publish(d.id)
    const previous=await detail(d.id,'employee'),next=await detail(d.id,'colleague')
    assert.equal(previous.counts.cancel,1);assert.equal(previous.counts.update,0);assert.equal(previous.proposals[0].kind,'CANCEL');assert.equal(previous.proposals[0].proposed.memberId,people.employee.memberId)
    assert.equal(next.proposals[0].source,null);assert.ok(!JSON.stringify(next).includes(people.employee.memberId))
    await at(()=>team.respondToDraft(people.colleague.id,org,d.id,{revision:next.revision,response:'NO_OBJECTIONS'}))
    const event=(await detail(d.id)).history.find(h=>h.action==='RESPONSE')!
    assert.ok(event.details&&typeof event.details==='object'&&'shifts'in event.details&&Array.isArray(event.details.shifts)&&event.details.shifts.length===1)
    await close(d.id);await act(d.id,'APPLY');assert.equal((await prisma.workShift.findUniqueOrThrow({where:{id:source.id}})).memberId,people.colleague.memberId)
  })
  it('blocks active transfers, changed positions and shifts that acquired actual time',async()=>{
    const day='2039-04-01',source=await at(()=>createShift(owner(),org,input(day))),d=await makeDraft(true,day),p=(await detail(d.id)).proposals[0]
    await propose(d.id,[input(day,'employee',{startTime:'09:00'})],{kind:'UPDATE',proposalId:p.id});await publish(d.id);await close(d.id)
    await at(()=>saveOfferModes(owner(),org,{transferMode:'AUTO',swapMode:'AUTO'}))
    const offer=await at(()=>createOffer(people.employee.id,org,offerBody.parse({sourceShiftId:source.id,kind:'TRANSFER',recipientMemberId:people.colleague.memberId})))
    assert.ok((await at(()=>team.validateDraft(owner(),org,d.id))).errors.some(e=>e.code==='SHIFT_HAS_OFFER'));await assert.rejects(act(d.id,'APPLY'),code('DRAFT_CONFLICTS'))
    await at(()=>actOnOffer(people.employee.id,org,offer.id,'cancel'))
    await prisma.memberPosition.delete({where:{memberId_positionId:{memberId:people.employee.memberId,positionId:position}}})
    try{await assert.rejects(act(d.id,'APPLY'),code('DRAFT_CONFLICTS'))}finally{await prisma.memberPosition.create({data:{memberId:people.employee.memberId,positionId:position}})}
    await prisma.workShift.update({where:{id:source.id},data:{actualStartAt:new Date(source.scheduledStartAt),actualEndAt:new Date(source.scheduledEndAt),actualBreakMinutes:0}})
    await propose(d.id,[],{kind:'REFRESH',proposalId:p.id,confirmResponseWindow:true,deadline:new Date(Date.now()+3600000).toISOString()})
    assert.ok((await at(()=>team.validateDraft(owner(),org,d.id))).errors.some(e=>e.code==='SHIFT_STARTED'))
  })
  it('requires workload acknowledgement and atomically swaps existing assignments without transient overlap',async()=>{
    const day='2039-05-01',a=await at(()=>createShift(owner(),org,input(day))),b=await at(()=>createShift(owner(),org,input(day,'colleague'))),d=await makeDraft(true,day)
    const v=await detail(d.id)
    for(const p of v.proposals)await propose(d.id,[input(day,p.proposed.memberId===people.employee.memberId?'colleague':'employee')],{kind:'UPDATE',proposalId:p.id})
    await publish(d.id);await close(d.id);await prisma.organizationLocation.update({where:{id:first},data:{monthlyWorkMinutes:60}})
    try{await assert.rejects(act(d.id,'APPLY'),code('WORKLOAD_WARNING'));await act(d.id,'APPLY',{acknowledgeWorkload:true})}finally{await prisma.organizationLocation.update({where:{id:first},data:{monthlyWorkMinutes:null}})}
    assert.equal((await prisma.workShift.findUniqueOrThrow({where:{id:a.id}})).memberId,people.colleague.memberId);assert.equal((await prisma.workShift.findUniqueOrThrow({where:{id:b.id}})).memberId,people.employee.memberId)
  })
  it('derives coverage from actual assigned shifts after transfer, swap and confirmed staffing only',async()=>{
    const day='2039-06-01',a=await at(()=>createShift(owner(),org,input(day))),b=await at(()=>createShift(owner(),org,input(addDays(day,1),'colleague')))
    const before=await at(()=>team.getCoverage(owner(),org,day,addDays(day,2)))
    const offer=await at(()=>createOffer(people.employee.id,org,offerBody.parse({sourceShiftId:a.id,kind:'SWAP',targetShiftId:b.id,recipientMemberId:people.colleague.memberId})))
    await at(()=>actOnOffer(people.colleague.id,org,offer.id,'accept'));assert.deepEqual((await at(()=>team.getCoverage(owner(),org,day,addDays(day,2)))).days,before.days)
    const transfer=await at(()=>createOffer(people.colleague.id,org,offerBody.parse({sourceShiftId:a.id,kind:'TRANSFER',recipientMemberId:people.employee.memberId})))
    await at(()=>actOnOffer(people.employee.id,org,transfer.id,'accept'));assert.deepEqual((await at(()=>team.getCoverage(owner(),org,day,addDays(day,2)))).days,before.days)
    const staffing=(await at(()=>listRequestTypes(owner(),org))).find(t=>t.systemCode==='STAFFING')!,date=addDays(day,2)
    await prisma.memberPosition.create({data:{memberId:people.outsider.memberId,positionId:position}})
    const request=await at(()=>createRequest(owner(),org,{requestTypeId:staffing.id,staffingPositionId:position,proposedStartDate:date,proposedEndDate:date,proposedStartTime:'08:00',proposedEndTime:'16:00'}))
    const response=await at(()=>respondToStaffing(people.outsider.id,org,request.id))
    assert.equal((await at(()=>team.getCoverage(owner(),org,date,addDays(date,1)))).days[0].segments[0].assigned,0)
    await at(()=>resolveRequest(owner(),org,response.id,'APPROVED',null))
    assert.equal((await at(()=>team.getCoverage(owner(),org,date,addDays(date,1)))).days[0].segments[0].assigned,1)
    const otherCoverage=await at(()=>team.getCoverage(owner(),org,date,addDays(date,1)),second)
    assert.equal(otherCoverage.days[0].source,'unconfigured');assert.deepEqual(otherCoverage.days[0].segments,[])
  })
  it('saves a single selected week without changing demand on any other dates',async()=>{
    const days=Array.from({length:7},(_,index)=>addDays('2041-01-07',index))
    const before=(await at(()=>team.getCoverage(owner(),org,'2041-01-14','2041-01-15'))).days
    const intervals=[{positionId:position,startTime:'09:00',endTime:'20:00',endDayOffset:0,needed:5}]
    await at(()=>team.saveDemandDates(owner(),org,schema.demandDatesBody.parse({dates:days.map(date=>({date,intervals}))})))
    const demand=await at(()=>team.getDemand(owner(),org))
    assert.equal(demand.exceptions.filter(day=>days.includes(day.date)).length,7)
    assert.deepEqual((await at(()=>team.getCoverage(owner(),org,'2041-01-14','2041-01-15'))).days,before)
    await assert.rejects(at(()=>team.saveDemandDates(people.employee.id,org,{dates:[{date:days[0],intervals}]})),code('INSUFFICIENT_PERMISSIONS'))
    await at(()=>team.saveDemandDates(owner(),org,{dates:days.map(date=>({date,intervals:null}))}))
    assert.equal((await at(()=>team.getDemand(owner(),org))).exceptions.filter(day=>days.includes(day.date)).length,0)
  })
  it('rejects conflicting date replacements atomically across midnight',async()=>{
    const dates=[{date:'2041-02-01',intervals:[{positionId:position,startTime:'20:00',endTime:'08:00',endDayOffset:1,needed:1}]},{date:'2041-02-02',intervals:[{positionId:position,startTime:'07:00',endTime:'15:00',endDayOffset:0,needed:1}]}]
    await assert.rejects(at(()=>team.saveDemandDates(owner(),org,{dates})),code('DEMAND_OVERLAP'))
    assert.equal((await at(()=>team.getDemand(owner(),org))).exceptions.filter(day=>dates.some(value=>value.date===day.date)).length,0)
    assert.equal(schema.demandDatesBody.safeParse({dates:[dates[0],dates[0]]}).success,false)
  })
  it('repeats the visible week including Sunday off and removes only seed-week overrides',async()=>{
    const monday='2042-04-07',week=Array.from({length:7},(_,i)=>addDays(monday,i))
    const interval={positionId:position,startTime:'09:00',endTime:'18:00',endDayOffset:0,needed:2}
    await at(()=>team.saveDemandDates(owner(),org,{dates:[{date:week[6],intervals:[]},{date:addDays(monday,14),intervals:[]}]}))
    const days=week.map((_,i)=>i===6?[]:[interval])
    await at(()=>team.saveDemandDates(owner(),org,schema.demandDatesBody.parse({dates:week.map(date=>({date,intervals:null})),repeat:{effectiveFrom:monday,days}})))
    const demand=await at(()=>team.getDemand(owner(),org))
    assert.ok(!demand.exceptions.some(day=>week.includes(day.date)))
    assert.ok(demand.exceptions.some(day=>day.date===addDays(monday,14)))
    const next=(await at(()=>team.getCoverage(owner(),org,addDays(monday,7),addDays(monday,14)))).days
    assert.equal(next[0].segments.find(s=>s.needed>0)?.needed,2)
    assert.equal(next[6].noDemand,true)
    await at(()=>team.saveDemandDates(owner(),org,{dates:[],repeat:{effectiveFrom:addDays(monday,21),days:Array(7).fill(null)}}))
    assert.equal((await at(()=>team.getCoverage(owner(),org,addDays(monday,21),addDays(monday,22)))).days[0].source,'unconfigured')
    assert.equal(schema.demandDatesBody.safeParse({dates:[]}).success,false)
  })
  it('rolls back both the repeating week and date changes when their final plan overlaps',async()=>{
    const monday='2042-06-02',interval={positionId:position,startTime:'09:00',endTime:'18:00',endDayOffset:0,needed:1}
    const before=await at(()=>team.getDemand(owner(),org))
    const days=Array.from({length:7},()=>[interval])
    await assert.rejects(at(()=>team.saveDemandDates(owner(),org,{dates:[{date:addDays(monday,1),intervals:[{...interval,startTime:'08:00',endTime:'10:00'}]},{date:monday,intervals:[{...interval,startTime:'20:00',endTime:'09:00',endDayOffset:1}]}],repeat:{effectiveFrom:monday,days}})),code('DEMAND_OVERLAP'))
    assert.deepEqual(await at(()=>team.getDemand(owner(),org)),before)
    await assert.rejects(at(()=>team.saveDemandDates(people.employee.id,org,{dates:[],repeat:{effectiveFrom:monday,days}})),code('INSUFFICIENT_PERMISSIONS'))
  })
  it('lists own discussions on the home module without settings access and closes with confirmation alone',async()=>{
    const d=await makeDraft(false,'2041-03-01');await propose(d.id,[input(d.fromDate)])
    assert.ok(!(await at(()=>team.listDraftInbox(people.employee.id,org))).drafts.some(value=>value.id===d.id))
    await publish(d.id)
    const own=(await at(()=>team.listDraftInbox(people.employee.id,org))).drafts.find(value=>value.id===d.id)!
    assert.equal(own.canManage,false);assert.equal(own.needsResponse,true)
    assert.ok(!JSON.stringify(own).includes('appliedSnapshot'))
    assert.ok(!(await at(()=>team.listDraftInbox(people.outsider.id,org),second)).drafts.some(value=>value.id===d.id))
    await act(d.id,'CLOSE',{confirm:true})
    assert.equal((await detail(d.id)).status,'CLOSED')
    assert.equal((await at(()=>team.listDraftInbox(owner(),org))).drafts.find(value=>value.id===d.id)?.canManage,true)
  })
  it('cancels discussions without touching work shifts and preserves saved demand while disabled',async()=>{
    const d=await makeDraft(false,'2038-08-10');await propose(d.id,[input(d.fromDate)]);await publish(d.id)
    const count=await prisma.workShift.count({where:{organizationId:org}})
    await act(d.id,'CANCEL',{confirm:true,explanation:'Период планирования изменён'})
    assert.equal(await prisma.workShift.count({where:{organizationId:org}}),count);assert.equal((await detail(d.id)).status,'CANCELLED')
    for(const point of [first,second])for(const row of (await at(()=>team.listDrafts(owner(),org),point)).drafts.filter(d=>['PREPARING','OPEN','CLOSED'].includes(d.status))) {
      await at(()=>team.actOnDraft(owner(),org,row.id,schema.draftActionBody.parse({revision:row.revision,action:'CANCEL',confirm:true,explanation:'Завершаем тестовый процесс'})),point)
    }
    await at(()=>team.saveTeamSettings(owner(),org,{coverageEnabled:false,discussionEnabled:false,discussionHours:24}))
    assert.deepEqual((await at(()=>team.getCoverage(owner(),org,d.fromDate,addDays(d.toDate,1)))).days,[])
    assert.deepEqual(await at(()=>team.getTeamSettings(owner(),org),second),{coverageEnabled:false,discussionEnabled:false,discussionHours:24})
    assert.ok((await at(()=>team.getDemand(owner(),org))).versions.length>0)
    assert.equal((await detail(d.id)).status,'CANCELLED')
  })
})
