import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { listFormerMembers } from '../../src/server/organizations/member-archive.ts'
import { locationContext } from '../../src/server/organizations/location-context.ts'
import { removeMember } from '../../src/server/organizations/organization-service.ts'
const code=(expected:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===expected
const users:string[]=[]
after(async()=>{await prisma.organization.updateMany({where:{createdByUserId:{in:users}},data:{deletedAt:new Date()}});await prisma.$disconnect()})
test('archive enforces organization, historical point and managerial permissions; search and paging remain scoped',async()=>{
 const [owner,manager,employee,foreign]=await Promise.all(['owner','manager','employee','foreign'].map(firstName=>prisma.user.create({data:{firstName,email:randomUUID()+'@example.test'}})))
 users.push(owner.id,manager.id,employee.id,foreign.id)
 const org=await createBusinessOrganization(owner.id,{name:'Archive test',description:null,timezone:'Europe/Moscow'})
 const other=await prisma.organizationLocation.create({data:{organizationId:org.id,name:'Other point',city:'',address:'',timezone:'Europe/Moscow'}})
 const mm=await prisma.organizationMember.create({data:{organizationId:org.id,userId:manager.id,role:'ADMIN'}})
 const em=await prisma.organizationMember.create({data:{organizationId:org.id,userId:employee.id}})
 const fm=await prisma.organizationMember.create({data:{organizationId:org.id,userId:foreign.id}})
 for(const [memberId,locationId,role] of [[mm.id,org.locationId!,'ADMIN'],[em.id,org.locationId!,'MEMBER'],[fm.id,other.id,'MEMBER']] as const)await prisma.locationMember.create({data:{organizationId:org.id,memberId,locationId,role}})
 await removeMember(owner.id,org.id,em.id);await removeMember(owner.id,org.id,fm.id)
 const at=<T>(work:()=>Promise<T>)=>locationContext.run({organizationId:org.id,locationId:org.locationId!},work)
 const options={page:1,pageSize:20}
 const all=await at(()=>listFormerMembers(owner.id,org.id,options));assert.equal(all.pagination.total,2)
 const local=await at(()=>listFormerMembers(manager.id,org.id,options));assert.deepEqual(local.members.map(m=>m.id),[em.id]);assert.equal(local.members[0].periods.length,1);assert(local.members[0].periods[0].startedAt)
 assert.equal((await at(()=>listFormerMembers(owner.id,org.id,{...options,search:employee.email}))).pagination.total,1)
 assert.equal((await at(()=>listFormerMembers(owner.id,org.id,{...options,departedFrom:new Date(Date.now()+86400000)}))).pagination.total,0)
 await assert.rejects(at(()=>listFormerMembers(manager.id,org.id,{...options,pointId:other.id})),code('INSUFFICIENT_PERMISSIONS'))
 const adminRole=await prisma.accessRole.create({data:{organizationId:org.id,name:'Archive with local contacts',permissions:['members.view','members.remove','members.contacts']}})
 const limited=await prisma.accessRole.create({data:{organizationId:org.id,name:'Archive without contacts',permissions:['members.view','members.remove']}})
 await prisma.organizationMember.update({where:{id:mm.id},data:{accessConfigured:true}})
 await prisma.accessAssignment.createMany({data:[{organizationId:org.id,memberId:mm.id,locationId:org.locationId!,roleId:adminRole.id},{organizationId:org.id,memberId:mm.id,locationId:other.id,roleId:limited.id}]})
 const mixed=await at(()=>listFormerMembers(manager.id,org.id,options));assert.equal(mixed.pagination.total,2);assert.equal(mixed.members.find(m=>m.id===fm.id)?.email,'')
 assert.equal((await at(()=>listFormerMembers(manager.id,org.id,{...options,search:foreign.email}))).pagination.total,0)
 assert.equal((await at(()=>listFormerMembers(manager.id,org.id,{...options,search:'foreign'}))).pagination.total,1)
 await assert.rejects(at(()=>listFormerMembers(employee.id,org.id,options)),code('ORGANIZATION_NOT_FOUND'))
 const active=await prisma.organizationMember.create({data:{organizationId:org.id,userId:(await prisma.user.create({data:{email:randomUUID()+'@example.test'}})).id}});users.push(active.userId)
 await prisma.locationMember.create({data:{organizationId:org.id,locationId:org.locationId!,memberId:active.id}})
 await assert.rejects(at(()=>listFormerMembers(active.userId,org.id,options)),code('INSUFFICIENT_PERMISSIONS'))
})
