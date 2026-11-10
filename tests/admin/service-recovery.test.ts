import assert from 'node:assert/strict'
import { before,after,it } from 'node:test'
import { createHash,randomUUID } from 'node:crypto'
import { mkdtemp,mkdir,rm,writeFile,readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { SignalMessage } from '../../src/server/admin/service/external-probe.ts'
import { Pool } from 'pg'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
// This suite needs a complete synthetic object store. Give it its own migrated
// database so unrelated fixtures from the full regression run cannot enter a set.
assert.equal(process.env.ISOLATED_TEST_CLUSTER,'true')
const sourceRoot=await mkdtemp(path.join(os.tmpdir(),'service-source-cluster-')),binaryDirectory=process.env.PG_BIN||'/Applications/Postgres.app/Contents/Versions/18/bin',command=promisify(execFile)
const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()))
await command(path.join(binaryDirectory,'initdb'),['-D',path.join(sourceRoot,'pg'),'-U','service_test','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=en_US.UTF-8'])
await command(path.join(binaryDirectory,'pg_ctl'),['-D',path.join(sourceRoot,'pg'),'-l',path.join(sourceRoot,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c unix_socket_directories='' -c timezone=UTC`,'-w','start'])
const isolatedUrl=new URL(`postgresql://service_test@127.0.0.1:${port}/staffly_test`),control=new Pool({connectionString:isolatedUrl.toString().replace('/staffly_test','/postgres'),max:1})
await control.query('CREATE DATABASE staffly_test')
const config=path.join(sourceRoot,'prisma.config.mjs')
try{
 await writeFile(config,'export default '+JSON.stringify({schema:path.resolve('prisma/schema.prisma'),migrations:{path:path.resolve('prisma/migrations')},datasource:{url:isolatedUrl.toString()}}))
 await command(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--config',config],{env:{...process.env,PRISMA_ENV_FILE:'/dev/null'},maxBuffer:4*1024*1024})
}catch(error){await control.end();await command(path.join(binaryDirectory,'pg_ctl'),['-D',path.join(sourceRoot,'pg'),'-m','fast','-w','stop']);await rm(sourceRoot,{recursive:true,force:true});throw error}
process.env.DATABASE_URL=isolatedUrl.toString();process.env.ADMIN_DATABASE_URL=isolatedUrl.toString()
const {backupSetState}=await import('../../src/server/admin/service/read-model.ts')
const {closeAdminDatabase}=await import('../../src/server/admin/database.ts')
const {prisma,databasePool}=await import('../../src/server/db.ts')
const {createBusinessOrganization}=await import('../support/business-organization.ts')
const {runBackupMaintenance}=await import('../../src/server/admin/management/backup-runner.ts')
const {exportDeletionLedger}=await import('../../src/server/admin/service/backup-components.ts')
const {runRestoreRehearsal}=await import('../../src/server/admin/service/restore-runner.ts')
const {runExternalProbe}=await import('../../src/server/admin/service/external-probe.ts')
let root:string,userId:string,deletedId:string,orgId:string,fileId:string,backupId:string
const bytes=Buffer.from('Synthetic private document bytes for a restore test.'),sha=createHash('sha256').update(bytes).digest('hex'),source=process.env.DATABASE_URL!,pgBin=process.env.PG_BIN||'/Applications/Postgres.app/Contents/Versions/18/bin'
const directories=()=>({directory:path.join(root,'database'),filesDirectory:path.join(root,'files'),ledgerDirectory:path.join(root,'independent-ledger')})
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'service-full-recovery-'));for(const directory of Object.values(directories()))await mkdir(directory,{mode:0o700})
 userId=(await prisma.user.create({data:{email:'restore-'+randomUUID()+'@example.test',emailVerifiedAt:new Date()}})).id;deletedId=(await prisma.user.create({data:{email:'restore-deleted-'+randomUUID()+'@example.test',emailVerifiedAt:new Date()}})).id
 orgId=(await createBusinessOrganization(userId,{name:'Restore rehearsal organization',description:null,timezone:'Europe/Moscow'})).id
 fileId=(await prisma.storedFile.create({data:{objectKey:'documents/'+randomUUID()+'.pdf',mimeType:'application/pdf',size:bytes.length,checksumSha256:sha,purpose:'DOCUMENT',uploadedByUserId:userId,organizationId:orgId}})).id
 backupId=randomUUID();await databasePool.query("INSERT INTO staffly_admin.backup_jobs(id,kind,requested_by) VALUES($1,'CREATE',$2)",[backupId,userId])
})
after(async()=>{
 try{if(root)await rm(root,{recursive:true,force:true});await closeAdminDatabase();await prisma.$disconnect();if(!databasePool.ended)await databasePool.end()}
 finally{await control.end();try{await command(path.join(binaryDirectory,'pg_ctl'),['-D',path.join(sourceRoot,'pg'),'-m','fast','-w','stop'])}finally{await rm(sourceRoot,{recursive:true,force:true})}}
})

