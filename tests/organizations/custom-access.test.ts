import { normalizePermissions } from '../../src/app/access/catalog.ts'
import assert from 'node:assert/strict'
import { before, beforeEach, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createOrganization, listMembersPage } from '../../src/server/organizations/organization-service.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { hasPermission } from '../../src/server/organizations/access/access.ts'
import { listAccessRoles, saveAccessRole, saveMemberAccess, deleteAccessRole, accessAudit, memberAccess } from '../../src/server/organizations/access/access-service.ts'
import { buildReport } from '../../src/server/schedule/reports/report-service.ts'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'
import { reportBody } from '../../src/server/schedule/reports/report-schemas.ts'
import { createShift, listSchedule } from '../../src/server/schedule/service.ts'
import * as docs from '../../src/server/documents/service.ts'
import { listSchema, assignSchema } from '../../src/server/documents/schemas.ts'
import { listNotificationHistory } from '../../src/server/organizations/notification-service.ts'
import { createEvent, getEvent } from '../../src/server/events/service.ts'
import { eventBody } from '../../src/server/events/schemas.ts'
import { createRequest, getRequest, listRequestTypes } from '../../src/server/requests/service.ts'

const code = (value: string) => (error: unknown) => !!error && typeof error==='object' && 'code' in error && error.code===value
let org: string, foreign: string, first: string, second: string, foreignPoint: string
const people: Record<string,{id:string;memberId:string;email:string}> = {}
let memberRole: Awaited<ReturnType<typeof listAccessRoles>>['roles'][number]
const at = <T>(point:string, task:()=>Promise<T>)=>locationContext.run({organizationId:org,locationId:point},task)
const makeRole = (permissions: Parameters<typeof saveAccessRole>[3]['permissions']) => saveAccessRole(people.owner.id,org,null,{name:`Роль ${randomUUID().slice(0,8)}`,description:'Тест доступа',permissions})
const assign = (who:string,roleId:string,point=first,global:string|null=null)=>saveMemberAccess(people.owner.id,org,people[who].memberId,{organizationRoleId:global,assignments:point?[{locationId:point,roleId}]:[]})
const metadata = (patch: Record<string,unknown>={})=>({displayName:'Документ доступа',folderId:null,visibility:'ORGANIZATION' as const,targetMemberId:null,pointId:first,...patch})
const upload = (patch: Parameters<typeof docs.uploadDocument>[5]={...metadata()})=>docs.uploadDocument(people.owner.id,org,Buffer.from('Test permissions'), 'text/plain','access.txt',patch)

before(async()=>{
  for (const key of ['owner','accountant','employee','foreign']) {
    const u=await prisma.user.create({data:{email:`access-${randomUUID()}@example.test`,passwordHash:'test-only',firstName:key,lastName:'Проверка',emailVerifiedAt:new Date()}})
    people[key]={id:u.id,memberId:'',email:u.email}
  }
  const created=await createOrganization(people.owner.id,{name:'Custom access tests',description:null,timezone:'Europe/Moscow',firstLocation:{name:'Центр',city:'Москва',address:'Тест',timezone:'Europe/Moscow'},locations:[{name:'Парк',city:'Москва',address:'Тест',timezone:'Europe/Moscow'}]})
  org=created.id;[first,second]=created.locations.map(l=>l.id)
  people.owner.memberId=(await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:org,userId:people.owner.id}}})).id
  for(const key of ['accountant','employee']) {
    const m=await prisma.organizationMember.create({data:{organizationId:org,userId:people[key].id,personnelNumber:key==='employee'?'0009':null}});people[key].memberId=m.id
    await prisma.locationMember.create({data:{organizationId:org,locationId:first,memberId:m.id}})
  }
  const other=await createOrganization(people.foreign.id,{name:'Foreign access tests',description:null,timezone:'Europe/Moscow'});foreign=other.id;foreignPoint=other.locationId
  memberRole=(await listAccessRoles(people.owner.id,org)).roles.find(r=>r.systemCode==='MEMBER')!
})
beforeEach(async()=>{await assign('accountant',memberRole.id);await assign('employee',memberRole.id)})
after(async()=>{
  const organizationId={in:[org,foreign].filter(Boolean)}
  await prisma.accountNotification.deleteMany({where:{organizationId}})
  await prisma.documentAcknowledgement.deleteMany({where:{document:{organizationId}}})
  await prisma.document.deleteMany({where:{organizationId}})
  await prisma.documentFolder.updateMany({where:{organizationId},data:{parentId:null}})
  await prisma.documentFolder.deleteMany({where:{organizationId}})
  await prisma.organizationEvent.deleteMany({where:{organizationId}})
  await prisma.employeeAbsence.deleteMany({where:{organizationId}})
  await prisma.organizationRequest.deleteMany({where:{organizationId}})
  await prisma.workShift.deleteMany({where:{organizationId}})
  await prisma.storedFile.deleteMany({where:{organizationId}})
  await prisma.accessAssignment.deleteMany({where:{organizationId}})
  await prisma.organizationMember.updateMany({where:{organizationId},data:{accessRoleId:null}})
  await prisma.organization.deleteMany({where:{id:organizationId}})
  await prisma.user.deleteMany({where:{id:{in:Object.values(people).map(p=>p.id)}}});await prisma.$disconnect()
})

