// Operator process only. This module is never imported by the HTTP API.
import { Pool,type PoolClient } from 'pg'
import { spawn } from 'node:child_process'
import { createHash,randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir,lstat,readFile,realpath,chmod } from 'node:fs/promises'
import path from 'node:path'
import { createDatabaseBackup } from '../../../../scripts/database-backup.ts'
import { safeError } from '../../security/safe-error.ts'
type Options={managementUrl:string;backupUrl:string;directory:string;pgBin?:string;signal?:AbortSignal;keepOnline?:boolean}
class BackupFailure extends Error{readonly code:string;constructor(code:string){super(code);this.code=code}}
const failure=(code:string):never=>{throw new BackupFailure(code)}
const DAY=86400000
async function digest(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex')}
async function inspect(file:string,pgBin:string,signal?:AbortSignal){
 const stat=await lstat(file).catch(()=>failure('BACKUP_MISSING'))
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.mode&0o077)failure('BACKUP_CHANGED')
 const child=spawn(pgBin?path.join(pgBin,'pg_restore'):'pg_restore',['--list',file],{env:{PATH:process.env.PATH,LANG:'C'},stdio:'ignore',signal})
 const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 if(code!==0)failure('BACKUP_FORMAT_INVALID')
 return{size:stat.size,sha256:await digest(file)}
}
async function transaction<T>(db:PoolClient,work:()=>Promise<T>){await db.query('BEGIN');try{const result=await work();await db.query('COMMIT');return result}catch(error){await db.query('ROLLBACK');throw error}}
export async function runBackupMaintenance(options:Options){
 const pool=new Pool({connectionString:options.managementUrl,max:1,connectionTimeoutMillis:10000,statement_timeout:15000}),db=await pool.connect()
 let locked=false,job:Record<string,unknown>|undefined,timer:ReturnType<typeof setInterval>|undefined,stage='CLAIM'
 const controller=new AbortController(),abort=()=>controller.abort(),deadline=setTimeout(abort,900000)
 options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort()
 try{
  locked=(await db.query('SELECT pg_try_advisory_lock(681947255::bigint) AS locked')).rows[0].locked
  if(!locked)return{status:'busy'}
  await db.query('UPDATE staffly_admin.management_state SET maintenance_heartbeat=now(),maintenance_stopped_at=NULL WHERE id=1')
  // Recover a crashed lease. The session advisory lock ensures no live operator is replaced.
  await db.query("UPDATE staffly_admin.backup_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE status='RUNNING' AND expires_at>now() AND attempts<3")
  job=(await db.query("UPDATE staffly_admin.backup_jobs SET status='RUNNING',attempts=attempts+1,started_at=COALESCE(started_at,now()),lease_token=gen_random_uuid(),lease_until=now()+interval '45 seconds' WHERE id=(SELECT id FROM staffly_admin.backup_jobs WHERE status='PENDING' AND expires_at>now() AND attempts<3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")).rows[0]
  if(!job)return{status:'idle'}
  const current=job
  let heartbeatPending=false
  timer=setInterval(()=>{if(heartbeatPending)return;heartbeatPending=true;void db.query("WITH heartbeat AS (UPDATE staffly_admin.management_state SET maintenance_heartbeat=now() WHERE id=1) UPDATE staffly_admin.backup_jobs SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND lease_token=$2 AND status='RUNNING'",[current.id,current.lease_token]).catch(()=>controller.abort()).finally(()=>{heartbeatPending=false})},10000)
  stage='DIRECTORY'
  const requestedDirectory=path.resolve(options.directory)
  await mkdir(requestedDirectory,{recursive:true,mode:0o700})
  const dirStat=await lstat(requestedDirectory)
  if(dirStat.isSymbolicLink()||!dirStat.isDirectory())failure('BACKUP_CONFIGURATION')
  const directory=await realpath(requestedDirectory)
  await chmod(directory,0o700)
  let id:string,fileKey:string,createdAt:Date,expected:string|null=null
  if(job.kind==='CREATE'){
   stage='IDENTIFY_DATABASE'
   id=String(job.id);fileKey='staffly-'+id+'.dump'
   const backupDb=new Pool({connectionString:options.backupUrl,max:1,connectionTimeoutMillis:10000,statement_timeout:10000})
   try{
    const owner=(await db.query('SELECT installation_id FROM staffly_admin.management_state WHERE id=1')).rows[0]
    const source=(await backupDb.query('SELECT installation_id FROM staffly_admin.management_state WHERE id=1')).rows[0]
    if(owner?.installation_id!==source?.installation_id)failure('BACKUP_DATABASE_MISMATCH')
   }finally{await backupDb.end()}
   const file=path.join(directory,fileKey),exists=await lstat(file).then(()=>true,()=>false)
   stage='DUMP'
   if(!exists)await createDatabaseBackup({databaseUrl:options.backupUrl,file,pgBin:options.pgBin,signal:controller.signal})
   // A complete dump left by a crash is reused only with its valid retention manifest.
   stage='MANIFEST'
   const manifestPath=file+'.retention.json',manifestStat=await lstat(manifestPath)
   if(manifestStat.isSymbolicLink()||!manifestStat.isFile()||manifestStat.size>16384||manifestStat.mode&0o077)failure('BACKUP_CHANGED')
   const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
   createdAt=new Date(manifest.createdAt)
   if(manifest.format!=='staffly-database-backup-v1'||manifest.file!==fileKey||!Number.isFinite(+createdAt)||Date.parse(manifest.expiresAt)!==+createdAt+30*DAY||+createdAt>Date.now()+1000||Date.parse(manifest.expiresAt)<=Date.now()||!/^[a-f0-9]{64}$/.test(manifest.sha256))failure('BACKUP_CHANGED')
   expected=manifest.sha256
  }else{
   const backup=(await db.query('SELECT * FROM staffly_admin.backups WHERE id=$1 AND expires_at>now()',[job.backup_id])).rows[0]
   if(!backup)failure('BACKUP_MISSING')
   id=String(backup.id);fileKey=backup.file_key;createdAt=backup.created_at;expected=backup.sha256
  }
  if(!/^staffly-[0-9a-f-]{36}\.dump$/.test(fileKey))failure('BACKUP_CONFIGURATION')
  stage='VERIFY'
  const info=await inspect(path.join(directory,fileKey),options.pgBin??'',controller.signal)
  if(info.sha256!==expected)failure('BACKUP_CHANGED')
  stage='REGISTER'
  await transaction(db,async()=>{
   const update=await db.query("UPDATE staffly_admin.backup_jobs SET status='SUCCEEDED',finished_at=now(),lease_until=NULL,lease_token=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2 AND status='RUNNING' AND expires_at>now() RETURNING id",[current.id,current.lease_token])
   if(!update.rowCount)failure('BACKUP_REQUEST_EXPIRED')
   if(current.kind==='CREATE')await db.query("INSERT INTO staffly_admin.backups(id,file_key,size_bytes,sha256,created_at,expires_at,verified_at,file_state) VALUES($1,$2,$3,$4,$5,$5::timestamptz+interval '30 days',now(),'AVAILABLE')",[id,fileKey,info.size,info.sha256,createdAt])
   else await db.query("UPDATE staffly_admin.backups SET file_state='AVAILABLE',check_code=NULL,verified_at=now() WHERE id=$1",[id])
   await db.query('UPDATE staffly_admin.backup_jobs SET backup_id=$2 WHERE id=$1',[current.id,id])
   await db.query("INSERT INTO staffly_admin.audit_events(id,user_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),$1,$2,'SUCCEEDED','BACKUP_JOB',$3)",[current.requested_by,current.kind==='CREATE'?'BACKUP_COMPLETED':'BACKUP_VERIFIED',current.id])
  })
  return{status:'succeeded',jobId:String(job.id),backupId:id}
 }catch(error){
  const code=error instanceof BackupFailure?error.code:controller.signal.aborted?'BACKUP_INTERRUPTED':job?.kind==='VERIFY'?'BACKUP_VERIFY_FAILED':'BACKUP_FAILED'
  if(job)await transaction(db,async()=>{
   const changed=await db.query("UPDATE staffly_admin.backup_jobs SET status='FAILED',finished_at=now(),lease_until=NULL,lease_token=NULL,error_code=$3 WHERE id=$1 AND lease_token=$2 AND status='RUNNING' RETURNING id",[job!.id,job!.lease_token,code])
   if(!changed.rowCount)return
   if(job!.kind==='VERIFY')await db.query("UPDATE staffly_admin.backups SET file_state=$2,check_code=$3 WHERE id=$1",[job!.backup_id,code==='BACKUP_MISSING'?'MISSING':'INVALID',code])
   await db.query("INSERT INTO staffly_admin.audit_events(id,user_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),$1,$2,'FAILED','BACKUP_JOB',$3)",[job!.requested_by,job!.kind==='CREATE'?'BACKUP_FAILED':'BACKUP_VERIFY_FAILED',job!.id])
   await db.query("INSERT INTO public.platform_request_errors(id,node_id,method,route,status,name,event_code,source,job_id,user_id,task_name) VALUES($1,$2,'OTHER','/workers/backups',0,'Error',$3,'worker',$4,$5,'Backup maintenance')",[randomUUID(),'00000000-0000-0000-0000-000000000000',code,job!.id,job!.requested_by])
  })
  if(!job)throw new Error('Backup maintenance unavailable; connection details omitted')
  return{status:'failed',jobId:String(job.id),code,stage,diagnostic:safeError(error)}
 }finally{
  if(timer)clearInterval(timer);clearTimeout(deadline);options.signal?.removeEventListener('abort',abort)
  if(locked){if(!options.keepOnline||options.signal?.aborted)await db.query('UPDATE staffly_admin.management_state SET maintenance_stopped_at=now() WHERE id=1').catch(()=>{});await db.query('SELECT pg_advisory_unlock(681947255::bigint)').catch(()=>{})}
  db.release();await pool.end()
 }
}