it('copies database and immutable files from one exported snapshot and stores the deletion registry separately',async()=>{
 const result=await runBackupMaintenance({managementUrl:source,backupUrl:source,...directories(),pgBin,storage:{stream:async()=>({stream:Readable.from([bytes]),size:bytes.length}),read:async()=>bytes,put:async()=>{throw new Error('must not write source objects')},delete:async()=>{throw new Error('must not delete source objects')}}})
 assert.equal(result.status,'succeeded');const {rows}=await databasePool.query('SELECT component,snapshot_at,status,consistent FROM staffly_admin.backup_components WHERE backup_id=$1 ORDER BY component',[backupId]);assert.deepEqual(rows.map(r=>r.component),['database','deletions','files']);assert(rows.every(r=>r.status==='VERIFIED'&&r.consistent));assert.equal(+rows[0].snapshot_at,+rows[2].snapshot_at)
 assert.deepEqual(await readFile(path.join(directories().filesDirectory,'set-'+backupId,'objects',fileId)),bytes)
})
it('restores into a generated isolated database, reconciles newer deletion records and records schema and duration',async()=>{
 await prisma.user.update({where:{id:deletedId},data:{deletedAt:new Date()}});await prisma.dataDeletion.create({data:{kind:'ACCOUNT',subjectId:deletedId,dueAt:new Date(Date.now()+31*86400000)}})
 const db=await databasePool.connect(),before=(await databasePool.query("SELECT datname FROM pg_database WHERE datname LIKE 'staffly_rehearsal_%'")).rows.map(r=>r.datname)
 try{
  await exportDeletionLedger(db,directories().ledgerDirectory,backupId)
  const result=await runRestoreRehearsal({management:db,backupId,restoreAdminUrl:source,...directories(),pgBin});assert.equal(result.restored,true);assert.equal(result.checks.filesVerified,true);assert.equal(result.checks.ledgerVerified,true);assert.equal(result.checks.ledgerReconciled,true);assert.equal(result.checks.ledgerReconciliationRequired,false)
  const {rows:[check]}=await db.query('SELECT * FROM staffly_admin.restore_checks WHERE backup_id=$1 ORDER BY checked_at DESC LIMIT 1',[backupId]);assert.equal(check.status,'SUCCEEDED');assert.equal((await backupSetState())?.recovery,true);assert(check.duration_ms>0);assert.equal(check.schema_version,(await db.query('SELECT version FROM staffly_admin.release_schema_state')).rows[0].version);assert(!JSON.stringify(check).includes(bytes.toString()))
 }finally{db.release()}
 assert.deepEqual((await databasePool.query("SELECT datname FROM pg_database WHERE datname LIKE 'staffly_rehearsal_%'")).rows.map(r=>r.datname),before)
 assert.equal((await prisma.user.findUniqueOrThrow({where:{id:userId}})).deletedAt,null)
})
it('detects a corrupted object copy and keeps the source database and original file metadata intact',async()=>{
 await writeFile(path.join(directories().filesDirectory,'set-'+backupId,'objects',fileId),Buffer.from('corrupted'))
 const db=await databasePool.connect();try{await assert.rejects(runRestoreRehearsal({management:db,backupId,restoreAdminUrl:source,...directories(),pgBin}),/BACKUP_OBJECT_CHANGED/)}finally{db.release()}
 const {rows:[check]}=await databasePool.query('SELECT status,error_code FROM staffly_admin.restore_checks WHERE backup_id=$1 ORDER BY checked_at DESC LIMIT 1',[backupId]);assert.equal(check.status,'FAILED');assert.equal((await backupSetState())?.recovery,false);assert.equal((await backupSetState())?.complete,false);assert.equal(check.error_code,'BACKUP_OBJECT_CHANGED');assert.equal((await prisma.storedFile.findUniqueOrThrow({where:{id:fileId}})).checksumSha256,sha)
})
it('revalidates a repaired file set through a new actual restore check',async()=>{
 await writeFile(path.join(directories().filesDirectory,'set-'+backupId,'objects',fileId),bytes)
 const db=await databasePool.connect();try{await runRestoreRehearsal({management:db,backupId,restoreAdminUrl:source,...directories(),pgBin})}finally{db.release()}
 const set=await backupSetState();assert.equal(set?.complete,true);assert.equal(set?.recovery,true)
})
it('suppresses duplicate external signals, escalates and records actual provider acceptance with no live network',async()=>{
 await databasePool.query("UPDATE staffly_admin.delivery_settings SET enabled=true,channel='webhook',recipients=ARRAY['primary'],escalation_recipients=ARRAY['on-call'],escalation_minutes=1,repeat_minutes=60 WHERE id=1")
 const messages:Array<{recipient:string;message:SignalMessage}>=[],base=Date.now(),stateDirectory=path.join(root,'observer'),send=async(_channel:'webhook'|'email'|'telegram',recipient:string,message:SignalMessage)=>{messages.push({recipient,message});return{providerId:message.id}},options={databaseUrl:source,url:'http://fixture.test/health/ready',stateDirectory,probe:async()=>false,send}
 try{
  await runExternalProbe({...options,now:base});await runExternalProbe({...options,now:base+15000});await runExternalProbe({...options,now:base+30000});assert.equal(messages.length,1);assert.equal(messages[0].recipient,'primary')
  await runExternalProbe({...options,now:base+45000});assert.equal(messages.length,1)
  await runExternalProbe({...options,now:base+100000});assert.equal(messages.length,2);assert.equal(messages[1].recipient,'on-call')
  await runExternalProbe({...options,now:base+110000,probe:async()=>true});assert.equal(messages.length,3);assert.equal(messages[2].message.stage,'resolved')
  const {rows}=await databasePool.query('SELECT status FROM staffly_admin.signal_deliveries WHERE incident_id=$1',[messages[0].message.incidentId]);assert(rows.every(r=>r.status==='ACCEPTED'))
 }finally{await databasePool.query('UPDATE staffly_admin.delivery_settings SET enabled=false WHERE id=1')}
})
it('keeps a cached incident policy during database failure and flushes delivery metadata after recovery',async()=>{
 await databasePool.query("UPDATE staffly_admin.delivery_settings SET enabled=true,recipients=ARRAY['offline-on-call'] WHERE id=1")
 const sent:SignalMessage[]=[],base=Date.now(),stateDirectory=path.join(root,'offline-observer'),send=async(_c:'webhook'|'email'|'telegram',_r:string,m:SignalMessage)=>{sent.push(m);return{providerId:m.id}},url=new URL(source);url.port='1'
 try{
  await runExternalProbe({databaseUrl:source,url:'http://fixture.test/health/ready',stateDirectory,now:base,probe:async()=>false,send})
  for(const offset of [15000,30000])await runExternalProbe({databaseUrl:url.toString(),url:'http://fixture.test/health/ready',stateDirectory,now:base+offset,probe:async()=>false,send})
  assert.equal(sent.length,1);await runExternalProbe({databaseUrl:source,url:'http://fixture.test/health/ready',stateDirectory,now:base+45000,probe:async()=>false,send})
  const {rows:[delivery]}=await databasePool.query('SELECT status FROM staffly_admin.signal_deliveries WHERE id=$1',[sent[0].id]);assert.equal(delivery.status,'ACCEPTED')
 }finally{await databasePool.query('UPDATE staffly_admin.delivery_settings SET enabled=false WHERE id=1')}
})

