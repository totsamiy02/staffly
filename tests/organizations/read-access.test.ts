import assert from 'node:assert/strict'
import { before, after, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { SignJWT } from 'jose'
import sharp from 'sharp'
import { prisma, databasePool } from '../../src/server/db.ts'
import { Prisma } from '../../src/generated/prisma/client.ts'
import { createOrganization } from '../../src/server/organizations/organization-service.ts'
import { getMembership } from '../../src/server/organizations/access/permissions.ts'
import { customRequestWhere, customRequestSql } from '../../src/server/access/request-policy.ts'
import { canReadCustom } from '../../src/server/requests/workflow.ts'
import { listRequests, getRequest, createRequestType } from '../../src/server/requests/service.ts'
import { listNotificationHistory, readHistoryNotification, updateAllNotifications } from '../../src/server/organizations/notification-service.ts'
import { performanceSnapshot } from '../../src/server/performance.ts'
import { replaceUserAvatar, removeUserAvatar, replaceOrganizationLogo, removeOrganizationLogo, stageStoredFile } from '../../src/server/storage/image-service.ts'
import mediaRoutes from '../../src/server/storage/routes.ts'
import { downloadRequestAttachment } from '../../src/server/requests/attachment-service.ts'
import { enqueueExport, getExport } from '../../src/server/schedule/reports/export-jobs.ts'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'
import { getDocument } from '../../src/server/documents/service.ts'
import { documentReadSql, canReadDocument } from '../../src/server/access/document-policy.ts'

let org: string, point: string, second: string, typeId: string, roleId: string, ownerMember: string
const users: Record<string, string> = {}, members: Record<string, string> = {}
const code = (value: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === value
const permissions = ['requests.view','requests.own','requests.resolve','requests.attachments','members.view','documents.view','documents.download','reports.export','reports.preview']
async function setPermissions(values = permissions) { await prisma.accessRole.update({where:{id:roleId},data:{permissions:values}}) }
const requestData = (patch: Partial<Prisma.OrganizationRequestCreateManyInput> = {}): Prisma.OrganizationRequestCreateManyInput => ({ organizationId:org,locationId:point,createdByMemberId:members.employee,requestTypeId:typeId,typeNameSnapshot:'Access fixture',status:'REGISTERED',formSnapshot:{version:1,visibility:'TEAM'},...patch })
before(async () => {
  for (const key of ['owner','viewer','employee','foreign']) users[key] = (await prisma.user.create({data:{email:`read-${key}-${randomUUID()}@example.test`,passwordHash:'test-only',emailVerifiedAt:new Date()}})).id
  const organization = await createOrganization(users.owner,{name:'Read access matrix',timezone:'Europe/Moscow',description:null,firstLocation:{name:'First',city:'Test',address:'Test',timezone:'Europe/Moscow'},locations:[{name:'Second',city:'Test',address:'Test',timezone:'Europe/Moscow'}]})
  org=organization.id; [point,second]=organization.locations.map(l=>l.id); ownerMember=(await getMembership(users.owner,org)).id
  roleId=(await prisma.accessRole.create({data:{organizationId:org,name:'Read matrix',permissions}})).id
  for (const key of ['viewer','employee']) {
    members[key]=(await prisma.organizationMember.create({data:{organizationId:org,userId:users[key],accessConfigured:key==='viewer'}})).id
    await prisma.locationMember.create({data:{organizationId:org,locationId:point,memberId:members[key]}})
  }
  await prisma.accessAssignment.create({data:{organizationId:org,locationId:point,memberId:members.viewer,roleId}})
  typeId=(await createRequestType(users.owner,org,{name:'Access matrix',dateMode:'NONE',requiresComment:false,allowsAttachments:true})).id
})
after(async()=>{
  for(const userId of Object.values(users)) await removeUserAvatar(userId)
  await prisma.accountNotification.deleteMany({where:{organizationId:org}})
  await prisma.document.deleteMany({where:{organizationId:org}})
  await prisma.documentFolder.deleteMany({where:{organizationId:org}})
  await prisma.organizationRequest.deleteMany({where:{organizationId:org}})
  await prisma.organization.deleteMany({where:{id:org}})
  await prisma.storedFile.deleteMany({where:{uploadedByUserId:{in:Object.values(users)}}})
  await prisma.user.deleteMany({where:{id:{in:Object.values(users)}}})
  await prisma.$disconnect()
})

it('matches pure, Prisma and SQL custom access for legacy, team, reviewers, roles, assignees and another point',async()=>{
  const variants: Partial<Prisma.OrganizationRequestCreateManyInput>[] = [
    {formSnapshot:{}}, {formSnapshot:{version:1}}, {formSnapshot:{version:1,visibility:'TEAM'}},
    {formSnapshot:{version:1,stages:[{name:'Review',memberId:members.viewer}]}},
    {formSnapshot:{version:1,stages:[{name:'Review',memberId:members.employee}]}},
    {formSnapshot:{version:1,stages:[{name:'Review',roleId}]}},
    {formSnapshot:{version:1,visibility:'TEAM'},outcome:{assignees:[members.viewer]}},
    {formSnapshot:{version:1,visibility:'TEAM'},outcome:{assignees:[members.employee]}},
    {createdByMemberId:members.viewer}, {authorMemberId:members.viewer}, {locationId:second},
  ]
  const ids:string[]=[]
  try {
    for(const variant of variants)ids.push((await prisma.organizationRequest.create({data:requestData(variant)})).id)
    for(const current of [permissions, ['requests.view'], ['requests.own'], []]) {
      await setPermissions(current)
      const actor=await getMembership(users.viewer,org), roles=await prisma.accessRole.findMany({where:{organizationId:org}})
      const fixtures=await prisma.organizationRequest.findMany({where:{id:{in:ids}}})
      const expected=[]
      for(const row of fixtures)if(await canReadCustom(prisma,actor,row,roles))expected.push(row.id)
      const orm=await prisma.organizationRequest.findMany({where:{AND:[{id:{in:ids}},customRequestWhere(actor,roles)]},select:{id:true}})
      const sql=await prisma.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT r.id FROM requests r WHERE r.id = ANY(${ids}::uuid[]) AND ${customRequestSql(actor,roles)}`)
      assert.deepEqual(orm.map(r=>r.id).sort(),expected.sort(),`Prisma ${current}`)
      assert.deepEqual(sql.map(r=>r.id).sort(),expected.sort(),`SQL ${current}`)
    }
  } finally {await setPermissions();await prisma.organizationRequest.deleteMany({where:{id:{in:ids}}})}
})

it('paginates 6000 archived requests and notifications in SQL with bounded query count and exact readable totals',async(t)=>{
  const ids=Array.from({length:6000},()=>randomUUID())
  try {
    for(let start=0;start<ids.length;start+=500) {
      await prisma.organizationRequest.createMany({data:ids.slice(start,start+500).map((id,i)=>requestData({id,createdAt:new Date(1700000000000+start+i),formSnapshot:i%2?{version:1,visibility:'TEAM'}:{version:1,stages:[{name:'Restricted',memberId:members.employee}]}}))})
      await prisma.accountNotification.createMany({data:ids.slice(start,start+500).map(requestId=>({organizationId:org,userId:users.viewer,requestId,type:'REQUEST_CREATED',title:'History',message:'Test'}))})
    }
    let maxRows = 0
    const observed = new WeakSet<import('pg').PoolClient>()
    const record = (result: any) => { if (Array.isArray(result?.rows)) maxRows = Math.max(maxRows, result.rows.length) }
    const observe = (client: import('pg').PoolClient) => {
      if (observed.has(client)) return
      observed.add(client)
      const query = client.query
      t.mock.method(client, 'query', function(this: import('pg').PoolClient, ...args: any[]) {
        const callback = args.at(-1)
        if (typeof callback === 'function') args[args.length - 1] = (error: unknown, result: unknown) => { record(result); callback(error,result) }
        const result = Reflect.apply(query,this,args)
        return result?.then ? result.then((value: unknown) => { record(value); return value }) : result
      })
    }
    databasePool.on('acquire', observe)
    t.after(() => databasePool.off('acquire', observe))
    const before=performanceSnapshot().measurements.sql?.count??0, started=performance.now()
    const page=await listRequests(users.viewer,org,'history',{page:1,pageSize:15})
    const notifications=await listNotificationHistory(users.viewer,'unused@example.test',{organizationId:org,limit:15})
    const count=(performanceSnapshot().measurements.sql?.count??0)-before
    assert.equal(page.pagination.total,3000);assert.equal(page.requests.length,15)
    assert.equal(notifications.unreadCount,3000);assert.equal(notifications.notifications.length,15);assert.ok(notifications.nextCursor)
    const next=await listNotificationHistory(users.viewer,'unused@example.test',{organizationId:org,limit:15,cursor:notifications.nextCursor!})
    assert.ok(next.notifications.every(n=>!notifications.notifications.some(p=>p.id===n.id)))
    assert.ok(maxRows<=16, `No query may return the archive to Node: largest result ${maxRows}`)
    assert.ok(count<35,`Archive query count: ${count}`)
    console.log(JSON.stringify({accessArchiveRows:6000,visible:3000,page:15,sqlQueries:count,maxRowsFromSql:maxRows,elapsedMs:Math.round(performance.now()-started)}))
    const denied=await prisma.accountNotification.findFirstOrThrow({where:{requestId:ids[0]}})
    await assert.rejects(readHistoryNotification(users.viewer,'unused@example.test',`event:${denied.id}`,false,org),code('NOTIFICATION_NOT_FOUND'))
    await assert.rejects(updateAllNotifications(users.viewer,'unused@example.test',{organizationId:org},`event:${denied.id}`),code('NOTIFICATION_NOT_FOUND'))
    await updateAllNotifications(users.viewer,'unused@example.test',{organizationId:org})
    assert.equal(await prisma.accountNotification.count({where:{organizationId:org,readAt:{not:null}}}),3000)
    assert.equal((await listNotificationHistory(users.viewer,'unused@example.test',{organizationId:org,limit:15})).unreadCount,0)
  } finally {await prisma.accountNotification.deleteMany({where:{requestId:{in:ids}}});await prisma.organizationRequest.deleteMany({where:{id:{in:ids}}})}
})

it('protects avatar bytes on both old/new URLs, revokes role, departure, deletion and session access; keeps current logos public',async()=>{
  const app=express();app.use('/api',mediaRoutes);app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code}))
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve))
  const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const sessions:Record<string,string>={}, headers:Record<string,Record<string,string>>={}
  try {
    for(const key of ['viewer','employee','foreign']) {
      const session=await prisma.authSession.create({data:{userId:users[key],refreshTokenHash:randomUUID(),idleExpiresAt:new Date(Date.now()+600000),absoluteExpiresAt:new Date(Date.now()+600000)}});sessions[key]=session.id
      const token=await new SignJWT({sid:session.id}).setProtectedHeader({alg:'HS256'}).setSubject(users[key]).setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET!))
      headers[key]={Authorization:`Bearer ${token}`}
    }
    const image=await sharp({create:{width:8,height:8,channels:3,background:'#555'}}).png().toBuffer()
    const url=(await replaceUserAvatar(users.employee,image))!,old=url.replace('/v2/','/')
    for(const path of [url,old]) {
      assert.equal((await fetch(base+path)).status,401)
      assert.equal((await fetch(base+path,{headers:headers.foreign})).status,404)
      const response=await fetch(base+path,{headers:{...headers.viewer,'If-None-Match':'*'}})
      assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('etag'),null)
      assert.ok((await response.arrayBuffer()).byteLength>0)
    }
    await setPermissions([]);assert.equal((await fetch(base+url,{headers:headers.viewer})).status,404)
    assert.equal((await fetch(base+url,{headers:headers.employee})).status,200)
    await setPermissions();await prisma.locationMember.updateMany({where:{memberId:members.employee},data:{locationId:second}})
    assert.equal((await fetch(base+url,{headers:headers.viewer})).status,404)
    await prisma.locationMember.updateMany({where:{memberId:members.employee},data:{locationId:point}})
    await prisma.organizationMember.update({where:{id:members.employee},data:{leftAt:new Date()}})
    assert.equal((await fetch(base+url,{headers:headers.viewer})).status,404)
    await prisma.organizationMember.update({where:{id:members.employee},data:{leftAt:null}})
    await prisma.authSession.update({where:{id:sessions.viewer},data:{revokedAt:new Date()}})
    assert.equal((await fetch(base+url,{headers:headers.viewer})).status,401)
    const replacement=(await replaceUserAvatar(users.employee,image))!
    assert.equal((await fetch(base+url,{headers:headers.employee})).status,404)
    await removeUserAvatar(users.employee);assert.equal((await fetch(base+replacement,{headers:headers.employee})).status,404)
    const logo=(await replaceOrganizationLogo(users.owner,org,image))!
    const response=await fetch(base+logo);assert.equal(response.status,200);assert.ok(response.headers.get('cache-control')?.includes('no-store'))
    await removeOrganizationLogo(users.owner,org);assert.equal((await fetch(base+logo)).status,404)
  } finally {await setPermissions();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

it('rechecks a saved request, attachment and export after role revocation or departure and rejects foreign accounts',async()=>{
  const request=await prisma.organizationRequest.create({data:requestData()})
  const bytes=Buffer.from('%PDF-1.4\n%%EOF'),file=await stageStoredFile({objectKey:`organizations/${org}/requests/${randomUUID()}.pdf`,purpose:'REQUEST_ATTACHMENT',mimeType:'application/pdf',size:bytes.length,checksumSha256:'0'.repeat(64),uploadedByUserId:users.employee,organizationId:org},bytes)
  await prisma.storedFile.update({where:{id:file.id},data:{pendingDeletionAt:null}})
  const attachment=await prisma.requestAttachment.create({data:{requestId:request.id,storedFileId:file.id,fileName:'test.pdf'}})
  const job=await enqueueExport(users.viewer,org,{from:'2026-01-01',to:'2026-01-31',locationIds:[point],memberIds:[],includeFormer:false,config:defaultReportConfig()})
  try {
    assert.equal((await downloadRequestAttachment(users.viewer,org,request.id,attachment.id)).contents.length,bytes.length)
    assert.equal((await getExport(users.viewer,org,job.id)).job.id,job.id)
    await assert.rejects(getRequest(users.foreign,org,request.id),code('ORGANIZATION_NOT_FOUND'))
    await assert.rejects(downloadRequestAttachment(users.foreign,org,request.id,attachment.id),code('ORGANIZATION_NOT_FOUND'))
    await assert.rejects(getExport(users.foreign,org,job.id),code('EXPORT_NOT_FOUND'))
    await setPermissions(['requests.view'])
    await assert.rejects(downloadRequestAttachment(users.viewer,org,request.id,attachment.id),code('INSUFFICIENT_PERMISSIONS'))
    await assert.rejects(getExport(users.viewer,org,job.id))
    await setPermissions([]);await assert.rejects(getRequest(users.viewer,org,request.id),code('REQUEST_NOT_FOUND'))
    await setPermissions();await prisma.organizationMember.update({where:{id:members.viewer},data:{leftAt:new Date()}})
    await assert.rejects(downloadRequestAttachment(users.viewer,org,request.id,attachment.id),code('ORGANIZATION_NOT_FOUND'))
    await assert.rejects(getExport(users.viewer,org,job.id),code('ORGANIZATION_NOT_FOUND'))
  } finally {await setPermissions();await prisma.organizationMember.update({where:{id:members.viewer},data:{leftAt:null}});await prisma.organizationRequest.delete({where:{id:request.id}})}
})

it('uses the same document and notification policy for a restricted ancestor, point and current role',async()=>{
  const folder=await prisma.documentFolder.create({data:{organizationId:org,locationId:point,name:'Private parent',visibility:'SELECTED',audienceMemberIds:[members.viewer]}})
  const file=await prisma.storedFile.create({data:{objectKey:`organizations/${org}/documents/${randomUUID()}.txt`,purpose:'DOCUMENT',mimeType:'text/plain',size:4,checksumSha256:'0'.repeat(64),uploadedByUserId:users.owner,organizationId:org}})
  const document=await prisma.document.create({data:{organizationId:org,locationId:point,folderId:folder.id,storedFileId:file.id,uploadedByMemberId:ownerMember,fileName:'test.txt',displayName:'Test',visibility:'ORGANIZATION'}})
  const note=await prisma.accountNotification.create({data:{organizationId:org,userId:users.viewer,documentId:document.id,type:'DOCUMENT_ASSIGNED',title:'Document',message:'Test'}})
  try {
    assert.equal((await getDocument(users.viewer,org,document.id)).id,document.id)
    assert.ok((await listNotificationHistory(users.viewer,'unused@example.test',{organizationId:org,limit:15})).notifications.some(n=>n.id===`event:${note.id}`))
    for(const visibility of ['ORGANIZATION','SELECTED','ADMINS','PRIVATE_MEMBER'] as const) {
      const doc=await prisma.document.update({where:{id:document.id},data:{visibility,audienceMemberIds:[members.viewer],targetMemberId:members.employee}})
      const actor=await getMembership(users.viewer,org)
      const sql=await prisma.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT d.id FROM documents d WHERE d.id = ${doc.id}::uuid AND ${documentReadSql(actor)}`)
      assert.equal(sql.length>0,canReadDocument(actor,doc),visibility)
    }
    await prisma.document.update({where:{id:document.id},data:{visibility:'ORGANIZATION'}})
    await prisma.documentFolder.update({where:{id:folder.id},data:{audienceMemberIds:[ownerMember]}})
    await assert.rejects(getDocument(users.viewer,org,document.id),code('DOCUMENT_NOT_FOUND'))
    assert.ok(!(await listNotificationHistory(users.viewer,'unused@example.test',{organizationId:org,limit:15})).notifications.some(n=>n.id===`event:${note.id}`))
    await prisma.documentFolder.update({where:{id:folder.id},data:{audienceMemberIds:[members.viewer]}})
    await setPermissions([])
    await assert.rejects(getDocument(users.viewer,org,document.id),code('DOCUMENT_NOT_FOUND'))
  } finally {await setPermissions()}
})
