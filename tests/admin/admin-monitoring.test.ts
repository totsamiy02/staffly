import { managementScenarios } from './management-scenarios.ts'
import { supportResponses } from '../../src/server/support/diagnostics.ts'
import { securityContext } from '../../src/server/security/journal.ts'
import { createSupportRouter } from '../../src/server/support/routes.ts'
import { processEmailDeliveries,enqueueEmail } from '../../src/server/mail/email-outbox.ts'
import { processReportExport } from '../../src/server/schedule/reports/export-jobs.ts'
import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Server } from 'node:http'
import express from 'express'
import cookieParser from 'cookie-parser'
import { ZodError } from 'zod'
import { prisma, databasePool } from '../../src/server/db.ts'
import authRouter from '../../src/server/auth.ts'
import profileRouter from '../../src/server/profile/routes.ts'
import { passwordHash } from '../../src/server/auth/passwords.ts'
import { createAdminRouter } from '../../src/server/admin/routes.ts'
import { closeAdminDatabase,adminPool,adminTransaction } from '../../src/server/admin/database.ts'
import { collectMonitoringSample, collectMonitoringCycle, recordOrganizationPresence, recordFeature } from '../../src/server/admin/collection.ts'
import { safeError } from '../../src/server/security/safe-error.ts'
import { ApiError } from '../../src/server/api-error.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { captureRequestFailure,publishOperationsSnapshot,runtimeNodeId,runtimeConfiguration,startOperationsTelemetry } from '../../src/server/admin/operations/telemetry.ts'
import { startBackgroundTask } from '../../src/server/background-task.ts'
import { setImmediate as turn } from 'node:timers/promises'
import { EventEmitter } from 'node:events'

const browserReference=()=>{const id=randomUUID();return id.slice(0,14)+'8'+id.slice(15)}
const suffix=randomUUID(),password='StafflyAdminTesting-72!',pin='628491',users:string[]=[],organizations:string[]=[],codes=new Map<string,string>()
const operationJobs:string[]=[],operationNodes:string[]=[]
let server:Server,base:string,hash:string
const origin=process.env.APP_ORIGIN??'http://localhost:5173'
class Browser{
 cookies=new Map<string,string>();token='';userId='';email='';receivedCookies:string[]=[]
 async request(path:string,body?:unknown,extra:Record<string,string>={}){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(this.token?{Authorization:`Bearer ${this.token}`}:{ }),Cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})})
  for(const cookie of response.headers.getSetCookie()){this.receivedCookies.push(cookie);const [pair]=cookie.split(';'),at=pair.indexOf('='),key=pair.slice(0,at),value=pair.slice(at+1);if(value)this.cookies.set(key,decodeURIComponent(value));else this.cookies.delete(key)}
  return response
 }
 async signIn(){const response=await this.request('/api/auth/login',{email:this.email,password});assert.equal(response.status,200);const data=await response.json();this.token=data.accessToken;return data}
 async challenge(purpose='LOGIN'){const response=await this.request('/api/admin/challenge',{password,purpose});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return response.json()}
 async elevate(){const challenge=await this.challenge(),response=await this.request('/api/admin/verify',{challengeId:challenge.challengeId,code:codes.get(this.email)});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return response.json()}
 async ready(){const state=await this.elevate();assert.equal(state.state,'setup-pin');const response=await this.request('/api/admin/pin',{pin,confirmPin:pin});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));assert.equal((await response.json()).state,'active');return this}
}
async function account(admin=true){const browser=new Browser();browser.email=`admin-${randomUUID()}-${suffix}@example.test`;const user=await prisma.user.create({data:{email:browser.email,passwordHash:hash,emailVerifiedAt:new Date(),firstName:'Тест',lastName:'Мониторинга'}});users.push(user.id);browser.userId=user.id;if(admin)await databasePool.query('INSERT INTO staffly_admin.accounts(user_id) VALUES($1)',[user.id]);await browser.signIn();return browser}
async function expireIdle(browser:Browser){await databasePool.query("UPDATE staffly_admin.sessions SET activity_at=now()-interval '6 minutes' WHERE user_id=$1",[browser.userId])}

