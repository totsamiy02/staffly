import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { runBackupMaintenance } from '../../src/server/admin/management/backup-runner.ts'
import { checkDatabaseRestore } from '../../scripts/database-restore-check.ts'
type Browser={userId:string;email:string;cookies:Map<string,string>;ready:()=>Promise<unknown>;request:(path:string,body?:unknown,extra?:Record<string,string>)=>Promise<Response>}
export function managementScenarios({account,db,codes,password}:{account:(admin?:boolean)=>Promise<Browser>;db:Pool;codes:Map<string,string>;password:string}){
 const root='/api/admin/management'
 async function begin(browser:Browser,spec:unknown){const response=await browser.request(root+'/actions',{spec,password});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return response.json()}
 async function execute(browser:Browser,id:string,code=codes.get(browser.email)){const response=await browser.request(root+'/actions/execute',{challengeId:id,code,confirm:true});return response}
 async function target(browser:Browser,id:string){const response=await browser.request(root+'/administrators/candidate?search='+id);assert.equal(response.status,200);return response.json()}
 async function age(browser:Browser){await db.query("UPDATE staffly_admin.action_challenges SET created_at=now()-interval '2 minutes',expires_at=now()+interval '1 minute' WHERE user_id=$1",[browser.userId])}
 it('exposes immutable sequential account numbers and resolves them without granting ordinary access',async()=>{
  const admin=await account(),first=await account(false),second=await account(false);await admin.ready()
  const one=await first.request('/api/auth/me').then(r=>r.json()),two=await second.request('/api/auth/me').then(r=>r.json())
  assert(Number.isInteger(one.user.publicId));assert(two.user.publicId>one.user.publicId)
  const found=await target(admin,String(one.user.publicId));assert.equal(found.id,first.userId);assert.equal(found.publicId,one.user.publicId)
  const result=await admin.request('/api/admin/monitoring/users?search='+one.user.publicId).then(r=>r.json());assert.equal(result.total,1);assert.equal(result.items[0].id,first.userId)
  await assert.rejects(db.query('UPDATE public.users SET public_id=public_id+100000 WHERE id=$1',[first.userId]),(error:{code:string})=>error.code==='23514')
  assert.equal((await first.request(root+'/administrators/candidate?search='+two.user.publicId)).status,403)
 })
 it('recovers a committed action result without replaying the code and scopes receipts to the elevated session',async()=>{
  const browser=await account(),recipient=await account(false),other=await account();await browser.ready();await other.ready()
  const person=await target(browser,recipient.userId),spec={action:'ACCESS_GRANT',targetId:recipient.userId,payload:{version:person.version,userVersion:person.userVersion}}
  const challenge=await begin(browser,spec),url=root+'/actions/'+challenge.challengeId
  const pending=await browser.request(url).then(r=>r.json());assert.equal(pending.state,'pending');assert.equal(pending.resourceId,null)
  assert.equal((await other.request(url)).status,404)
  const completed=await execute(browser,challenge.challengeId);assert.equal(completed.status,200)
  const result=await browser.request(url).then(r=>r.json());assert.equal(result.state,'completed');assert.equal(result.resourceId,recipient.userId);assert(result.completedAt)
  assert.doesNotMatch(JSON.stringify(result),/code_hash|browser_hash|payload|token_hash/)
  assert.equal((await execute(browser,challenge.challengeId)).status,409)
  assert.equal((await browser.request(url).then(r=>r.json())).state,'completed')
  await browser.request('/api/admin/lock',{});assert.equal((await browser.request(url)).status,423)
 })
 it('separates expired archives in filters and alert severity without changing global summaries',async()=>{
  const browser=await account();await browser.ready();const id=randomUUID()
  await db.query("INSERT INTO staffly_admin.backups(id,file_key,size_bytes,sha256,created_at,expires_at,verified_at,file_state) VALUES($1,$2,1,$3,now()-interval '31 days',now()-interval '1 day',now()-interval '30 days','AVAILABLE')",[id,'staffly-'+id+'.dump','a'.repeat(64)])
  try{
   const expired=await browser.request(root+'/backups?days=0&status=EXPIRED&search='+id).then(r=>r.json());assert.equal(expired.total,1);assert.equal(expired.items[0].state,'EXPIRED')
   assert.equal((await browser.request(root+'/backups?days=0&status=AVAILABLE&search='+id).then(r=>r.json())).total,0)
   assert.equal((await browser.request(root+'/backups/'+id+'/verify',{confirm:true,sha256:'a'.repeat(64)})).status,409)
   const all=await browser.request(root+'/alerts?status=all').then(r=>r.json())
   for(const severity of ['critical','warning']){
    const filtered=await browser.request(root+'/alerts?status=all&severity='+severity).then(r=>r.json())
    assert(filtered.items.every((item:{severity:string})=>item.severity===severity));assert.deepEqual(filtered.summary,all.summary)
   }
   assert.equal((await browser.request(root+'/alerts?severity=invalid')).status,400)
  }finally{await db.query('DELETE FROM staffly_admin.backups WHERE id=$1',[id])}
 })
 it('management denies ordinary users, locked PIN sessions, cross-origin writes and forged payloads',async()=>{
  const ordinary=await account(false);assert.equal((await ordinary.request(root+'/security')).status,403)
  const browser=await account();await browser.ready()
  for(const endpoint of ['security','administrators','backups','alerts']){const response=await browser.request(root+'/'+endpoint);assert.equal(response.status,200,await response.clone().text());assert.doesNotMatch(await response.text(),/token_hash|password_hash|code_hash|file_key|lease_token/)}
  assert.equal((await browser.request(root+'/actions',{password,spec:{action:'ACCESS_GRANT',targetId:ordinary.userId,payload:{version:0,userVersion:0,enabled:true}}})).status,400)
  assert.equal((await browser.request(root+'/actions',{password,spec:{action:'BACKUP_CREATE',payload:{}}},{Origin:'https://evil.example'})).status,403)
  await browser.request('/api/admin/lock',{});assert.equal((await browser.request(root+'/security')).status,423)
 })
 it('grants and revokes access with a bound one-use email challenge and invalidates target sessions',async()=>{
  const browser=await account(),recipient=await account(false);await browser.ready();const person=await target(browser,recipient.userId)
  const spec={action:'ACCESS_GRANT',targetId:recipient.userId,payload:{version:person.version,userVersion:person.userVersion}}
  const challenge=await begin(browser,spec)
  assert.equal((await execute(browser,challenge.challengeId)).status,200)
  assert.equal((await execute(browser,challenge.challengeId)).status,409)
  assert.equal((await recipient.request('/api/admin/access').then(r=>r.json())).eligible,true)
  await recipient.ready();await age(browser)
  const current=await target(browser,recipient.userId),revoke=await begin(browser,{...spec,action:'ACCESS_REVOKE',payload:{version:current.version,userVersion:current.userVersion}})
  assert.equal((await execute(browser,revoke.challengeId)).status,200)
  assert.equal((await recipient.request(root+'/security')).status,403)
  assert.equal((await db.query('SELECT count(*)::int n FROM staffly_admin.sessions WHERE user_id=$1 AND revoked_at IS NULL',[recipient.userId])).rows[0].n,0)
  assert.equal((await db.query("SELECT count(*)::int n FROM staffly_admin.audit_events WHERE user_id=$1 AND action IN ('ACCESS_GRANTED','ACCESS_REVOKED')",[browser.userId])).rows[0].n,2)
 })
 it('rejects a stolen confirmation in another elevated session and stops after five incorrect codes',async()=>{
  const browser=await account(),other=await account(),recipient=await account(false);await browser.ready();await other.ready();const person=await target(browser,recipient.userId)
  const challenge=await begin(browser,{action:'ACCESS_GRANT',targetId:recipient.userId,payload:{version:0,userVersion:person.userVersion}}),correct=codes.get(browser.email)!,wrong=correct==='000000'?'111111':'000000'
  other.cookies.set('staffly_admin_action',browser.cookies.get('staffly_admin_action')!)
  assert.equal((await execute(other,challenge.challengeId,correct)).status,409)
  for(let i=0;i<5;i++){const response=await execute(browser,challenge.challengeId,wrong);assert.equal(response.status,400,await response.clone().text());assert.equal((await response.json()).code,'ADMIN_ACTION_CODE')}
  assert.equal((await execute(browser,challenge.challengeId,correct)).status,409)
  assert.equal((await db.query('SELECT attempts,used_at FROM staffly_admin.action_challenges WHERE id=$1',[challenge.challengeId])).rows[0].attempts,5)
 })
 it('rejects self-revocation, stale target versions, unverified accounts, cancelled and expired challenges',async()=>{
  const browser=await account(),recipient=await account(false);await browser.ready();const self=await target(browser,browser.userId)
  assert.equal((await browser.request(root+'/actions',{password,spec:{action:'ACCESS_REVOKE',targetId:browser.userId,payload:{version:self.version,userVersion:self.userVersion}}})).status,409)
  const person=await target(browser,recipient.userId),spec={action:'ACCESS_GRANT',targetId:recipient.userId,payload:{version:0,userVersion:person.userVersion}}
  const cancelled=await begin(browser,spec);assert.equal((await browser.request(root+'/actions/'+cancelled.challengeId+'/cancel',{})).status,200);assert.equal((await execute(browser,cancelled.challengeId)).status,409)
  await age(browser);const stale=await begin(browser,spec);await db.query('UPDATE public.users SET security_version=security_version+1 WHERE id=$1',[recipient.userId]);assert.equal((await execute(browser,stale.challengeId)).status,409)
  await age(browser);const expired=await begin(browser,{...spec,payload:{version:0,userVersion:person.userVersion+1}});await db.query("UPDATE staffly_admin.action_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.challengeId]);assert.equal((await execute(browser,expired.challengeId)).status,409)
  await db.query('UPDATE public.users SET email_verified_at=NULL WHERE id=$1',[recipient.userId]);assert.equal((await browser.request(root+'/actions',{password,spec:{...spec,payload:{version:0,userVersion:person.userVersion+1}}})).status,409)
 })
 it('edits bounded alert rules only after fresh confirmation and cannot disable mandatory rules',async()=>{
  const browser=await account();await browser.ready();const state=await browser.request(root+'/alerts').then(r=>r.json()),rule=state.rules.find((r:{key:string})=>r.key==='ADMIN_DENIALS')
  const spec={action:'ALERT_RULE',targetId:rule.id,payload:{version:rule.version,enabled:false,threshold:rule.threshold}}
  assert.equal((await browser.request(root+'/actions',{password,spec})).status,409)
  const challenge=await begin(browser,{...spec,payload:{version:rule.version,enabled:true,threshold:11}})
  assert.equal((await execute(browser,challenge.challengeId)).status,200)
  assert.equal((await db.query('SELECT threshold,version FROM staffly_admin.alert_rules WHERE id=$1',[rule.id])).rows[0].threshold,11)
  await db.query('UPDATE staffly_admin.alert_rules SET threshold=10 WHERE id=$1',[rule.id])
 })
 it('opens, acknowledges, resolves and reopens real alert episodes without duplicating active incidents',async()=>{
  const browser=await account();await browser.ready()
  const rule=(await db.query("SELECT * FROM staffly_admin.alert_rules WHERE key='BACKUP_FAILURES'")).rows[0],jobId=randomUUID()
  await db.query("INSERT INTO staffly_admin.backup_jobs(id,kind,requested_by,status,finished_at,error_code) VALUES($1,'CREATE',$2,'FAILED',now(),'BACKUP_FAILED')",[jobId,browser.userId])
  async function collect(){await db.query('UPDATE staffly_admin.management_state SET alerts_checked_at=NULL WHERE id=1');await db.query('SELECT public.platform_reconcile_admin_alerts()')}
  await collect();await collect();const open=(await db.query('SELECT * FROM staffly_admin.alerts WHERE rule_id=$1 AND resolved_at IS NULL',[rule.id])).rows;assert.equal(open.length,1)
  assert.equal((await browser.request(root+'/alerts/'+open[0].id+'/acknowledge',{confirm:true})).status,200)
  assert.equal((await db.query('SELECT resolved_at,acknowledged_at FROM staffly_admin.alerts WHERE id=$1',[open[0].id])).rows[0].resolved_at,null)
  await db.query("UPDATE staffly_admin.backup_jobs SET status='SUCCEEDED' WHERE id=$1",[jobId]);await collect();assert((await db.query('SELECT resolved_at FROM staffly_admin.alerts WHERE id=$1',[open[0].id])).rows[0].resolved_at)
  await db.query("UPDATE staffly_admin.backup_jobs SET status='FAILED' WHERE id=$1",[jobId]);await collect();const next=(await db.query('SELECT id,acknowledged_at FROM staffly_admin.alerts WHERE rule_id=$1 AND resolved_at IS NULL',[rule.id])).rows[0];assert.notEqual(next.id,open[0].id);assert.equal(next.acknowledged_at,null)
  await db.query('DELETE FROM staffly_admin.backup_jobs WHERE id=$1',[jobId])
 })
 it('creates a real private PostgreSQL archive, verifies it and reports tampering to support',async()=>{
  const browser=await account();await browser.ready();const directory=await mkdtemp(path.join(os.tmpdir(),'staffly-management-backup-')),jobId=randomUUID(),url=process.env.DATABASE_URL!
  const options={managementUrl:url,backupUrl:url,directory,pgBin:process.env.PG_BIN||'/Applications/Postgres.app/Contents/Versions/18/bin'}
  // The operator fixture requests a genuine dump; password/email queueing is tested above.
  await db.query("INSERT INTO staffly_admin.backup_jobs(id,kind,requested_by) VALUES($1,'CREATE',$2)",[jobId,browser.userId])
  try{
   const result=await runBackupMaintenance(options);assert.equal(result.status,'succeeded',JSON.stringify(result));const backup=(await db.query('SELECT * FROM staffly_admin.backups WHERE id=$1',[jobId])).rows[0];assert(backup.verified_at);assert(backup.size_bytes>0)
   const file=path.join(directory,backup.file_key),content=await readFile(file);assert.equal(content.subarray(0,5).toString(),'PGDMP')
   const targetName='restore_'+randomUUID().replaceAll('-',''),targetUrl=new URL(url);targetUrl.pathname='/'+targetName
   await db.query('CREATE DATABASE '+targetName)
   try{
    const restored=await checkDatabaseRestore({targetUrl:targetUrl.toString(),directory,backupId:jobId,sha256:backup.sha256,pgBin:options.pgBin});assert.equal(restored.restored,true);assert(restored.users>0);assert(restored.organizations>0)
    await assert.rejects(checkDatabaseRestore({targetUrl:targetUrl.toString(),directory,backupId:jobId,sha256:backup.sha256,pgBin:options.pgBin}),/not empty/)
   }finally{await db.query('DROP DATABASE '+targetName+' WITH (FORCE)')}
   const verify=await browser.request(root+'/backups/'+jobId+'/verify',{confirm:true,sha256:backup.sha256});assert.equal(verify.status,200,await verify.clone().text());assert.equal((await runBackupMaintenance(options)).status,'succeeded')
   await writeFile(file,Buffer.concat([content,Buffer.from('tampered')]),{mode:0o600})
   const badId=randomUUID();await db.query("INSERT INTO staffly_admin.backup_jobs(id,kind,backup_id,requested_by) VALUES($1,'VERIFY',$2,$3)",[badId,jobId,browser.userId])
   assert.equal((await runBackupMaintenance(options)).status,'failed')
   assert.equal((await db.query('SELECT file_state FROM staffly_admin.backups WHERE id=$1',[jobId])).rows[0].file_state,'INVALID')
   const incident=(await db.query('SELECT id,event_code FROM public.platform_request_errors WHERE job_id=$1',[badId])).rows[0];assert.equal(incident.event_code,'BACKUP_CHANGED')
   assert.equal((await browser.request('/api/admin/operations/support?search='+incident.id)).status,200)
  }finally{await db.query('DELETE FROM staffly_admin.backup_jobs WHERE backup_id=$1 OR id=$1',[jobId]);await db.query('DELETE FROM staffly_admin.backups WHERE id=$1',[jobId]);await rm(directory,{recursive:true,force:true})}
 })
 it('all nine alert metrics use real sources and the collector keeps its global interval guard',async()=>{
  const browser=await account(),client=await db.connect()
  try{
   await client.query('BEGIN')
   await client.query('UPDATE staffly_admin.management_state SET started_at=now()-interval \'2 days\',last_api_ok_at=now()-interval \'5 minutes\',last_workers_ok_at=now()-interval \'5 minutes\',alerts_checked_at=NULL')
   await client.query('UPDATE public.platform_runtime_nodes SET stopped_at=now()')
   await client.query("INSERT INTO public.platform_runtime_nodes(id,role,started_at,heartbeat_at,ready,snapshot) VALUES($1,'worker',now(),now(),false,'{\"tasks\":[{\"failures\":4}]}')",[randomUUID()])
   for(let i=0;i<5;i++)await client.query("INSERT INTO public.platform_request_errors(id,node_id,method,route,status,name,source) VALUES($1,$2,'POST','/probe',500,'Error','request')",[randomUUID(),randomUUID()])
   await client.query("INSERT INTO public.email_deliveries(id,user_id,source_key,source_kind,status) VALUES($1,$2,$3,'MANDATORY','FAILED')",[randomUUID(),browser.userId,randomUUID()])
   const org=(await client.query('SELECT id FROM public.organizations LIMIT 1')).rows[0]
   assert(org,'Other monitoring scenarios provide a synthetic organization')
   await client.query("INSERT INTO public.report_exports(id,user_id,organization_id,input,input_hash,status,expires_at) VALUES($1,$2,$3,'{}',$4,'FAILED',now()+interval '1 hour')",[randomUUID(),browser.userId,org.id,'a'.repeat(64)])
   await client.query("UPDATE staffly_admin.backups SET created_at=now()-interval '2 days',expires_at=now()+interval '28 days'")
   for(let i=0;i<12;i++)await client.query("INSERT INTO staffly_admin.audit_events(id,user_id,action,outcome) VALUES($1,$2,'CHALLENGE_DENIED','DENIED')",[randomUUID(),browser.userId])
   await client.query("INSERT INTO staffly_admin.backup_jobs(id,kind,requested_by,status,finished_at) VALUES($1,'CREATE',$2,'FAILED',now())",[randomUUID(),browser.userId])
   await client.query('SELECT public.platform_reconcile_admin_alerts()')
   const active=(await client.query('SELECT r.key FROM staffly_admin.alerts a JOIN staffly_admin.alert_rules r ON r.id=a.rule_id WHERE a.resolved_at IS NULL')).rows.map(row=>row.key)
   for(const key of ['API_UNAVAILABLE','WORKERS_UNAVAILABLE','API_ERRORS','EMAIL_FAILURES','REPORT_FAILURES','BACKUP_STALE','ADMIN_DENIALS','BACKGROUND_FAILURES','BACKUP_FAILURES'])assert(active.includes(key),key+' must open from its real metric')
   const metrics=(await client.query('SELECT key,measured,threshold,checked_at FROM staffly_admin.alert_rules')).rows
   assert.equal(metrics.length,9);for(const metric of metrics){assert(metric.checked_at);assert(metric.measured>=metric.threshold,metric.key+' publishes the same measurement used to trigger the alert')}
   const before=(await client.query('SELECT alerts_checked_at FROM staffly_admin.management_state')).rows[0].alerts_checked_at
   await client.query('SELECT public.platform_reconcile_admin_alerts()');assert.equal(+(await client.query('SELECT alerts_checked_at FROM staffly_admin.management_state')).rows[0].alerts_checked_at,+before)
  }finally{await client.query('ROLLBACK');client.release()}
 })
}