it('does not resend a completed test delivery after a job lease is replayed',async()=>{
 await databasePool.query("UPDATE staffly_admin.delivery_settings SET enabled=true,channel='webhook',recipients=ARRAY['test-recipient'] WHERE id=1")
 const {rows:[job]}=await databasePool.query("INSERT INTO staffly_admin.service_jobs(kind,requested_by) VALUES('DELIVERY_TEST',$1) RETURNING id",[userId])
 const sent:SignalMessage[]=[],options={databaseUrl:source,url:'http://fixture.test/health/ready',stateDirectory:path.join(root,'replayed-test'),probe:async()=>true,send:async(_c:'webhook'|'email'|'telegram',_r:string,message:SignalMessage)=>{sent.push(message);return{providerId:message.id}}}
 try{
  await runExternalProbe(options);assert.equal(sent.length,1);assert.equal(sent[0].stage,'test')
  await databasePool.query("UPDATE staffly_admin.service_jobs SET status='PENDING',finished_at=NULL WHERE id=$1",[job.id])
  await runExternalProbe({...options,now:Date.now()+60000});assert.equal(sent.length,1)
  assert.equal((await databasePool.query('SELECT status FROM staffly_admin.service_jobs WHERE id=$1',[job.id])).rows[0].status,'SUCCEEDED')
 }finally{await databasePool.query('UPDATE staffly_admin.delivery_settings SET enabled=false WHERE id=1')}
})