describe('Platform administrator boundary and monitoring',()=>{
 before(async()=>{
  hash=await passwordHash(password)
  const app=express();app.use(securityContext);app.use(supportResponses);app.use(express.json({limit:'16kb'}));app.use(cookieParser());app.use('/api/auth',authRouter);app.use('/api/admin',createAdminRouter({sendCode:async(email,code)=>{codes.set(email,code)},sendManagementCode:async(email,code)=>{codes.set(email,code)}}));app.use('/api',profileRouter);app.use('/api/support',createSupportRouter());app.get('/api/support-probe/:id',(_q,_s)=>{throw new ApiError(409,'CONCURRENT_UPDATE','Test conflict')})
  app.use((error:unknown,_request:express.Request,response:express.Response,_next:express.NextFunction)=>{response.locals.supportError=error;response.status(error instanceof ApiError?error.status:error instanceof ZodError?400:500).json({code:error instanceof ApiError?error.code:'INTERNAL_ERROR',message:error instanceof ApiError?error.message:'Не удалось выполнить действие.'})})
  server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}`
 })
 after(async()=>{
  await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections()})
  for(const id of organizations)await prisma.organization.update({where:{id},data:{deletedAt:new Date()}})
  await prisma.authSession.deleteMany({where:{userId:{in:users}}})
  await prisma.reportExport.deleteMany({where:{id:{in:operationJobs}}})
  await prisma.emailDelivery.deleteMany({where:{userId:{in:users}}})
  await prisma.platformRequestError.deleteMany({where:{nodeId:runtimeNodeId}})
  await prisma.platformRuntimeNode.deleteMany({where:{id:{in:operationNodes}}})
  await databasePool.query('DELETE FROM staffly_admin.accounts WHERE user_id=ANY($1::uuid[])',[users])
  await databasePool.query('DELETE FROM staffly_admin.audit_events WHERE user_id=ANY($1::uuid[])',[users])
  await closeAdminDatabase();await prisma.$disconnect()
 })
 it('protects every operations route with ordinary authorization, elevation and server PIN lock',async()=>{
  const anonymous=new Browser(),ordinary=await account(false),admin=await account()
  const id=randomUUID(),paths=['/operations/service','/operations/jobs','/operations/jobs/report/'+id,'/operations/support','/operations/support/'+id]
  for(const path of paths){assert.equal((await anonymous.request('/api/admin'+path)).status,401);assert.equal((await ordinary.request('/api/admin'+path)).status,403);assert.equal((await admin.request('/api/admin'+path)).status,403)}
  await admin.ready();await admin.request('/api/admin/lock',{})
  for(const path of paths)assert.equal((await admin.request('/api/admin'+path)).status,423)
  assert.equal((await admin.request('/api/admin/operations/jobs/report/'+id+'/retry',{confirm:true})).status,423)
 })
 it('collects safe cross-process snapshots and links an API support code without storing private request data',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'Operations '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const marker='private-ops-'+randomUUID(),id=randomUUID(),nodeId=randomUUID();operationNodes.push(nodeId)
  const request={method:'POST',route:{path:'/organizations/:organizationId/documents'},auth:{userId:browser.userId},body:{secret:marker},headers:{authorization:marker}} as unknown as express.Request
  captureRequestFailure(Object.assign(new Error(marker),{code:'42P01',sql:marker}),request,500,id,org.id)
  const stop=startBackgroundTask({name:'Email worker',intervalMs:60000,run:async()=>{throw Object.assign(new Error(marker),{code:'EAUTH'})}})
  try{await turn();await publishOperationsSnapshot({role:'api',ready:()=>true,nodeId,http:()=>({requests:8,errors:1,active:0,meanMs:12})})}finally{await stop()}
  const support=await browser.request('/api/admin/operations/support?search='+id);assert.equal(support.status,200);assert.match(support.headers.get('cache-control')??'',/no-store/)
  const data=await support.json();assert.equal(data.items.length,1);assert.equal(data.items[0].id,id);assert.equal(data.items[0].diagnostic.code,'42P01');assert.equal(data.items[0].organizationId,org.id);assert(!JSON.stringify(data).includes(marker));assert(!JSON.stringify(data).includes(browser.email))
  const detail=await(await browser.request('/api/admin/operations/support/'+id)).json();assert.equal(detail.route,'/organizations/:organizationId/documents')
  const stored=await prisma.platformRequestError.findUniqueOrThrow({where:{id}});assert(!JSON.stringify(stored).includes(marker))
  const before=(await databasePool.query('SELECT activity_at FROM staffly_admin.sessions WHERE user_id=$1',[browser.userId])).rows[0].activity_at.toISOString()
  const service=await(await browser.request('/api/admin/operations/service')).json(),node=service.nodes.find((n:{id:string})=>n.id===nodeId)
  assert.equal(node.state,'healthy');assert.equal(node.snapshot.http.requests,8);assert(node.snapshot.tasks.some((t:{label:string;error:{code:string}})=>t.label==='Доставка писем'&&t.error.code==='EAUTH'));assert(!JSON.stringify(service).includes(marker));assert(service.databaseMs>=0)
  assert.equal((await databasePool.query('SELECT activity_at FROM staffly_admin.sessions WHERE user_id=$1',[browser.userId])).rows[0].activity_at.toISOString(),before)
  await prisma.platformRuntimeNode.update({where:{id:nodeId},data:{heartbeatAt:new Date(Date.now()-60000)}})
  assert.equal((await(await browser.request('/api/admin/operations/service')).json()).nodes.find((n:{id:string})=>n.id===nodeId).state,'offline')
  await prisma.platformRuntimeNode.update({where:{id:nodeId},data:{stoppedAt:new Date()}})
  assert.equal((await(await browser.request('/api/admin/operations/service')).json()).nodes.find((n:{id:string})=>n.id===nodeId).state,'stopped')
 })
 it('flushes a request-error burst promptly without waiting for the next ten-second process heartbeat',async()=>{
  const nodeId=randomUUID(),ids=Array.from({length:120},()=>randomUUID());operationNodes.push(nodeId)
  const stop=startOperationsTelemetry({role:'api',ready:()=>true,nodeId})
  try{
   for(let i=0;i<50&&!await prisma.platformRuntimeNode.count({where:{id:nodeId}});i++)await new Promise(resolve=>setTimeout(resolve,25))
   for(const id of ids)captureRequestFailure(new ApiError(503,'DATABASE_BUSY','safe'),{method:'GET',route:{path:'/api/example'}} as express.Request,503,id)
   let saved=0;for(let i=0;i<100;i++){saved=await prisma.platformRequestError.count({where:{id:{in:ids}}});if(saved===ids.length)break;await new Promise(resolve=>setTimeout(resolve,25))}
   assert.equal(saved,120)
  }finally{await stop()}
  assert((await prisma.platformRuntimeNode.findUniqueOrThrow({where:{id:nodeId}})).stoppedAt)
 })
 it('strips extra telemetry fields and malformed snapshots instead of returning raw JSON',async()=>{
  const browser=await account();await browser.ready();const nodeId=randomUUID(),marker='secret-snapshot-'+randomUUID();operationNodes.push(nodeId)
  await publishOperationsSnapshot({role:'worker',ready:()=>true,nodeId})
  const node=await prisma.platformRuntimeNode.findUniqueOrThrow({where:{id:nodeId}}),value=node.snapshot as Record<string,unknown>
  await prisma.platformRuntimeNode.update({where:{id:nodeId},data:{snapshot:{...value,secret:marker,config:{...(value.config as object),password:marker}} as never}})
  let service=await(await browser.request('/api/admin/operations/service')).json();assert(!JSON.stringify(service).includes(marker))
  await prisma.platformRuntimeNode.update({where:{id:nodeId},data:{snapshot:{secret:marker}}})
  service=await(await browser.request('/api/admin/operations/service')).json();const result=service.nodes.find((n:{id:string})=>n.id===nodeId);assert.equal(result.state,'unknown');assert.equal(result.snapshot,null);assert(!JSON.stringify(service).includes(marker))
 })
 it('filters and pages jobs using metadata only, without recipient email, payload, report input or object keys',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'Queue '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const marker='private-job-'+randomUUID()
  const email=await prisma.emailDelivery.create({data:{userId:browser.userId,organizationId:org.id,sourceKey:randomUUID(),sourceKind:'MANDATORY',recipientEmail:'private-recipient@example.test',payload:{secret:marker},status:'FAILED',attempts:7}})
  const job=await prisma.reportExport.create({data:{userId:browser.userId,organizationId:org.id,input:{secret:marker},inputHash:'a'.repeat(64),status:'FAILED',attempts:1,errorCode:'EXPORT_FAILED',objectKey:marker,expiresAt:new Date(Date.now()+3600000)}});operationJobs.push(job.id)
  const response=await browser.request('/api/admin/operations/jobs?organizationId='+org.id+'&status=FAILED');assert.equal(response.status,200);const result=await response.json();assert.equal(result.total,2);assert(!JSON.stringify(result).includes(marker));assert(!JSON.stringify(result).includes('private-recipient'))
  const found=await(await browser.request('/api/admin/operations/jobs?search='+job.id)).json();assert.equal(found.total,1);assert.equal(found.items[0].canRetry,true)
  const details=await(await browser.request('/api/admin/operations/jobs/email/'+email.id)).json();assert.equal(details.status,'FAILED');assert.equal(details.maxAttempts,7);assert(!('payload'in details));assert(!('leaseToken'in details))
  for(const query of ['page=0','days=365','kind=evil','search='+'x'.repeat(121),'organizationId=bad'])assert.equal((await browser.request('/api/admin/operations/jobs?'+query)).status,400)
  assert.equal((await browser.request('/api/admin/operations/support/not-an-id')).status,400)
  assert.equal((await browser.request('/api/admin/operations/jobs/report/'+randomUUID())).status,404)
 })
 it('searches queue metadata immediately by organization, user and full task ID with consistent filtered totals',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'Северная пекарня Search Queue '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const old=await prisma.emailDelivery.create({data:{userId:browser.userId,organizationId:org.id,sourceKey:randomUUID(),sourceKind:'MANDATORY',status:'PENDING',createdAt:new Date(Date.now()-35*86400_000)}})
  for(const search of[org.name,org.name.toLowerCase(),org.id,browser.userId,browser.email.toUpperCase(),old.id,'Тест Мониторинга']){
   const value=await(await browser.request('/api/admin/operations/jobs?days=1&search='+encodeURIComponent(search))).json()
   assert(value.items.some((item:{id:string})=>item.id===old.id),JSON.stringify(value));assert.equal(value.summary.reduce((n:number,row:{count:number})=>n+row.count,0),value.total)
  }
  const none=await(await browser.request('/api/admin/operations/jobs?search=absent-'+randomUUID())).json();assert.equal(none.total,0);assert.equal(none.summary.length,0)
  await prisma.emailDelivery.delete({where:{id:old.id}})
 })
 it('records the exact public code for direct and thrown 4xx replies, while service failure counts remain 5xx only',async()=>{
  const browser=await account();await browser.ready()
  const response=await browser.request('/api/support-probe/'+randomUUID());assert.equal(response.status,409)
  const body=await response.json();assert.match(body.errorId,/^[0-9a-f-]{36}$/);assert.equal(response.headers.get('x-support-code'),body.errorId)
  await publishOperationsSnapshot({role:'api',ready:()=>true})
  const result=await(await browser.request('/api/admin/operations/support?search='+body.errorId)).json();assert.equal(result.total,1);assert.equal(result.items[0].eventCode,'CONCURRENT_UPDATE');assert.equal(result.items[0].route,'/api/support-probe/:id');assert.equal(result.items[0].status,409)
  assert.equal((await prisma.platformRequestError.findUniqueOrThrow({where:{id:body.errorId}})).status,409)
 })
 it('preserves a wrapped provider cause as an allowlisted diagnostic without exposing its message, stack or credentials',async()=>{
  const browser=await account();await browser.ready();const id=randomUUID(),marker='private-provider-password'
  const error=new ApiError(503,'SECURITY_EMAIL_UNAVAILABLE','Public message',undefined,Object.assign(new Error(marker),{code:'EAUTH',response:marker}))
  captureRequestFailure(error,{method:'POST',route:{path:'/api/profile/email-change'},auth:{userId:browser.userId}} as unknown as express.Request,503,id,undefined,error.code)
  await publishOperationsSnapshot({role:'api',ready:()=>true})
  const result=await(await browser.request('/api/admin/operations/support/'+id)).json();assert.equal(result.diagnostic.code,'EAUTH');assert.equal(result.eventCode,'SECURITY_EMAIL_UNAVAILABLE');assert(!JSON.stringify(result).includes(marker));assert(!JSON.stringify(result).includes('Public message'))
 })
 it('stores real failed email attempts and report processing, retaining support codes after the queue entry expires',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'Worker failure '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const key=randomUUID(),marker='private-worker-marker'
  await enqueueEmail(prisma,{userId:browser.userId,organizationId:org.id,sourceKind:'MANDATORY',sourceKey:key,content:{title:'Test',intro:marker}})
  const mail=await prisma.emailDelivery.findUniqueOrThrow({where:{sourceKey:key}})
  const send=async()=>{throw Object.assign(new Error(marker),{code:'EAUTH'})}
  assert.equal(await processEmailDeliveries({limit:1,send}),1)
  let row=await prisma.emailDelivery.findUniqueOrThrow({where:{id:mail.id}});assert.equal(row.lastErrorCode,'EAUTH');assert.equal(row.status,'PENDING')
  let incidents=await prisma.platformRequestError.findMany({where:{jobId:mail.id}});assert.equal(incidents.length,1);assert.equal(incidents[0].code,'EAUTH');assert(incidents[0].nextAttemptAt);assert.equal(incidents[0].attempt,1)
  await prisma.emailDelivery.update({where:{id:mail.id},data:{attempts:6,availableAt:new Date(Date.now()-1000)}});await processEmailDeliveries({limit:1,send})
  row=await prisma.emailDelivery.findUniqueOrThrow({where:{id:mail.id}});assert.equal(row.status,'FAILED');incidents=await prisma.platformRequestError.findMany({where:{jobId:mail.id}});assert.equal(incidents.length,2);assert(incidents.some(i=>i.attempt===7&&i.nextAttemptAt===null));assert(!JSON.stringify(incidents).includes(marker))
  const queue=await(await browser.request('/api/admin/operations/jobs/email/'+mail.id)).json();assert(queue.lastFailure.id);assert.equal(queue.diagnosticCode,'EAUTH')
  await prisma.emailDelivery.delete({where:{id:mail.id}})
  const history=await(await browser.request('/api/admin/operations/support?search='+mail.id)).json();assert.equal(history.total,2)
  const detail=await(await browser.request('/api/admin/operations/support/'+mail.id)).json();assert.equal(detail.jobId,mail.id);assert.equal(detail.attempt,7)
  const report=await prisma.reportExport.create({data:{userId:browser.userId,organizationId:org.id,input:{invalid:marker},inputHash:randomUUID().padEnd(64,'a'),expiresAt:new Date(Date.now()+3600000)}});operationJobs.push(report.id)
  assert.equal(await processReportExport(),true);assert.equal((await prisma.reportExport.findUniqueOrThrow({where:{id:report.id}})).status,'FAILED')
  const reportFailure=await prisma.platformRequestError.findFirstOrThrow({where:{jobId:report.id}});assert.equal(reportFailure.source,'report');assert.equal(reportFailure.eventCode,'EXPORT_FAILED');assert(!JSON.stringify(reportFailure).includes(marker))
  await prisma.reportExport.delete({where:{id:report.id}});assert.equal((await(await browser.request('/api/admin/operations/support/'+report.id)).json()).id,reportFailure.id)
 })
 it('accepts bounded browser diagnostics, derives user context from authentication and rejects private text and forged organization context',async()=>{
  const browser=await account();await browser.ready();const other=await account(false),org=await createBusinessOrganization(other.userId,{name:'Other browser org '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const body={id:browserReference(),at:new Date().toISOString(),kind:'NETWORK_ERROR',area:'reports',organizationId:org.id}
  assert.equal((await browser.request('/api/support/client-errors',{...body,stack:'private'})).status,400)
  assert.equal((await browser.request('/api/support/client-errors',{...body,id:randomUUID()})).status,400)
  assert.equal((await browser.request('/api/support/client-errors',body)).status,202)
  const incident=await prisma.platformRequestError.findUniqueOrThrow({where:{id:body.id}});assert.equal(incident.userId,browser.userId);assert.equal(incident.organizationId,null);assert.equal(incident.source,'client');assert.equal(incident.eventCode,'NETWORK_ERROR')
  assert.equal((await browser.request('/api/support/client-errors',body)).status,202);assert.equal(await prisma.platformRequestError.count({where:{id:body.id}}),1)
  assert.equal((await browser.request('/api/support/client-errors',{...body,id:browserReference(),at:new Date(Date.now()-2*86400_000).toISOString()})).status,400)
  const data=await(await browser.request('/api/admin/operations/support?source=client&search='+body.id)).json();assert.equal(data.total,1)
  assert.equal((await other.request('/api/admin/operations/support?search='+body.id)).status,403)
 })
 it('keeps shared error references in admin diagnostics without a separate user history endpoint',async()=>{
  const owner=await account(),other=await account(false);await owner.ready()
  const id=browserReference();assert.equal((await other.request('/api/support/client-errors',{id,at:new Date().toISOString(),kind:'INVALID_RESPONSE',area:'profile',organizationId:null})).status,202)
  const result=await owner.request('/api/admin/operations/support?search='+id).then(r=>r.json());assert.equal(result.total,1);assert.equal(result.items[0].id,id)
  assert.equal((await owner.request('/api/support/mine')).status,404)
  assert.equal((await other.request('/api/admin/operations/support?search='+id)).status,403)
 })
 it('measures every queue state, service resources and safe failure series with known nonzero samples',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'All queue states '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const now=new Date(),later=new Date(Date.now()+60000)
  const rows=[{status:'PENDING'},{status:'PENDING',availableAt:later},{status:'PENDING',availableAt:later,attempts:2},{status:'PENDING',lockedUntil:later,attempts:1},{status:'SENT',deliveredAt:now},{status:'SKIPPED'},{status:'FAILED',attempts:7}]
  for(const row of rows)await prisma.emailDelivery.create({data:{userId:browser.userId,organizationId:org.id,sourceKey:randomUUID(),sourceKind:'MANDATORY',...row}})
  const jobs=await(await browser.request('/api/admin/operations/jobs?organizationId='+org.id)).json();assert.equal(jobs.total,7)
  assert.deepEqual(jobs.summary.map((row:{status:string;count:number})=>[row.status,row.count]).sort(),['PENDING','SCHEDULED','RETRY','RUNNING','DONE','SKIPPED','FAILED'].map(status=>[status,1]).sort())
  const id=randomUUID(),nodeId=randomUUID();operationNodes.push(nodeId)
  captureRequestFailure(Object.assign(new Error('private metric body'),{code:'57014'}),{method:'POST',route:{path:'/organizations/:organizationId/events'},auth:{userId:browser.userId}} as unknown as express.Request,503,id,org.id,'DATABASE_BUSY')
  await publishOperationsSnapshot({role:'api',ready:()=>true,nodeId,http:()=>({requests:19,errors:3,active:2,meanMs:14.5})})
  const service=await(await browser.request('/api/admin/operations/service')).json(),node=service.nodes.find((r:{id:string})=>r.id===nodeId)
  assert(service.databaseMs>=0);assert(service.totals.apis>0);assert(service.totals.workers>0);assert(service.totals.email_failed>0);assert(service.totals.errors>0);assert(service.history.some((r:{errors:number})=>r.errors>0));assert(node.snapshot.rss>0);assert(node.snapshot.heapUsed>0);assert(node.snapshot.uptime>=0);assert(node.snapshot.pool.total>0);assert(node.snapshot.pool.waiting>=0);assert.deepEqual(node.snapshot.http,{requests:19,errors:3,active:2,meanMs:14.5})
  const support=await(await browser.request('/api/admin/operations/support?search='+org.id)).json();assert(support.summary.total>=2);assert(support.summary.recent>=2);assert.equal(support.summary.server,1);assert.equal(support.summary.background,1);assert.equal(support.organizations,1)
 })
 it('retries a failed export once under concurrency and preserves expiry, attempts, admission quotas and private audit',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'Retry '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const expiresAt=new Date(Date.now()+3600000),job=await prisma.reportExport.create({data:{userId:browser.userId,organizationId:org.id,input:{},inputHash:'b'.repeat(64),status:'FAILED',attempts:1,errorCode:'EXPORT_FAILED',expiresAt}});operationJobs.push(job.id)
  const path='/api/admin/operations/jobs/report/'+job.id+'/retry'
  assert.equal((await browser.request(path,{confirm:true},{Origin:'https://evil.test'})).status,403)
  assert.equal((await browser.request(path,{confirm:true,attempts:0})).status,400)
  const responses=await Promise.all([browser.request(path,{confirm:true}),browser.request(path,{confirm:true})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409])
  const current=await prisma.reportExport.findUniqueOrThrow({where:{id:job.id}});assert.equal(current.status,'PENDING');assert.equal(current.attempts,1);assert.equal(+current.expiresAt,+expiresAt);assert.equal(current.leaseToken,null)
  assert.equal((await prisma.organizationResourceBudget.findUniqueOrThrow({where:{organizationId:org.id}})).exportWindowCount,1)
  const {rows}=await databasePool.query("SELECT * FROM staffly_admin.audit_events WHERE resource_id=$1 AND action='EXPORT_RETRY' AND outcome='SUCCEEDED'",[job.id]);assert.equal(rows.length,1);assert.equal(rows[0].user_id,browser.userId)
 })
 it('refuses expired, exhausted and full-queue export retries without mutating the job',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'Retry limits '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const make=async(status:string,attempts=1,expired=false)=>{const job=await prisma.reportExport.create({data:{userId:browser.userId,organizationId:org.id,input:{},inputHash:randomUUID().replaceAll('-','').padEnd(64,'a'),status,attempts,errorCode:'EXPORT_FAILED',expiresAt:new Date(Date.now()+(expired?-1000:3600000))}});operationJobs.push(job.id);return job}
  const exhausted=await make('FAILED',3),expired=await make('FAILED',1,true)
  for(const job of[exhausted,expired])assert.equal((await browser.request('/api/admin/operations/jobs/report/'+job.id+'/retry',{confirm:true})).status,409)
  await make('PENDING');await make('PENDING');const full=await make('FAILED')
  assert.equal((await browser.request('/api/admin/operations/jobs/report/'+full.id+'/retry',{confirm:true})).status,429)
  assert.equal((await prisma.reportExport.findUniqueOrThrow({where:{id:full.id}})).status,'FAILED')
  const {rows:[session]}=await databasePool.query('SELECT * FROM staffly_admin.sessions WHERE user_id=$1',[browser.userId])
  const {rows:[forged]}=await databasePool.query('SELECT staffly_admin.retry_report($1,$2,$3,$4,$5) AS result',[browser.userId,session.auth_session_id,session.id,'0'.repeat(64),full.id]);assert.equal(forged.result,'FORBIDDEN')
 })
 it('limits database gateway actions and diagnostic retention even for directly connected restricted roles',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'Gateway '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const job=await prisma.reportExport.create({data:{userId:browser.userId,organizationId:org.id,input:{},inputHash:'c'.repeat(64),status:'FAILED',attempts:1,errorCode:'EXPORT_FAILED',expiresAt:new Date(Date.now()+3600000)}});operationJobs.push(job.id)
  const {rows:[session]}=await databasePool.query('SELECT * FROM staffly_admin.sessions WHERE user_id=$1',[browser.userId])
  const gateway='ops_gateway_'+randomUUID().replaceAll('-',''),writer='ops_writer_'+randomUUID().replaceAll('-',''),db=await databasePool.connect()
  const asRole=async(role:string,sql:string,values:unknown[]=[])=>{try{await db.query('BEGIN');await db.query('SET LOCAL ROLE "'+role+'"');const result=await db.query(sql,values);await db.query('COMMIT');return result}catch(error){await db.query('ROLLBACK');throw error}}
  try{
   await db.query('CREATE ROLE "'+gateway+'" NOLOGIN');await db.query('CREATE ROLE "'+writer+'" NOLOGIN')
   await db.query('GRANT USAGE ON SCHEMA staffly_admin TO "'+gateway+'"');await db.query('GRANT EXECUTE ON FUNCTION staffly_admin.retry_report(uuid,uuid,uuid,text,uuid) TO "'+gateway+'"')
   await assert.rejects(asRole(gateway,'SELECT input FROM public.report_exports'),(error:{code:string})=>error.code==='42501')
   await assert.rejects(asRole(gateway,'UPDATE staffly_admin.accounts SET enabled=true'),(error:{code:string})=>error.code==='42501')
   const result=await asRole(gateway,'SELECT staffly_admin.retry_report($1,$2,$3,$4,$5) AS result',[browser.userId,session.auth_session_id,session.id,session.token_hash,job.id]);assert.equal(result.rows[0].result,'OK')
   assert.equal((await prisma.reportExport.findUniqueOrThrow({where:{id:job.id}})).attempts,1)
   await db.query('GRANT USAGE ON SCHEMA public TO "'+writer+'"');await db.query('GRANT SELECT,INSERT ON public.platform_request_errors TO "'+writer+'"');await db.query('GRANT EXECUTE ON FUNCTION public.platform_cleanup_diagnostics() TO "'+writer+'"')
   const old=randomUUID(),fresh=randomUUID()
   await asRole(writer,"INSERT INTO public.platform_request_errors(id,node_id,created_at,method,route,status,name) VALUES($1,$3,now()-interval '31 days','GET','/profile',500,'Error'),($2,$3,now(),'GET','/profile',500,'Error')",[old,fresh,runtimeNodeId])
   await assert.rejects(asRole(writer,'DELETE FROM public.platform_request_errors WHERE id=$1',[fresh]),(error:{code:string})=>error.code==='42501')
   await assert.rejects(asRole(writer,'UPDATE public.platform_request_errors SET route=\'/other\' WHERE id=$1',[fresh]),(error:{code:string})=>error.code==='42501')
   await asRole(writer,'SELECT public.platform_cleanup_diagnostics()');assert.equal(await prisma.platformRequestError.findUnique({where:{id:old}}),null);assert(await prisma.platformRequestError.findUnique({where:{id:fresh}}))
   await assert.rejects(asRole(writer,'SELECT staffly_admin.retry_report($1,$2,$3,$4,$5)',[browser.userId,session.auth_session_id,session.id,session.token_hash,job.id]),(error:{code:string})=>error.code==='42501')
  }finally{for(const role of[gateway,writer]){await db.query('DROP OWNED BY "'+role+'"');await db.query('DROP ROLE "'+role+'"')}db.release()}
 })
 it('discards a telemetry connection lost between awaited native queries without an unhandled error',async t=>{
  const failure=Object.assign(new Error('private-disconnect-diagnostic'),{code:'ECONNRESET'}),nodeId=randomUUID();let disconnected=false,released:Error|undefined
  const client=Object.assign(new EventEmitter(),{query:async(sql:string)=>{if(disconnected)throw failure;if(sql==='BEGIN')queueMicrotask(()=>{disconnected=true;client.emit('error',failure)});return{}},release:(error?:Error)=>{released=error}})
  t.mock.method(databasePool,'connect',async()=>client as never)
  await assert.rejects(publishOperationsSnapshot({role:'api',ready:()=>true,nodeId}),error=>error===failure)
  assert.equal(released,failure);assert.equal(client.listenerCount('error'),0)
 })
 it('protects private admin transactions against the same connection-loss race and preserves the original failure',async t=>{
  const failure=Object.assign(new Error('private-admin-connection'),{code:'ECONNRESET'});let disconnected=false,released:Error|undefined
  const client=Object.assign(new EventEmitter(),{query:async(sql:string)=>{if(disconnected)throw failure;if(sql==='BEGIN')queueMicrotask(()=>{disconnected=true;client.emit('error',failure)});return{}},release:(error?:Error)=>{released=error}})
  t.mock.method(adminPool(),'connect',async()=>client as never)
  await assert.rejects(adminTransaction(db=>db.query('SELECT 1')),error=>error===failure)
  assert.equal(released,failure);assert.equal(client.listenerCount('error'),0)
 })
 it('marks a production API without its required file service as unconfigured while allowing isolated report workers',()=>{
  const mode=process.env.NODE_ENV,socket=process.env.FILE_PROCESSOR_SOCKET
  try{process.env.NODE_ENV='production';delete process.env.FILE_PROCESSOR_SOCKET;assert.equal(runtimeConfiguration('api').fileProcessing,'unconfigured');assert.equal(runtimeConfiguration('worker').fileProcessing,'process');process.env.FILE_PROCESSOR_SOCKET='/private/test-only.sock';assert.equal(runtimeConfiguration('api').fileProcessing,'service')}
  finally{if(mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=mode;if(socket===undefined)delete process.env.FILE_PROCESSOR_SOCKET;else process.env.FILE_PROCESSOR_SOCKET=socket}
 })
 it('keeps the request-error buffer bounded and drops sensitive route strings and unknown codes',async()=>{
  const nodeId=randomUUID();operationNodes.push(nodeId)
  for(let i=0;i<4;i++)await publishOperationsSnapshot({role:'api',ready:()=>true,nodeId})
  const marker='sensitive-token-'+randomUUID(),request={method:'POST',route:{path:'/api?secret='+marker}} as express.Request
  const ids=Array.from({length:250},()=>randomUUID());for(const id of ids)captureRequestFailure(Object.assign(new Error(marker),{code:marker}),request,500,id)
  for(let i=0;i<4;i++)await publishOperationsSnapshot({role:'api',ready:()=>true,nodeId})
  const rows=await prisma.platformRequestError.findMany({where:{nodeId:runtimeNodeId,route:'unmatched',id:{in:ids}}});assert.equal(rows.length,200);assert(rows.every(r=>r.code===null));assert(!JSON.stringify(rows).includes(marker))
  const node=await prisma.platformRuntimeNode.findUniqueOrThrow({where:{id:nodeId}});assert((node.snapshot as {droppedErrors:number}).droppedErrors>=50)
 })
 it('identifies a missing monitoring cleanup function without leaking SQL or provider messages',async()=>{
  const db=await databasePool.connect()
  try{
   await db.query('BEGIN');await db.query('DROP FUNCTION public.platform_cleanup_operations()')
   await assert.rejects(collectMonitoringCycle(()=>true,true,sql=>db.query(sql)),error=>{
    assert.deepEqual(safeError(error),{name:'Error',code:'42883',operation:'MONITOR_CLEANUP_OPERATIONS'});assert(!JSON.stringify(safeError(error)).includes('public.'));return true
   })
  }finally{await db.query('ROLLBACK');db.release()}
 })
 it('finishes the current monitoring query and skips cleanup after shutdown starts',async()=>{
  let active=true,finish!:()=>void;const queries:string[]=[]
  const running=collectMonitoringCycle(()=>active,true,async sql=>{queries.push(sql);await new Promise<void>(resolve=>{finish=resolve})})
  assert.equal(queries.length,1);active=false;finish();assert.equal(await running,false);assert.equal(queries.length,1)
 })
 it('runs complete monitoring cleanup and samples without cleanup between hourly sweeps',async()=>{
  const queries:string[]=[];const query=async(sql:string)=>{queries.push(sql)}
  assert.equal(await collectMonitoringCycle(()=>true,true,query),true);assert.equal(queries.length,6)
  queries.length=0;assert.equal(await collectMonitoringCycle(()=>true,false,query),false);assert.equal(queries.length,1)
 })
 it('shows PIN attempts from the server and shares limits across page reloads',async()=>{
  const browser=await account();await browser.ready();await browser.request('/api/admin/lock',{})
  assert.equal((await browser.request('/api/admin/unlock',{pin:'111222'})).status,400)
  const state=await(await browser.request('/api/admin/access')).json();assert.equal(state.state,'locked');assert.equal(state.attemptsRemaining,4)
  assert.equal((await browser.request('/api/admin/monitoring/events')).status,423)
 })
 it('records business changes transactionally without payloads and searches the full journal',async()=>{
  const browser=await account();await browser.ready();const org=await createBusinessOrganization(browser.userId,{name:'Журнал '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const marker='private-description-'+randomUUID()
  await prisma.organization.update({where:{id:org.id},data:{description:marker}})
  const before=await prisma.platformOperationEvent.count({where:{organizationId:org.id}})
  await assert.rejects(prisma.$transaction(async tx=>{await tx.organization.update({where:{id:org.id},data:{name:'Rolled back'}});throw new Error('rollback')}))
  assert.equal(await prisma.platformOperationEvent.count({where:{organizationId:org.id}}),before)
  await prisma.securityEvent.createMany({data:Array.from({length:25},()=>({organizationId:org.id,userId:browser.userId,action:'LOGIN',outcome:'SUCCEEDED',correlationId:randomUUID()}))})
  const result=await(await browser.request('/api/admin/monitoring/events?organizationId='+org.id+'&search='+encodeURIComponent('Вход в аккаунт'))).json()
  assert.equal(result.total,25);assert.equal(result.items.length,20);assert.equal(result.items[0].label,'Вход в аккаунт')
  const next=await(await browser.request('/api/admin/monitoring/events?organizationId='+org.id+'&search=LOGIN&page=2')).json();assert.equal(next.items.length,5)
  const changes=await(await browser.request('/api/admin/monitoring/events?organizationId='+org.id+'&module=organization')).json();assert(changes.items.some((row:{action:string})=>row.action==='organization_UPDATE'))
  assert(!JSON.stringify(changes).includes(marker));assert(!JSON.stringify(changes).includes(browser.email))
  assert.equal((await browser.request('/api/admin/monitoring/events?organizationId=bad')).status,400)
  const ordinary=await account(false);assert.equal((await ordinary.request('/api/admin/monitoring/events?organizationId='+org.id)).status,403)
 })
 it('offers long periods and cumulative creation counts without fabricating old online observations',async()=>{
  const browser=await account();await browser.ready()
  const get=async(days:number)=>{const response=await browser.request('/api/admin/monitoring/analytics?days='+days);assert.equal(response.status,200);return response.json()}
  const before=await get(0),org=await createBusinessOrganization(browser.userId,{name:'Lifetime '+suffix,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const after=await get(365);assert.equal(after.lifetime.organizations,before.lifetime.organizations+1);assert(Array.isArray(after.registrations))
  await prisma.organization.update({where:{id:org.id},data:{deletedAt:new Date()}});assert.equal((await get(90)).lifetime.organizations,after.lifetime.organizations)
  assert.equal((await browser.request('/api/admin/monitoring/analytics?days=999999')).status,400)
  assert.equal((await browser.request('/api/admin/monitoring/overview?days=0')).status,200)
 })
 it('does not expose administrator availability or monitoring to an unauthenticated caller',async()=>{
  const browser=new Browser();assert.equal((await browser.request('/api/admin/access')).status,401);assert.equal((await browser.request('/api/admin/monitoring/overview')).status,401)
 })
 it('keeps an ordinary user outside the panel even with forged body fields or a made-up cookie',async()=>{
  const browser=await account(false);assert.equal((await(await browser.request('/api/admin/access')).json()).eligible,false)
  browser.cookies.set('staffly_admin','a'.repeat(43));assert.equal((await browser.request('/api/admin/monitoring/overview')).status,403)
  assert.equal((await browser.request('/api/admin/challenge',{password,purpose:'LOGIN',isAdmin:true})).status,400)
  assert.equal((await browser.request('/api/admin/grant',{userId:browser.userId})).status,404)
 })
 it('requires password, email confirmation, then first-time PIN setup before exposing data',async()=>{
  const browser=await account();assert.equal((await(await browser.request('/api/admin/access')).json()).state,'authenticate')
  assert.equal((await browser.request('/api/admin/challenge',{password:'wrong',purpose:'LOGIN'})).status,400)
  const state=await browser.elevate();assert.equal(state.state,'setup-pin')
  assert.equal((await browser.request('/api/admin/monitoring/overview')).status,423)
  assert.equal((await browser.request('/api/admin/pin',{pin:'123456',confirmPin:'123456'})).status,400)
  assert.equal((await browser.request('/api/admin/pin',{pin,confirmPin:'123457'})).status,400)
  assert.equal((await browser.request('/api/admin/pin',{pin,confirmPin:pin})).status,200)
  assert.equal((await browser.request('/api/admin/monitoring/overview')).status,200)
  const {rows:[credential]}=await databasePool.query('SELECT pin_hash FROM staffly_admin.credentials WHERE user_id=$1',[browser.userId]);assert.match(credential.pin_hash,/^\$argon2id\$/);assert.ok(!credential.pin_hash.includes(pin))
 })
 it('binds confirmation to the authenticated session and an independent HttpOnly browser cookie',async()=>{
  const browser=await account(),challenge=await browser.challenge(),stolen=new Browser();stolen.token=browser.token
  assert.equal((await stolen.request('/api/admin/verify',{challengeId:challenge.challengeId,code:codes.get(browser.email)})).status,400)
  const response=await browser.request('/api/admin/verify',{challengeId:challenge.challengeId,code:codes.get(browser.email)});assert.equal(response.status,200)
  const cookie=response.headers.getSetCookie().find(c=>c.startsWith('staffly_admin='));assert(cookie);assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Strict/i);assert.match(cookie,/Path=\//)
  const {rows:[stored]}=await databasePool.query('SELECT token_hash FROM staffly_admin.sessions WHERE user_id=$1',[browser.userId]);assert.notEqual(stored.token_hash,browser.cookies.get('staffly_admin'))
 })
 it('consumes an email code once under parallel verification',async()=>{
  const browser=await account(),challenge=await browser.challenge(),body={challengeId:challenge.challengeId,code:codes.get(browser.email)}
  const responses=await Promise.all([browser.request('/api/admin/verify',body),browser.request('/api/admin/verify',body)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,400])
 })
 it('persists five incorrect email attempts and rejects the correct code afterwards',async()=>{
  const browser=await account(),challenge=await browser.challenge(),wrong=codes.get(browser.email)==='000000'?'000001':'000000'
  for(let i=0;i<5;i++)assert.equal((await browser.request('/api/admin/verify',{challengeId:challenge.challengeId,code:wrong})).status,400)
  assert.equal((await browser.request('/api/admin/verify',{challengeId:challenge.challengeId,code:codes.get(browser.email)})).status,400)
  const {rows:[stored]}=await databasePool.query('SELECT attempts,used_at FROM staffly_admin.challenges WHERE id=$1',[challenge.challengeId]);assert.equal(stored.attempts,5);assert(stored.used_at)
 })
 it('rejects expired email confirmation and cross-origin or missing-origin mutations',async()=>{
  const browser=await account(),challenge=await browser.challenge();await databasePool.query("UPDATE staffly_admin.challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[challenge.challengeId])
  assert.equal((await browser.request('/api/admin/verify',{challengeId:challenge.challengeId,code:codes.get(browser.email)})).status,400)
  assert.equal((await browser.request('/api/admin/challenge',{password},{Origin:'https://evil.test'})).status,403)
  assert.equal((await browser.request('/api/admin/challenge',{password},{Origin:''})).status,403)
 })
 it('locks server reads after inactivity, does not extend idle time with polling and cannot revive by activity',async()=>{
  const browser=await(await account()).ready();await expireIdle(browser)
  assert.equal((await browser.request('/api/admin/monitoring/overview')).status,423)
  assert.equal((await(await browser.request('/api/admin/access')).json()).state,'locked')
  assert.equal((await browser.request('/api/admin/activity',{})).status,423)
  assert.equal((await browser.request('/api/admin/unlock',{pin})).status,200)
  assert.equal((await browser.request('/api/admin/monitoring/overview')).status,200)
  const {rows:[before]}=await databasePool.query('SELECT activity_at FROM staffly_admin.sessions WHERE user_id=$1 AND revoked_at IS NULL',[browser.userId]);await browser.request('/api/admin/monitoring/overview');const {rows:[after]}=await databasePool.query('SELECT activity_at FROM staffly_admin.sessions WHERE user_id=$1 AND revoked_at IS NULL',[browser.userId]);assert.equal(+before.activity_at,+after.activity_at)
 })
 it('revokes the elevated session after five incorrect PINs and rejects the correct PIN',async()=>{
  const browser=await(await account()).ready();await browser.request('/api/admin/lock',{})
  for(let i=0;i<5;i++)assert.equal((await browser.request('/api/admin/unlock',{pin:'194826'})).status,i===4?403:400)
  assert.equal((await browser.request('/api/admin/unlock',{pin})).status,403)
  assert.equal((await(await browser.request('/api/admin/access')).json()).state,'authenticate')
 })
 it('enforces absolute expiry even when PIN and ordinary login remain valid',async()=>{
  const browser=await(await account()).ready();await databasePool.query("UPDATE staffly_admin.sessions SET created_at=now()-interval '5 hours',expires_at=now()-interval '1 hour' WHERE user_id=$1",[browser.userId]);assert.equal((await browser.request('/api/admin/monitoring/overview')).status,403);assert.equal((await browser.request('/api/admin/unlock',{pin})).status,403)
 })
 it('immediately respects grant revocation and cannot reuse old elevation after regrant',async()=>{
  const browser=await(await account()).ready();await databasePool.query('UPDATE staffly_admin.accounts SET enabled=false,version=version+1 WHERE user_id=$1',[browser.userId]);assert.equal((await browser.request('/api/admin/monitoring/overview')).status,403)
  await databasePool.query('UPDATE staffly_admin.accounts SET enabled=true,version=version+1 WHERE user_id=$1',[browser.userId]);assert.equal((await browser.request('/api/admin/monitoring/overview')).status,403)
 })
 it('invalidates elevation on account security changes and ordinary-session revocation',async()=>{
  const browser=await(await account()).ready();await prisma.user.update({where:{id:browser.userId},data:{securityVersion:{increment:1}}});assert.equal((await browser.request('/api/admin/monitoring/overview')).status,403)
  const other=await(await account()).ready();await prisma.authSession.updateMany({where:{userId:other.userId},data:{revokedAt:new Date()}});assert.equal((await other.request('/api/admin/monitoring/overview')).status,401)
 })
 it('resets PIN only after password and a fresh email challenge, then closes all elevated sessions',async()=>{
  const browser=await(await account()).ready();await databasePool.query("UPDATE staffly_admin.challenges SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[browser.userId])
  const challenge=await browser.challenge('RESET_PIN'),newPin='739482'
  assert.equal((await browser.request('/api/admin/verify',{challengeId:challenge.challengeId,code:codes.get(browser.email)})).status,400)
  const response=await browser.request('/api/admin/verify',{challengeId:challenge.challengeId,code:codes.get(browser.email),newPin,confirmPin:newPin});assert.equal(response.status,200);assert.equal((await response.json()).reset,true)
  assert.equal((await browser.request('/api/admin/monitoring/overview')).status,403)
  const {rows:[row]}=await databasePool.query('SELECT count(*)::int AS count FROM staffly_admin.sessions WHERE user_id=$1 AND revoked_at IS NULL',[browser.userId]);assert.equal(row.count,0)
 })
 it('ends only the elevated session on explicit admin logout',async()=>{
  const browser=await(await account()).ready();assert.equal((await browser.request('/api/admin/logout',{})).status,200);assert.equal((await browser.request('/api/admin/monitoring/overview')).status,403);assert.equal((await browser.request('/api/auth/me')).status,200)
 })
 it('returns actual tenant metadata, stable pagination, effective plans and safe masked users',async()=>{
  const browser=await(await account()).ready(),org=await createBusinessOrganization(browser.userId,{name:`Admin monitoring ${suffix}`,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const response=await browser.request('/api/admin/monitoring/organizations?search='+encodeURIComponent('Admin monitoring '+suffix));assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.total,1);assert.equal(result.items[0].id,org.id);assert.equal(result.items[0].members,1)
  const detail=await browser.request('/api/admin/monitoring/organizations/'+org.id);assert.equal(detail.status,200);assert.equal((await detail.json()).ownerName,'Мониторинга Тест')
  const user=await(await browser.request('/api/admin/monitoring/users/'+browser.userId)).json();assert.match(user.email,/•••@/);for(const field of ['passwordHash','refreshTokenHash','ipAddress','userAgent','phone','bio'])assert.equal(field in user,false)
  assert.equal((await browser.request('/api/admin/monitoring/organizations?search='+encodeURIComponent("' OR true --"))).status,200)
  assert.equal((await browser.request('/api/admin/monitoring/organizations?page=0')).status,400)
  assert.equal((await browser.request('/api/admin/monitoring/organizations/'+randomUUID())).status,404)
 })
 it('attributes organization online only to a visible authorized organization and removes departed memberships',async()=>{
  const browser=await(await account()).ready(),other=await account(false)
  const one=await createBusinessOrganization(browser.userId,{name:`Online A ${suffix}`,description:null,timezone:'Europe/Moscow'}),two=await createBusinessOrganization(browser.userId,{name:`Online B ${suffix}`,description:null,timezone:'Europe/Moscow'});organizations.push(one.id,two.id)
  const session=await prisma.authSession.findFirstOrThrow({where:{userId:browser.userId,revokedAt:null}})
  await recordOrganizationPresence(browser.userId,session.id,one.id)
  const a=await(await browser.request('/api/admin/monitoring/organizations/'+one.id)).json(),b=await(await browser.request('/api/admin/monitoring/organizations/'+two.id)).json();assert.equal(a.online,1);assert.equal(b.online,0)
  const stranger=await prisma.authSession.findFirstOrThrow({where:{userId:other.userId,revokedAt:null}});await recordOrganizationPresence(other.userId,stranger.id,one.id)
  assert.equal((await(await browser.request('/api/admin/monitoring/organizations/'+one.id)).json()).online,1)
  await prisma.organizationMember.update({where:{organizationId_userId:{organizationId:one.id,userId:browser.userId}},data:{leftAt:new Date()}})
  assert.equal((await(await browser.request('/api/admin/monitoring/organizations/'+one.id)).json()).online,0)
 })
 it('collects real samples and daily analytics without backfilling historical activity',async()=>{
  const browser=await(await account()).ready(),org=await createBusinessOrganization(browser.userId,{name:`Analytics ${suffix}`,description:null,timezone:'Europe/Moscow'});organizations.push(org.id)
  const session=await prisma.authSession.findFirstOrThrow({where:{userId:browser.userId,revokedAt:null}});await recordOrganizationPresence(browser.userId,session.id,org.id);await recordFeature(org.id,'documents');await collectMonitoringSample()
  for(const route of ['/overview','/online','/analytics?days=30']){const response=await browser.request('/api/admin/monitoring'+route);assert.equal(response.status,200,await response.clone().text());const data=await response.json();assert(data.startedAt);assert(!JSON.stringify(data).includes(pin));assert.match(response.headers.get('cache-control')??'',/no-store/)}
  const data=await(await browser.request('/api/admin/monitoring/analytics?days=30')).json();assert(data.features.some((f:{feature:string;organizations:number})=>f.feature==='documents'&&f.organizations>=1));assert(data.daily.length>=1)
 })
 it('writes a minimal journal without passwords, PIN, mail codes, email addresses or arbitrary request data',async()=>{
  const browser=await(await account()).ready();await browser.request('/api/admin/monitoring/overview')
  const {rows}=await databasePool.query('SELECT * FROM staffly_admin.audit_events WHERE user_id=$1',[browser.userId]);assert(rows.some(r=>r.action==='MONITOR_VIEWED'));const text=JSON.stringify(rows);for(const value of [password,pin,browser.email,codes.get(browser.email)!])assert.ok(!text.includes(value))
 })
 it('keeps private grants, PIN hashes and journal mutations inaccessible to a public-data runtime role',async()=>{
  const role='admin_boundary_'+randomUUID().replaceAll('-',''),db=await databasePool.connect()
  try{await db.query(`CREATE ROLE ${role} NOLOGIN`);await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);await db.query(`SET ROLE ${role}`)
   for(const sql of ['SELECT * FROM staffly_admin.accounts','SELECT * FROM staffly_admin.credentials','DELETE FROM staffly_admin.audit_events','TRUNCATE staffly_admin.audit_events'])await assert.rejects(db.query(sql),(e:{code:string})=>e.code==='42501')
  }finally{await db.query('RESET ROLE');await db.query(`DROP OWNED BY ${role}`);await db.query(`DROP ROLE ${role}`);db.release()}
 })
 it('grants and revokes a specific existing account through the operator CLI',async()=>{
  const browser=await account(false),run=promisify(execFile)
  const options={env:{...process.env,NODE_ENV:'test',ADMIN_MANAGEMENT_DATABASE_URL:process.env.DATABASE_URL!}}
  await run(process.execPath,['--import','tsx','scripts/admin-access.ts','grant','--user-id='+browser.userId],options)
  assert.equal((await(await browser.request('/api/admin/access')).json()).eligible,true)
  await run(process.execPath,['--import','tsx','scripts/admin-access.ts','revoke','--user-id='+browser.userId],options)
  assert.equal((await(await browser.request('/api/admin/access')).json()).eligible,false)
 })
 it('does not transfer administrator rights to a new account using the old email',async()=>{
  const browser=await(await account()).ready(),oldEmail=browser.email
  await prisma.user.update({where:{id:browser.userId},data:{email:'moved-'+oldEmail,securityVersion:{increment:1}}})
  assert.equal((await browser.request('/api/admin/monitoring/overview')).status,403)
  const replacement=await prisma.user.create({data:{email:oldEmail,passwordHash:hash,emailVerifiedAt:new Date()}});users.push(replacement.id)
  const other=new Browser();other.email=oldEmail;await other.signIn();assert.equal((await(await other.request('/api/admin/access')).json()).eligible,false)
 })
 it('expires an abandoned first-time PIN setup instead of leaving a four-hour setup grant',async()=>{
  const browser=await account();await browser.elevate()
  await databasePool.query("UPDATE staffly_admin.sessions SET created_at=now()-interval '12 minutes',expires_at=now()+interval '3 hours' WHERE user_id=$1",[browser.userId])
  assert.equal((await browser.request('/api/admin/pin',{pin,confirmPin:pin})).status,403)
 })
 managementScenarios({account,db:databasePool,codes,password})
 it('operates with the production gateway role without grant/DDL/journal-erasure privileges and uses Secure Host cookies',async()=>{
  const saved=Object.fromEntries(['NODE_ENV','ADMIN_DATABASE_URL','ADMIN_AUTH_SECRET'].map(key=>[key,process.env[key]]))
  const browser=await account(),client=await databasePool.connect()
  try{
   await client.query('CREATE ROLE staffly_admin_gateway LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS')
   await client.query(await readFile('deploy/admin-grants.sql','utf8'))
   await closeAdminDatabase()
   const url=new URL(process.env.DATABASE_URL!);url.username='staffly_admin_gateway'
   process.env.ADMIN_DATABASE_URL=url.toString();process.env.ADMIN_AUTH_SECRET=randomUUID()+randomUUID();process.env.NODE_ENV='production'
   await browser.ready()
   assert.equal((await browser.request('/api/admin/monitoring/overview')).status,200)
   for(const endpoint of ['security','administrators','backups','alerts'])assert.equal((await browser.request('/api/admin/management/'+endpoint)).status,200)
   const recipient=await account(false),candidate=await browser.request('/api/admin/management/administrators/candidate?search='+recipient.userId).then(r=>r.json())
   const confirmation=await browser.request('/api/admin/management/actions',{password,spec:{action:'ACCESS_GRANT',targetId:recipient.userId,payload:{version:0,userVersion:candidate.userVersion}}});assert.equal(confirmation.status,200,await confirmation.clone().text());const ticket=await confirmation.json()
   assert.equal((await browser.request('/api/admin/management/actions/execute',{challengeId:ticket.challengeId,code:codes.get(browser.email),confirm:true})).status,200)
   assert.equal((await browser.request('/api/admin/monitoring/users/'+recipient.userId).then(r=>r.json())).platformAdmin,'active')
   const actionHostCookie=browser.receivedCookies.find(c=>c.startsWith('__Host-staffly_admin_action=')&&!c.startsWith('__Host-staffly_admin_action=;'));assert(actionHostCookie);assert.match(actionHostCookie,/Secure/);assert.match(actionHostCookie,/HttpOnly/);assert.match(actionHostCookie,/SameSite=Strict/)
   await browser.request('/api/admin/lock',{})
   const response=await browser.request('/api/admin/unlock',{pin});assert.equal(response.status,200)
   assert(browser.cookies.has('__Host-staffly_admin'))
   const hostCookie=browser.receivedCookies.find(c=>c.startsWith('__Host-staffly_admin='));assert(hostCookie);assert.match(hostCookie,/Secure/);assert.match(hostCookie,/HttpOnly/);assert.match(hostCookie,/SameSite=Strict/);assert.ok(!/Domain=/i.test(hostCookie))
   const challenge=await databasePool.query('SELECT expires_at-created_at AS ttl FROM staffly_admin.sessions WHERE user_id=$1',[browser.userId]);assert(challenge.rowCount)
   await client.query('SET ROLE staffly_admin_gateway')
   for(const sql of ["UPDATE staffly_admin.accounts SET enabled=true",'DELETE FROM staffly_admin.audit_events','TRUNCATE staffly_admin.audit_events','CREATE TABLE public.admin_should_fail(id int)'])await assert.rejects(client.query(sql),(e:{code:string})=>e.code==='42501')
  }finally{
   await client.query('RESET ROLE');await closeAdminDatabase();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}
   await client.query('DROP OWNED BY staffly_admin_gateway');await client.query('DROP ROLE staffly_admin_gateway');client.release()
  }
 })

})
