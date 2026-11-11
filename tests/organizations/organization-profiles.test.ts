import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createOrganization, getOrganization, listOrganizations, updateOrganization } from '../../src/server/organizations/organization-service.ts'
import { saveLocation, listLocations } from '../../src/server/organizations/location-service.ts'
import { createOrganizationBody, locationBody, updateOrganizationBody } from '../../src/server/organizations/schemas.ts'
import { openingHoursSchema, emptyOpeningHours } from '../../src/shared/organization-profile.ts'
import { stageStoredFile } from '../../src/server/storage/image-service.ts'
import { monitoringOrganization, monitoringOrganizations } from '../../src/server/admin/monitoring.ts'
const matches=(code:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===code
const user=()=>prisma.user.create({data:{email:randomUUID()+'@example.test',emailVerifiedAt:new Date()}})
const input=()=>createOrganizationBody.parse({name:'Проверка профиля '+randomUUID(),description:'Синтетическое описание',industry:'Тестовая сфера',timezone:'Europe/Moscow',contactEmail:'org@example.test',website:'https://example.test',address:'Синтетический адрес организации',firstLocation:{name:'Основная точка',kind:'REMOTE',timezone:'Asia/Yekaterinburg',inheritsTimezone:true,phone:'',description:'Инструкция для команды',openingHours:emptyOpeningHours()},creationKey:randomUUID()})
after(()=>prisma.$disconnect())
test('creation schema validates contacts, optional data, physical versus remote points',()=>{
 const data=input();assert.equal(data.firstLocation.city,'');assert.equal(data.firstLocation.address,'')
 assert.equal(createOrganizationBody.safeParse({...data,website:'javascript:alert(1)'}).success,false)
 assert.equal(createOrganizationBody.safeParse({...data,contactEmail:'wrong'}).success,false)
 assert.equal(createOrganizationBody.safeParse({...data,industry:'x'.repeat(121)}).success,false)
 assert.equal(locationBody.safeParse({name:'Точка',city:'',address:'',timezone:'Europe/Moscow'}).success,false)
 assert.equal(locationBody.safeParse({name:'Точка',city:'Город',address:'Адрес',timezone:'Europe/Moscow'}).success,true)
})
test('opening hours handle unknown, closed, full-day, overnight and breaks without accepting overlaps',()=>{
 const days=emptyOpeningHours();days[0]={day:0,status:'OPEN',start:'22:00',end:'06:00',breakStart:'01:00',breakEnd:'02:00'};assert(openingHoursSchema.safeParse(days).success)
 days[0]={...days[0],breakEnd:'07:00'};assert.equal(openingHoursSchema.safeParse(days).success,false)
 days[0]={day:0,status:'OPEN',start:'09:00',end:'09:00'};assert.equal(openingHoursSchema.safeParse(days).success,false)
 days[0]={day:0,status:'ALL_DAY'};days[1]={day:1,status:'CLOSED'};assert(openingHoursSchema.safeParse(days).success)
 days[6]={day:0,status:'UNSET'};assert.equal(openingHoursSchema.safeParse(days).success,false)
})
test('parallel creation and lost-response retry produce one organization, owner and initial point',async()=>{
 const owner=await user(),data=input(),[a,b]=await Promise.all([createOrganization(owner.id,data),createOrganization(owner.id,data)])
 assert.equal(a.id,b.id);assert.equal(a.locations.length,1);assert.equal(a.locations[0].timezone,'Europe/Moscow')
 assert.equal(await prisma.organization.count({where:{createdByUserId:owner.id}}),1)
 assert.equal(await prisma.organizationMember.count({where:{organizationId:a.id}}),1)
 assert.equal(await prisma.workShift.count({where:{organizationId:a.id}}),0)
 await assert.rejects(createOrganization(owner.id,{...data,name:'Изменённый запрос'}),matches('CREATION_CHANGED'))
 const read=await getOrganization(owner.id,a.id);assert.equal(read.industry,data.industry);assert.equal(read.contactEmail,data.contactEmail)
 assert.equal((await listOrganizations(owner.id))[0].industry,data.industry)
})
test('logo draft binds in the same creation transaction and transfers its storage charge',async()=>{
 const owner=await user(),bytes=Buffer.from('synthetic-logo-bytes'),file=await stageStoredFile({objectKey:'users/'+owner.id+'/organization-logos/'+randomUUID()+'.webp',mimeType:'image/webp',size:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex'),purpose:'ORGANIZATION_LOGO',uploadedByUserId:owner.id},bytes)
 const data={...input(),logoUploadId:file.id},org=await createOrganization(owner.id,data)
 assert.equal(org.logoFileId,file.id)
 const saved=await prisma.storedFile.findUniqueOrThrow({where:{id:file.id}});assert.equal(saved.organizationId,org.id);assert.equal(saved.pendingDeletionAt,null)
 assert.equal(Number((await prisma.organizationResourceBudget.findUniqueOrThrow({where:{organizationId:org.id}})).storageBytes),bytes.length)
 assert.equal((await createOrganization(owner.id,data)).id,org.id)
})
test('foreign or unavailable logo rolls creation back and cannot be attached to another organization',async()=>{
 const owner=await user(),other=await user(),bytes=Buffer.from('test')
 const file=await stageStoredFile({objectKey:'users/'+other.id+'/organization-logos/'+randomUUID()+'.webp',mimeType:'image/webp',size:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex'),purpose:'ORGANIZATION_LOGO',uploadedByUserId:other.id},bytes)
 const data={...input(),logoUploadId:file.id};await assert.rejects(createOrganization(owner.id,data),matches('IMAGE_UPLOAD_UNAVAILABLE'))
 assert.equal(await prisma.organization.count({where:{createdByUserId:owner.id}}),0)
 assert.equal((await prisma.storedFile.findUniqueOrThrow({where:{id:file.id}})).organizationId,null)
})
test('profile revision rejects stale writes, changes inherited zones and leaves independent zones untouched',async()=>{
 const owner=await user(),org=await createOrganization(owner.id,input()),point=org.locations[0]
 const body=updateOrganizationBody.parse({...org,timezone:'Asia/Yekaterinburg',industry:'Обновлённая сфера'})
 const result=await updateOrganization(owner.id,org.id,body);assert.equal(result.profileRevision,2)
 assert.equal((await prisma.organizationLocation.findUniqueOrThrow({where:{id:point.id}})).timezone,'Asia/Yekaterinburg')
 await assert.rejects(updateOrganization(owner.id,org.id,body),matches('PROFILE_CHANGED'))
 const saved=await prisma.organizationLocation.findUniqueOrThrow({where:{id:point.id}})
 await saveLocation(owner.id,org.id,point.id,locationBody.parse({...saved,kind:'REMOTE',inheritsTimezone:false,timezone:'Europe/Moscow'}))
 await updateOrganization(owner.id,org.id,{...body,profileRevision:2,timezone:'Asia/Vladivostok'})
 assert.equal((await prisma.organizationLocation.findUniqueOrThrow({where:{id:point.id}})).timezone,'Europe/Moscow')
})
test('point details are stored once, update conflicts are rejected and hours never generate employee shifts',async()=>{
 const owner=await user(),org=await createOrganization(owner.id,input()),point=org.locations[0],hours=emptyOpeningHours();hours[0]={day:0,status:'OPEN',start:'22:00',end:'06:00'}
 const data=locationBody.parse({...point,kind:'REMOTE',description:'Новая инструкция',openingHours:hours})
 await saveLocation(owner.id,org.id,point.id,data)
 await assert.rejects(saveLocation(owner.id,org.id,point.id,data),matches('LOCATION_CHANGED'))
 const read=(await listLocations(owner.id,org.id))[0];assert.equal(read.description,data.description);assert.deepEqual(read.openingHours,hours)
 assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),0)
})
test('members cannot edit profile or point data and foreign or departed accounts cannot read it',async()=>{
 const owner=await user(),employee=await user(),foreign=await user(),org=await createOrganization(owner.id,input())
 const member=await prisma.organizationMember.create({data:{userId:employee.id,organizationId:org.id}});await prisma.locationMember.create({data:{organizationId:org.id,locationId:org.locationId,memberId:member.id}})
 const body=updateOrganizationBody.parse(org)
 await assert.rejects(updateOrganization(employee.id,org.id,body),matches('INSUFFICIENT_PERMISSIONS'))
 await assert.rejects(saveLocation(employee.id,org.id,org.locationId,locationBody.parse({...org.locations[0],kind:'REMOTE'})),matches('INSUFFICIENT_PERMISSIONS'))
 await assert.rejects(getOrganization(foreign.id,org.id),matches('ORGANIZATION_NOT_FOUND'))
 await prisma.organizationMember.update({where:{id:member.id},data:{leftAt:new Date()}})
 await assert.rejects(getOrganization(employee.id,org.id),matches('ORGANIZATION_NOT_FOUND'))
})
test('admin detail and bounded search/filter read the same saved profile and point data',async()=>{
 const owner=await user(),data=input(),org=await createOrganization(owner.id,data)
 const detail=await monitoringOrganization(org.id);assert.equal(detail.contactEmail,data.contactEmail);assert.equal(detail.industry,data.industry);assert.equal(detail.pointProfiles[0].description,data.firstLocation.description)
 const result=await monitoringOrganizations({search:data.contactEmail,industry:data.industry});assert(result.items.some(o=>o.id===org.id));assert(result.industries.includes(data.industry!))
 assert.equal((await monitoringOrganizations({search:data.name,industry:'Не та сфера'})).total,0)
})
