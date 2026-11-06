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
import { closeAdminDatabase } from '../../src/server/admin/database.ts'
import { collectMonitoringSample, collectMonitoringCycle, recordOrganizationPresence, recordFeature } from '../../src/server/admin/collection.ts'
import { safeError } from '../../src/server/security/safe-error.ts'
import { ApiError } from '../../src/server/api-error.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'

const suffix=randomUUID(),password='StafflyAdminTesting-72!',pin='628491',users:string[]=[],organizations:string[]=[],codes=new Map<string,string>()
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
  const app=express();app.use(express.json({limit:'16kb'}));app.use(cookieParser());app.use('/api/auth',authRouter);app.use('/api/admin',createAdminRouter({sendCode:async(email,code)=>{codes.set(email,code)}}));app.use('/api',profileRouter)
  app.use((error:unknown,_request:express.Request,response:express.Response,_next:express.NextFunction)=>{response.status(error instanceof ApiError?error.status:error instanceof ZodError?400:500).json({code:error instanceof ApiError?error.code:'INTERNAL_ERROR',message:error instanceof ApiError?error.message:'Не удалось выполнить действие.'})})
  server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}`
 })
 after(async()=>{
  await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections()})
  for(const id of organizations)await prisma.organization.update({where:{id},data:{deletedAt:new Date()}})
  await prisma.authSession.deleteMany({where:{userId:{in:users}}})
  await databasePool.query('DELETE FROM staffly_admin.accounts WHERE user_id=ANY($1::uuid[])',[users])
  await databasePool.query('DELETE FROM staffly_admin.audit_events WHERE user_id=ANY($1::uuid[])',[users])
  await closeAdminDatabase();await prisma.$disconnect()
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
