import { readRequestPage, requestInclude } from '../../src/server/requests/request-read.ts'
import { performanceSnapshot } from '../../src/server/performance.ts'
import { calculateCoverage } from '../../src/server/schedule/planning/coverage.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { respondToStaffing,cancelRequest } from '../../src/server/requests/service.ts'
import { listNotificationHistory } from '../../src/server/organizations/notification-service.ts'
import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization as createOrganization } from '../support/business-organization.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { createRequest, createRequestType, deleteRequestType, listRequestTypes, updateRequestType, updateRequest, submitRequest, resolveRequest, returnRequest, getRequest, listRequests, amendVacation } from '../../src/server/requests/service.ts'
import { createCampaign, answerCampaign, listVacationPlanning, campaignBody, vacationResponseBody } from '../../src/server/requests/vacations.ts'
import { createShift, setShiftAttendance, assertNoApprovedAbsence } from '../../src/server/schedule/service.ts'
import { organizationStatistics } from '../../src/server/schedule/time/statistics.ts'
import { buildReport } from '../../src/server/schedule/reports/report-service.ts'
import { reportBody } from '../../src/server/schedule/reports/report-schemas.ts'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'
import { addRequestAttachment } from '../../src/server/requests/attachment-service.ts'
import { definitionOf, vacationDays } from '../../src/app/requests/workflow.ts'
import { maintainRequests } from '../../src/server/requests/worker.ts'
import { changeAbsence } from '../../src/server/schedule/absence-service.ts'
import { saveAccessRole, saveMemberAccess } from '../../src/server/organizations/access/access-service.ts'
import { normalizePermissions } from '../../src/app/access/catalog.ts'
const code=(c:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===c
let org:string,point:string,owner:string,employee:string,employeeMember:string,admin:string,adminMember:string,other:string
let vacation:string
before(async()=>{
  async function user(name:string){return prisma.user.create({data:{email:`workflow-${name}-${randomUUID()}@example.test`,passwordHash:'test',emailVerifiedAt:new Date()}})}
  owner=(await user('owner')).id;employee=(await user('employee')).id;admin=(await user('admin')).id;other=(await user('other')).id
  const o=await createOrganization(owner,{name:'Проверка заявок',timezone:'Europe/Moscow',description:null});org=o.id;point=(await getMembership(owner,org)).locationId
  for(const [userId,role]of [[employee,'MEMBER'],[admin,'ADMIN'],[other,'MEMBER']]as const){const m=await prisma.organizationMember.create({data:{organizationId:org,userId,role}});await prisma.locationMember.create({data:{organizationId:org,locationId:point,memberId:m.id,role}});if(userId===employee)employeeMember=m.id;if(userId===admin)adminMember=m.id}
  vacation=(await listRequestTypes(owner,org)).find(t=>t.systemCode==='VACATION')!.id
})
after(async()=>{
  if(org){await prisma.accountNotification.deleteMany({where:{organizationId:org}});await prisma.employeeAbsence.deleteMany({where:{organizationId:org}});await prisma.organizationRequest.deleteMany({where:{organizationId:org}});await prisma.vacationCampaign.deleteMany({where:{organizationId:org}});await prisma.workShift.deleteMany({where:{organizationId:org}});await prisma.documentFolder.deleteMany({where:{organizationId:org}});await prisma.organization.delete({where:{id:org}})}
  await prisma.$disconnect()
})
describe('request refactor: processes, roles, files and accounting',()=>{
  it('deletes unused custom types while protecting system types and permissions', async () => {
    const type = await createRequestType(owner, org, { name: 'Удаляемый тип', dateMode: 'NONE', requiresComment: false, allowsAttachments: false })
    await assert.rejects(deleteRequestType(employee, org, type.id), code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(deleteRequestType(owner, org, vacation), code('SYSTEM_REQUEST_TYPE'))
    await assert.rejects(deleteRequestType(owner, org, randomUUID()), code('REQUEST_TYPE_NOT_FOUND'))
    await deleteRequestType(owner, org, type.id)
    assert.equal(await prisma.requestType.findUnique({ where: { id: type.id } }), null)
    assert.ok(!(await listRequestTypes(owner, org, true)).some(t => t.id === type.id))
  })
  it('removes used types from settings and submission while preserving old request processing', async () => {
    const type = await createRequestType(owner, org, { name: 'История удалённого типа', dateMode: 'SINGLE', requiresComment: false, allowsAttachments: false })
    const request = await createRequest(employee, org, { requestTypeId: type.id, startDate: '2079-07-01', draft: true })
    // Legacy requests did not store the standard form settings in their snapshot.
    await prisma.organizationRequest.update({ where: { id: request.id }, data: { formSnapshot: {} } })
    await deleteRequestType(owner, org, type.id)
    await deleteRequestType(owner, org, type.id)
    assert.ok(!(await listRequestTypes(owner, org, true)).some(t => t.id === type.id))
    await assert.rejects(createRequest(employee, org, { requestTypeId: type.id }), code('REQUEST_TYPE_NOT_FOUND'))
    await assert.rejects(updateRequestType(owner, org, type.id, { ...type, isActive: true }), code('REQUEST_TYPE_NOT_FOUND'))
    assert.equal((await getRequest(employee, org, request.id)).request.formSnapshot.dateMode, 'SINGLE')
    await updateRequest(employee, org, request.id, { requestTypeId: type.id, startDate: '2079-07-02', comment: 'Уточнено после удаления типа' })
    await submitRequest(employee, org, request.id)
    await resolveRequest(owner, org, request.id, 'APPROVED', null)
    const saved = (await getRequest(employee, org, request.id)).request
    assert.equal(saved.status, 'APPROVED')
    assert.equal(saved.typeNameSnapshot, type.name)
    assert.ok(saved.events.length >= 3)
  })
  it('counts federal holidays and handles leap days',()=>{assert.equal(vacationDays('2027-01-01','2027-01-14'),6);assert.equal(vacationDays('2028-02-28','2028-03-01'),3);assert.equal(vacationDays('2028-02-28','2028-03-01',['2028-02-29']),2)})
  it('shows a coverage shortage for no-show while preserving the planned assignment',()=>{
    const shifts=[{memberId:'person',positionId:'position',status:'SCHEDULED',attendance:'NO_SHOW',scheduledStartAt:'2020-04-01T09:00:00Z',scheduledEndAt:'2020-04-01T17:00:00Z'}]
    const coverage=calculateCoverage('2020-04-01','2020-04-02','UTC',[],[{date:'2020-04-01',intervals:[{positionId:'position',startTime:'09:00',endTime:'17:00',endDayOffset:0,needed:1}]}],shifts,[{id:'position',name:'Кассир'}])
    assert.equal(coverage[0].segments[0].assigned,0);assert.equal(coverage[0].segments[0].shortage,1)
  })
  it('keeps disabled workflows processable and submits a draft only once',async()=>{
    const t=await createRequestType(owner,org,{name:'Согласование покупки',dateMode:'NONE',requiresComment:false,allowsAttachments:true})
    const input={requestTypeId:t.id,comment:'Покупка',draft:true,submissionKey:randomUUID()}
    const r=await createRequest(employee,org,input);assert.equal(r.status,'DRAFT');assert.equal((await createRequest(employee,org,input)).id,r.id)
    await updateRequestType(owner,org,t.id,{...t,definition:t.definition,isActive:false})
    await assert.rejects(createRequest(employee,org,{requestTypeId:t.id}),code('REQUEST_TYPE_NOT_FOUND'))
    await updateRequest(employee,org,r.id,{...input,comment:'Уточнение'})
    assert.equal((await submitRequest(employee,org,r.id)).status,'PENDING');assert.equal((await submitRequest(employee,org,r.id)).status,'PENDING')
    await resolveRequest(owner,org,r.id,'APPROVED',null);assert.equal((await getRequest(employee,org,r.id)).request.status,'APPROVED')
  })
  it('enforces atomic file limit under concurrent uploads',async()=>{
    const t=await createRequestType(owner,org,{name:'Файлы',dateMode:'NONE',requiresComment:false,allowsAttachments:true}),r=await createRequest(employee,org,{requestTypeId:t.id,draft:true})
    const results=await Promise.allSettled(Array.from({length:8},(_,i)=>addRequestAttachment(employee,org,r.id,Buffer.from('%PDF-1.4\n%%EOF'),'application/pdf',`file-${i}.pdf`)))
    assert.equal(results.filter(r=>r.status==='fulfilled').length,5);assert.equal(await prisma.requestAttachment.count({where:{requestId:r.id}}),5)
    await submitRequest(employee,org,r.id);await resolveRequest(owner,org,r.id,'APPROVED',null);await assert.rejects(addRequestAttachment(employee,org,r.id,Buffer.from('%PDF-1.4\n%%EOF'),'application/pdf'),code('ATTACHMENT_FORBIDDEN'))
  })
  it('preserves form snapshots, returns for rework and executes sequential reviewers',async()=>{
    const definition=definitionOf({fields:[{key:'amount',label:'Сумма',kind:'MONEY',required:true}],stages:[{name:'Администратор',memberId:adminMember},{name:'Владелец',memberId:(await getMembership(owner,org)).id}]})
    const t=await createRequestType(owner,org,{name:'Два этапа',dateMode:'NONE',requiresComment:false,allowsAttachments:false,definition})
    await assert.rejects(createRequest(employee,org,{requestTypeId:t.id}),code('REQUIRED_FIELD'))
    const r=await createRequest(employee,org,{requestTypeId:t.id,answers:{amount:100}})
    await assert.rejects(getRequest(other,org,r.id),code('REQUEST_NOT_FOUND'))
    await assert.rejects(resolveRequest(owner,org,r.id,'APPROVED',null),code('WRONG_REVIEWER'))
    await returnRequest(admin,org,r.id,'Уточните сумму');await updateRequest(employee,org,r.id,{requestTypeId:t.id,answers:{amount:200}});await submitRequest(employee,org,r.id)
    await updateRequestType(owner,org,t.id,{...t,definition:definitionOf({}),isActive:true})
    assert.equal((await resolveRequest(admin,org,r.id,'APPROVED',null)).status,'PENDING');assert.equal((await resolveRequest(owner,org,r.id,'APPROVED',null)).status,'APPROVED')
    assert.equal(definitionOf((await getRequest(employee,org,r.id)).request.formSnapshot).fields[0].key,'amount')
  })
  it('rejects role and member references from another organization',async()=>{
    const otherOrg=await createOrganization(other,{name:'Другая организация',timezone:'Europe/Moscow',description:null}),foreign=(await prisma.accessRole.findFirstOrThrow({where:{organizationId:otherOrg.id}})).id
    await assert.rejects(createRequestType(owner,org,{name:'Чужой маршрут',dateMode:'NONE',requiresComment:false,allowsAttachments:false,definition:{stages:[{name:'Чужая роль',roleId:foreign}]}}),code('INVALID_WORKFLOW_AUDIENCE'))
  })
  it('collects independent multiple periods and protects campaign audience',async()=>{
    const c=await createCampaign(owner,org,campaignBody.parse({title:'Отпуска 2070',year:2070,dueAt:'2069-12-01T12:00:00Z',locationId:point,memberIds:[employeeMember,adminMember]}))
    await assert.rejects(answerCampaign(other,org,c.id,vacationResponseBody.parse({submissionKey:randomUUID(),periods:[{startDate:'2070-03-01',endDate:'2070-03-14'}]})),code('CAMPAIGN_NOT_FOUND'))
    const input=vacationResponseBody.parse({submissionKey:randomUUID(),periods:[{startDate:'2070-03-01',endDate:'2070-03-14'},{startDate:'2070-06-01',endDate:'2070-06-14'}]})
    const u=await prisma.user.findUniqueOrThrow({where:{id:employee}});const history=await listNotificationHistory(employee,u.email,{limit:50,organizationId:org});assert.ok(history.notifications.some(n=>n.type==='REQUEST_VACATION_COLLECTION'&&n.href?.includes('tab=vacations&year=2070')));
    const r=await answerCampaign(employee,org,c.id,input);assert.equal(r.length,2);assert.deepEqual((await answerCampaign(employee,org,c.id,input)).map(r=>r.id),r.map(r=>r.id))
    await resolveRequest(owner,org,r[0].id,'APPROVED',null);assert.equal((await prisma.organizationRequest.findUniqueOrThrow({where:{id:r[1].id}})).status,'PENDING')
    const view=await listVacationPlanning(employee,org,2070);assert.equal(view.campaigns.find(x=>x.id===c.id)!.members.length,1);assert.equal(view.campaigns.find(x=>x.id===c.id)!.timezone,'Europe/Moscow');assert.ok(view.requests.every(x=>x.memberId===employeeMember))
  })
  it('keeps original vacation dates and approved amendments update the effective absence',async()=>{
    const r=await createRequest(employee,org,{requestTypeId:vacation,startDate:'2071-04-01',endDate:'2071-04-14'});await resolveRequest(owner,org,r.id,'APPROVED',null)
    const amendment=await amendVacation(employee,org,r.id,'2071-05-01','2071-05-14','Прошу перенести');await resolveRequest(owner,org,amendment.id,'APPROVED',null)
    const original=await prisma.organizationRequest.findUniqueOrThrow({where:{id:r.id}}),absence=await prisma.employeeAbsence.findUniqueOrThrow({where:{sourceRequestId:r.id}})
    assert.equal(original.startDate!.toISOString().slice(0,10),'2071-04-01');assert.equal(absence.startDate.toISOString().slice(0,10),'2071-05-01')
    await assert.rejects(assertNoApprovedAbsence(org,employeeMember,new Date('2071-05-02T06:00:00Z'),new Date('2071-05-02T14:00:00Z'),'Europe/Moscow',prisma,true),code('VACATION_CONFLICT'))
    await assert.rejects(changeAbsence(owner,org,absence.id,{startDate:'2071-05-02',endDate:'2071-05-15',updatedAt:absence.updatedAt.toISOString()}),code('VACATION_CONSENT'))
  })
  it('requires explicit processing of vacation shift conflicts',async()=>{
    await createShift(owner,org,{memberId:employeeMember,startDate:'2072-07-02',endDate:'2072-07-02',startTime:'09:00',endTime:'17:00',breakMinutes:0,description:null})
    const r=await createRequest(employee,org,{requestTypeId:vacation,startDate:'2072-07-01',endDate:'2072-07-14'})
    await assert.rejects(resolveRequest(owner,org,r.id,'APPROVED',null),code('UNRESOLVED_SHIFTS'));await resolveRequest(owner,org,r.id,'APPROVED',null,true)
  })
  it('shows a moved approved vacation in its effective calendar year with employee identity', async () => {
    const original = await createRequest(employee, org, { requestTypeId: vacation, startDate: '2081-12-01', endDate: '2081-12-14' })
    await resolveRequest(owner, org, original.id, 'APPROVED', null)
    const amendment = await amendVacation(employee, org, original.id, '2082-01-10', '2082-01-23', 'Перенос на следующий год')
    await resolveRequest(owner, org, amendment.id, 'APPROVED', null)
    const calendar = await listVacationPlanning(owner, org, 2082)
    const effective = calendar.requests.find(request => request.id === original.id)
    assert.equal(effective?.currentStartDate, '2082-01-10')
    assert.equal(effective?.startDate, '2081-12-01')
    assert.ok(effective && 'avatarUrl' in effective)
    assert.ok(!calendar.requests.some(request => request.id === amendment.id))
  })
  it('tracks no-show and partial attendance consistently in statistics and reports',async()=>{
    const input={memberId:employeeMember,startDate:'2020-04-01',endDate:'2020-04-01',startTime:'09:00',endTime:'17:00',breakMinutes:0,description:null}
    const s=await createShift(owner,org,input);await setShiftAttendance(owner,org,s.id,{attendance:'NO_SHOW',reason:'Не вышел на смену'})
    let stats=await organizationStatistics(owner,org,{memberState:'all',page:1,limit:50,sort:'name',direction:'asc'});assert.equal(stats.members.find(m=>m.memberId===employeeMember)!.workedMinutes,0)
    const p=await createShift(owner,org,{...input,startDate:'2020-04-02',endDate:'2020-04-02'});await setShiftAttendance(owner,org,p.id,{attendance:'PARTIAL',reason:'Ушёл раньше',startAt:'2020-04-02T06:00:00Z',endAt:'2020-04-02T10:00:00Z'})
    stats=await organizationStatistics(owner,org,{memberState:'all',page:1,limit:50,sort:'name',direction:'asc'});assert.equal(stats.members.find(m=>m.memberId===employeeMember)!.workedMinutes,240)
    const report=await buildReport(owner,org,reportBody.parse({from:'2020-04-01',to:'2020-04-02',locationIds:[point],memberIds:[employeeMember],includeFormer:false,config:defaultReportConfig()}));assert.equal(report.metrics.minutes,240)
    assert.equal((await prisma.workShift.findUniqueOrThrow({where:{id:s.id}})).scheduledEndAt.toISOString(),'2020-04-01T14:00:00.000Z')
  })
  it('expires impossible proposals without opening the interface',async()=>{
    const t=(await listRequestTypes(owner,org)).find(t=>t.systemCode==='SHIFT_PROPOSAL')!,r=await createRequest(employee,org,{requestTypeId:t.id,comment:'Дополнительная смена',proposedStartDate:'2075-01-01',proposedEndDate:'2075-01-01',proposedStartTime:'09:00',proposedEndTime:'17:00'})
    await maintainRequests(new Date('2076-01-01T00:00:00Z'));assert.equal((await prisma.organizationRequest.findUniqueOrThrow({where:{id:r.id}})).status,'EXPIRED')
  })
  it('allows a new staffing response after withdrawal and keeps one active response',async()=>{
    const second=await prisma.organizationLocation.create({data:{organizationId:org,name:'Вторая точка',city:'Тест',address:'Тестовый адрес',timezone:'Europe/Moscow'}})
    const at=<T>(task:()=>Promise<T>)=>locationContext.run({organizationId:org,locationId:second.id},task)
    const type=(await listRequestTypes(owner,org)).find(t=>t.systemCode==='STAFFING')!
    const offer=await at(()=>createRequest(owner,org,{requestTypeId:type.id,staffingPositionName:'Кассир',proposedStartDate:'2078-10-01',proposedEndDate:'2078-10-01',proposedStartTime:'09:00',proposedEndTime:'17:00'}))
    const first=await at(()=>respondToStaffing(employee,org,offer.id));await at(()=>cancelRequest(employee,org,first.id))
    const secondResponse=await at(()=>respondToStaffing(employee,org,offer.id));assert.notEqual(first.id,secondResponse.id)
    await assert.rejects(at(()=>respondToStaffing(employee,org,offer.id)),code('ALREADY_RESPONDED'))
    assert.equal(await prisma.organizationRequest.count({where:{staffingRequestId:offer.id,createdByMemberId:employeeMember,status:'PENDING'}}),1)
  })
  it('adds new controls to custom roles without granting self-approval implicitly',async()=>{
    const role=await saveAccessRole(owner,org,null,{name:'Координатор отпусков',description:'Только отпуска',permissions:normalizePermissions(['vacations.collect','vacations.resolve','requests.onBehalf'])})
    await saveMemberAccess(owner,org,adminMember,{organizationRoleId:null,assignments:[{locationId:point,roleId:role.id}]})
    const r=await createRequest(admin,org,{requestTypeId:vacation,startDate:'2077-08-01',endDate:'2077-08-14'})
    await assert.rejects(resolveRequest(admin,org,r.id,'APPROVED',null),code('INSUFFICIENT_PERMISSIONS'))
    const behalf=await createRequest(admin,org,{requestTypeId:vacation,subjectMemberId:employeeMember,startDate:'2077-09-01',endDate:'2077-09-14'});assert.equal(behalf.createdByMemberId,employeeMember);assert.equal(behalf.authorMemberId,adminMember)
    const mine=await listRequests(admin,org,'mine',{page:1,pageSize:50});assert.ok(mine.requests.some(r=>r.id===behalf.id))
  })
  it('projects paged request graphs without per-relation SQL and preserves all workflow data', async () => {
    // Reuse the real workflow cases above: files, reads, resolutions, absence
    // amendments, staffing responses, custom answers and event audit history.
    const where = { organizationId: org }
    const expected = await prisma.organizationRequest.findMany({ where, include: requestInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    assert.ok(expected.length > 10)
    assert.ok(expected.some(row => row.attachments.length > 0))
    assert.ok(expected.some(row => row.absence))
    assert.ok(expected.some(row => row._count.staffingResponses > 0))
    const actual: typeof expected = []
    for (let page = 1; page <= Math.ceil(expected.length / 7); page++) {
      const before = performanceSnapshot().measurements.sql!.count
      const result = await prisma.$transaction(tx => readRequestPage(tx, org, where, page, 7), { isolationLevel: 'RepeatableRead' })
      const queries = performanceSnapshot().measurements.sql!.count - before
      assert.ok(queries <= 7, `A populated page used ${queries} SQL operations including transaction control`)
      assert.equal(result.total, expected.length)
      actual.push(...result.rows)
    }
    // Unordered assignment/membership relations have no orderBy in either reader.
    const normalize = (rows: typeof actual) => rows.map(row => ({ ...row, creator: { ...row.creator,
      accessAssignments: row.creator.accessAssignments.toSorted((a, b) => a.locationId.localeCompare(b.locationId)),
      locationMemberships: row.creator.locationMemberships.toSorted((a, b) => a.locationId.localeCompare(b.locationId)) } }))
    assert.deepEqual(normalize(actual), normalize(expected))
    const empty = await prisma.$transaction(tx => readRequestPage(tx, org, where, 1000, 7))
    assert.equal(empty.total, expected.length); assert.deepEqual(empty.rows, [])
    const foreign = await prisma.$transaction(tx => readRequestPage(tx, randomUUID(), where, 1, 7))
    assert.deepEqual(foreign, { total: 0, rows: [] })
  })

})