describe('custom organization access: scopes, revocation and confidential fields',()=>{
  it('returns full avatar identity to the owner or employee without exposing storage IDs or another employee access',async()=>{
    await prisma.user.update({where:{id:people.employee.id},data:{middleName:'Тестович'}})
    try {
      const result=await memberAccess(people.owner.id,org,people.employee.memberId)
      assert.deepEqual(result.member,{firstName:'employee',lastName:'Проверка',middleName:'Тестович',email:people.employee.email,avatarUrl:null})
      assert.deepEqual((await memberAccess(people.employee.id,org,people.employee.memberId)).member,result.member)
      await assert.rejects(memberAccess(people.accountant.id,org,people.employee.memberId),code('OWNER_REQUIRED'))
      await assert.rejects(memberAccess(people.foreign.id,foreign,people.employee.memberId),code('MEMBER_NOT_FOUND'))
    } finally { await prisma.user.update({where:{id:people.employee.id},data:{middleName:null}}) }
  })
  it('creates three independent defaults and protects the owner and tenant boundaries',async()=>{
    const defaults=await listAccessRoles(people.owner.id,org)
    assert.equal(defaults.roles.filter(r=>r.systemCode).length,3)
    const ownerRole=defaults.roles.find(r=>r.systemCode==='OWNER')!
    await assert.rejects(saveAccessRole(people.owner.id,org,ownerRole.id,{...ownerRole,description:'',permissions:[],revision:ownerRole.revision}),code('PROTECTED_ROLE'))
    await assert.rejects(saveMemberAccess(people.owner.id,org,people.owner.memberId,{organizationRoleId:null,assignments:[]}),code('PROTECTED_MEMBER'))
    await assert.rejects(saveAccessRole(people.accountant.id,org,null,{name:'Сам себе админ',description:'',permissions:[]}),code('OWNER_REQUIRED'))
    const alien=(await listAccessRoles(people.foreign.id,foreign)).roles.find(r=>r.systemCode==='ADMIN')!
    await assert.rejects(assign('accountant',alien.id),code('INVALID_ROLE'))
    await assert.rejects(assign('accountant',memberRole.id,foreignPoint),code('INVALID_LOCATION'))
    await assert.rejects(saveAccessRole(people.owner.id,foreign,null,{name:'Чужая роль',description:'',permissions:[]}),code('ORGANIZATION_NOT_FOUND'))
  })
  it('applies edited standard permissions and selected audiences to legacy members without seeded assignments',async()=>{
    const standard=(await listAccessRoles(people.owner.id,org)).roles.find(r=>r.systemCode==='MEMBER')!
    await prisma.organizationMember.update({where:{id:people.employee.memberId},data:{accessConfigured:false,accessRoleId:null}})
    await prisma.accessAssignment.deleteMany({where:{memberId:people.employee.memberId}})
    try {
      const updated=await saveAccessRole(people.owner.id,org,standard.id,{name:standard.name,description:'',permissions:['documents.download'],revision:standard.revision})
      const document=await upload({...metadata(),visibility:'SELECTED',audienceRoleIds:[standard.id]})
      assert.equal((await at(first,()=>docs.getDocument(people.employee.id,org,document.id))).id,document.id)
      const actor=await at(first,()=>getMembership(people.employee.id,org))
      assert.equal(hasPermission(actor,'requests.create'),false)
      assert.equal(hasPermission(actor,'documents.download'),true)
      await saveAccessRole(people.owner.id,org,standard.id,{name:standard.name,description:'',permissions:[],revision:updated.revision})
      await assert.rejects(at(first,()=>docs.deliverDocument(people.employee.id,org,document.id,'download')),code('DOCUMENT_NOT_FOUND'))
    } finally {
      const current=(await listAccessRoles(people.owner.id,org)).roles.find(r=>r.id===standard.id)!
      await saveAccessRole(people.owner.id,org,standard.id,{name:standard.name,description:standard.description,permissions:normalizePermissions(standard.permissions),revision:current.revision})
    }
  })
  it('lets an accountant export only permitted points and never mutate shifts or see hidden numbers',async()=>{
    const role=await makeRole(['reports.export'])
    assert.ok(role.permissions.includes('reports.preview'))
    await assign('accountant',role.id)
    const shift=await prisma.workShift.create({data:{organizationId:org,locationId:first,memberId:people.employee.memberId,createdByMemberId:people.owner.memberId,scheduledStartAt:new Date('2070-01-02T06:00:00Z'),scheduledEndAt:new Date('2070-01-02T15:00:00Z')}})
    const report=reportBody.parse({from:'2070-01-01',to:'2070-01-31',locationIds:[first],memberIds:[],includeFormer:false,config:defaultReportConfig()})
    const result=await at(second,()=>buildReport(people.accountant.id,org,report,new Date(),'reports.export'))
    assert.equal(result.rows.shifts[0].id,shift.id);assert.equal('personnelNumber' in result.rows.shifts[0],false)
    await assert.rejects(at(second,()=>buildReport(people.accountant.id,org,{...report,locationIds:[second]},new Date(),'reports.export')),code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(at(first,()=>createShift(people.accountant.id,org,{memberId:people.employee.memberId,startDate:'2070-02-01',endDate:'2070-02-01',startTime:'09:00',endTime:'18:00',breakMinutes:0,description:null})),code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(docs.listDocuments(people.accountant.id,org,listSchema.parse({})),code('INSUFFICIENT_PERMISSIONS'))
  })
  it('combines global and point roles, includes new points and keeps common management separate',async()=>{
    const global=await makeRole(['documents.view']), local=await makeRole(['documents.upload','documents.shared','organization.edit'])
    await assign('accountant',local.id,first,global.id)
    const actor=await at(first,()=>getMembership(people.accountant.id,org))
    assert.ok(hasPermission(actor,'documents.upload',first));assert.equal(hasPermission(actor,'documents.upload',second),false);assert.equal(hasPermission(actor,'organization.edit',null),false)
    await assert.rejects(at(first,()=>docs.uploadDocument(people.accountant.id,org,Buffer.from('x'),'text/plain','x.txt',{...metadata(),pointId:null})),code('INSUFFICIENT_PERMISSIONS'))
    const point=await prisma.organizationLocation.create({data:{organizationId:org,name:'Новая',city:'Москва',address:'Тест',timezone:'Europe/Moscow'}})
    const refreshed=await getMembership(people.accountant.id,org)
    assert.ok(hasPermission(refreshed,'documents.view',point.id));assert.equal(hasPermission(refreshed,'documents.upload',point.id),false)
  })
  it('limits own-only calendar data and redacts contacts in the member directory',async()=>{
    const role=await makeRole(['schedule.own','members.view'])
    await assign('accountant',role.id)
    const own=await prisma.workShift.create({data:{organizationId:org,locationId:first,memberId:people.accountant.memberId,createdByMemberId:people.owner.memberId,scheduledStartAt:new Date('2071-01-02T06:00:00Z'),scheduledEndAt:new Date('2071-01-02T15:00:00Z')}})
    const list=await at(first,()=>listSchedule(people.accountant.id,org,'2071-01-01','2071-02-01'))
    assert.ok(list.shifts.some(s=>s.id===own.id));assert.ok(list.shifts.every(s=>s.memberId===people.accountant.memberId))
    const members=await at(first,()=>listMembersPage(people.accountant.id,org,{directory:'true'}))
    assert.ok(members.members.every(m=>m.email==='' && m.phone===null && !('personnelNumber' in m)))
  })
  it('redacts directory fields separately for each point in an all-points query',async()=>{
    const contacts=await makeRole(['members.contacts']), directory=await makeRole(['members.view'])
    await saveMemberAccess(people.owner.id,org,people.accountant.memberId,{organizationRoleId:null,assignments:[{locationId:first,roleId:contacts.id},{locationId:second,roleId:directory.id}]})
    await assign('employee',memberRole.id,second)
    await prisma.locationMember.updateMany({where:{memberId:people.employee.memberId,locationId:first},data:{leftAt:new Date()}})
    await prisma.locationMember.upsert({where:{locationId_memberId:{locationId:second,memberId:people.employee.memberId}},create:{organizationId:org,locationId:second,memberId:people.employee.memberId},update:{leftAt:null}})
    try {
      const page=await at(first,()=>listMembersPage(people.accountant.id,org,{page:1,pageSize:20,directory:'true'}))
      const employee=page.members.find(m=>m.id===people.employee.memberId)!
      assert.ok(employee); assert.equal(employee.email,''); assert.equal('personnelNumber' in employee,false)
    } finally {
      await prisma.locationMember.updateMany({where:{memberId:people.employee.memberId,locationId:first},data:{leftAt:null}})
      await prisma.locationMember.updateMany({where:{memberId:people.employee.memberId,locationId:second},data:{leftAt:new Date()}})
    }
  })
  it('enforces dynamic role audiences, parent restrictions and byte/notification revocation',async()=>{
    const role=await makeRole(['documents.download','documents.control']);await assign('accountant',role.id)
    const publicDocument=await upload()
    await docs.assignAcknowledgements(people.owner.id,org,publicDocument.id,assignSchema.parse({recipients:'all'}))
    const control=await at(second,()=>docs.listDocuments(people.accountant.id,org,listSchema.parse({scope:'control',pointId:'all'})))
    const controlled=control.documents.find(d=>d.id===publicDocument.id)!
    assert.ok('progress' in controlled); assert.equal(controlled.progress.total,3)
    const folder=await docs.saveFolder(people.owner.id,org,undefined,{name:'Закрытая',parentId:null,pointId:first,visibility:'SELECTED',audienceRoleIds:[role.id]})
    const document=await upload({...metadata(),folderId:folder.id,visibility:'SELECTED',audienceRoleIds:[role.id]})
    const manager=await makeRole(['documents.access','documents.delete','documents.edit','documents.folders','documents.upload']); await assign('employee',manager.id)
    await assert.rejects(at(first,()=>docs.saveFolder(people.employee.id,org,folder.id,{name:'Взлом аудитории',parentId:null,pointId:first,visibility:'ORGANIZATION'})),code('FOLDER_NOT_FOUND'))
    await assert.rejects(at(first,()=>docs.deleteFolder(people.employee.id,org,folder.id)),code('FOLDER_NOT_FOUND'))
    await assert.rejects(at(first,()=>docs.uploadDocument(people.employee.id,org,Buffer.from('no access'),'text/plain','hidden.txt',{...metadata(),folderId:folder.id})),code('FOLDER_NOT_FOUND'))

    const inherited=await upload({...metadata(),folderId:folder.id,inheritAccess:true})
    await docs.getDocument(people.accountant.id,org,inherited.id)
    await assert.rejects(docs.getDocument(people.employee.id,org,inherited.id),code('DOCUMENT_NOT_FOUND'))
    await docs.assignAcknowledgements(people.owner.id,org,document.id,assignSchema.parse({recipients:'roles',accessRoleIds:[role.id]}))
    const stream=await docs.deliverDocument(people.accountant.id,org,document.id,'download');stream.stream.destroy()
    assert.ok((await listNotificationHistory(people.accountant.id,people.accountant.email,{limit:50,organizationId:org})).notifications.some(n=>n.documentId===document.id))
    await saveAccessRole(people.owner.id,org,role.id,{name:role.name,description:'',permissions:[],revision:role.revision})
    await assert.rejects(docs.getDocument(people.accountant.id,org,document.id),code('DOCUMENT_NOT_FOUND'))
    await assert.rejects(docs.deliverDocument(people.accountant.id,org,document.id,'download'),code('DOCUMENT_NOT_FOUND'))
    const hidden=await listNotificationHistory(people.accountant.id,people.accountant.email,{limit:50,organizationId:org})
    assert.equal(hidden.notifications.some(n=>n.documentId===document.id),false)
    await assert.rejects(deleteAccessRole(people.owner.id,org,role.id,memberRole.id),code('ROLE_IN_AUDIENCE'))
  })
  it('keeps common selected audiences global and protects personal documents',async()=>{
    const role=await makeRole(['documents.download']);await assign('accountant',role.id)
    const common=await upload({...metadata(),pointId:null,visibility:'SELECTED',audienceRoleIds:[role.id]})
    await assert.rejects(docs.getDocument(people.accountant.id,org,common.id),code('DOCUMENT_NOT_FOUND'))
    await assign('accountant',role.id,'',role.id);await docs.getDocument(people.accountant.id,org,common.id)
    const personal=await upload({...metadata(),visibility:'PRIVATE_MEMBER',targetMemberId:people.employee.memberId})
    await assert.rejects(docs.getDocument(people.accountant.id,org,personal.id),code('DOCUMENT_NOT_FOUND'))
    const viewer=await makeRole(['documents.view']);await assign('employee',viewer.id)
    await docs.getDocument(people.employee.id,org,personal.id)
    await assert.rejects(docs.deliverDocument(people.employee.id,org,personal.id,'download'),code('INSUFFICIENT_PERMISSIONS'))
  })
  it('replaces deleted custom roles atomically and detects stale role edits',async()=>{
    const role=await makeRole(['schedule.own']);await assign('accountant',role.id)
    const next=await saveAccessRole(people.owner.id,org,role.id,{name:role.name,description:'Новая',permissions:['statistics.own'],revision:role.revision})
    await assert.rejects(saveAccessRole(people.owner.id,org,role.id,{name:role.name,description:'Старая',permissions:[],revision:role.revision}),code('ROLE_CHANGED'))
    await deleteAccessRole(people.owner.id,org,next.id,memberRole.id)
    const current=await getMembership(people.accountant.id,org)
    assert.ok(current.accessAssignments.some(a=>a.roleId===memberRole.id));assert.ok((await accessAudit(people.owner.id,org)).some(e=>e.action==='ROLE_DELETED'))
  })
  it('revokes event views and absence details even for saved recipients',async()=>{
    const role=await makeRole(['events.view','requests.view']);await assign('accountant',role.id)
    const input=eventBody.parse({title:'Закрытая встреча',startDate:'2072-01-01',startTime:'12:00',shared:false,locationIds:[first],audienceMode:'ROLES',audienceAccessRoleIds:[role.id]})
    const event=await createEvent(people.owner.id,org,input);assert.ok(event.recipients.some(m=>m.id===people.accountant.memberId))
    await getEvent(people.accountant.id,org,event.id)
    const sick=(await listRequestTypes(people.employee.id,org)).find(t=>t.systemCode==='SICK')!
    const request=await at(first,()=>createRequest(people.employee.id,org,{requestTypeId:sick.id,startDate:'2072-03-01',endDate:'2072-03-02',comment:'Частная причина',absenceReason:'PERSONAL'}))
    const detail=await at(first,()=>getRequest(people.accountant.id,org,request.id))
    assert.equal(detail.request.absenceReason,null);assert.equal(detail.request.comment,null);assert.equal('creator' in detail.request,false)
    await saveAccessRole(people.owner.id,org,role.id,{name:role.name,description:'',permissions:[],revision:role.revision})
    await assert.rejects(getEvent(people.accountant.id,org,event.id),code('EVENT_NOT_FOUND'))
  })
})
