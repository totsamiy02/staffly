// This process has operator credentials. The HTTP API imports none of these modules.
import { Pool,type PoolClient } from 'pg'
import { pruneBackups } from '../../../../scripts/backup-retention.ts'
import { runRestoreRehearsal } from './restore-runner.ts'
import { exportDeletionLedger } from './backup-components.ts'
import type { EmailContent } from '../../mail/transport.ts'
export type ServiceRunnerOptions={managementUrl:string;directory:string;restoreAdminUrl?:string;filesDirectory?:string;ledgerDirectory?:string;pgBin?:string;sendRecovery?:(email:string,content:EmailContent)=>Promise<void>;signal?:AbortSignal}
export async function runBackupSchedule(db:PoolClient){
 await db.query('BEGIN')
 try{
  await db.query('SELECT pg_advisory_xact_lock(681947253::bigint)')
  const {rows:[s]}=await db.query('SELECT * FROM staffly_admin.backup_schedule WHERE id=1 FOR UPDATE')
  await db.query('UPDATE staffly_admin.backup_schedule SET heartbeat_at=now() WHERE id=1')
  if(s.enabled){
   const {rows:[owner]}=await db.query('SELECT user_id FROM staffly_admin.administrator_directory WHERE user_id=$1 AND enabled AND NOT deleted AND email_verified AND password_set',[s.owner_id])
   if(!owner)throw new Error('SCHEDULE_OWNER_UNAVAILABLE')
   const busy=(await db.query("SELECT EXISTS(SELECT 1 FROM staffly_admin.backup_jobs WHERE status IN ('PENDING','RUNNING') AND expires_at>now()) busy")).rows[0].busy
   if(!busy&&s.next_create_at<=new Date()){
    const {rows:[job]}=await db.query("INSERT INTO staffly_admin.backup_jobs(id,kind,requested_by) VALUES(gen_random_uuid(),'CREATE',$1) RETURNING id",[s.owner_id]);await db.query("UPDATE staffly_admin.backup_schedule SET next_create_at=now()+create_minutes*interval '1 minute',last_create_id=$1 WHERE id=1",[job.id])
   }else if(!busy&&s.next_verify_at<=new Date()){
    const {rows:[backup]}=await db.query("SELECT id FROM staffly_admin.backups WHERE file_state='AVAILABLE' AND expires_at>now() ORDER BY verified_at NULLS FIRST,created_at LIMIT 1")
    if(backup){const {rows:[job]}=await db.query("INSERT INTO staffly_admin.backup_jobs(id,kind,backup_id,requested_by) VALUES(gen_random_uuid(),'VERIFY',$1,$2) RETURNING id",[backup.id,s.owner_id]);await db.query('UPDATE staffly_admin.backup_schedule SET last_verify_id=$1 WHERE id=1',[job.id])}
    await db.query("UPDATE staffly_admin.backup_schedule SET next_verify_at=now()+verify_minutes*interval '1 minute' WHERE id=1")
   }
   if(s.next_cleanup_at<=new Date()){
    const {rows:[job]}=await db.query("INSERT INTO staffly_admin.service_jobs(kind,requested_by) VALUES('BACKUP_CLEANUP',$1) RETURNING id",[s.owner_id]);await db.query("UPDATE staffly_admin.backup_schedule SET next_cleanup_at=now()+cleanup_minutes*interval '1 minute',last_cleanup_id=$1 WHERE id=1",[job.id])
   }
  }
  await db.query('COMMIT')
 }catch(error){await db.query('ROLLBACK');throw error}
}
export async function runServiceMaintenance(options:ServiceRunnerOptions){
 const pool=new Pool({connectionString:options.managementUrl,max:2,connectionTimeoutMillis:10000,statement_timeout:30000}),db=await pool.connect();let locked=false,job:Record<string,unknown>|undefined,timer:ReturnType<typeof setInterval>|undefined
 try{
  locked=(await db.query('SELECT pg_try_advisory_lock(681947261::bigint) locked')).rows[0].locked;if(!locked)return{status:'busy'}
  await db.query('UPDATE staffly_admin.service_runner_state SET heartbeat_at=now(),configuration=$1,last_error_code=NULL WHERE id=1',[JSON.stringify({restore:!!options.restoreAdminUrl,files:!!options.filesDirectory,ledger:!!options.ledgerDirectory,purge:process.env.DATA_PURGE_ENABLED==='true'})])
  await runBackupSchedule(db)
  // A held session lock proves the old process is gone before reclaiming work.
  await db.query("UPDATE staffly_admin.service_jobs SET status='PENDING',lease_until=NULL,lease_token=NULL WHERE status='RUNNING' AND expires_at>now() AND attempts<3 AND kind<>'DELIVERY_TEST'")
  await db.query("UPDATE staffly_admin.service_jobs SET status='FAILED',finished_at=now(),error_code='SERVICE_JOB_EXPIRED',lease_token=NULL,lease_until=NULL WHERE status IN ('PENDING','RUNNING') AND (expires_at<=now() OR attempts>=3) AND kind<>'DELIVERY_TEST'")
  job=(await db.query("UPDATE staffly_admin.service_jobs SET status='RUNNING',started_at=COALESCE(started_at,now()),attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '45 seconds' WHERE id=(SELECT id FROM staffly_admin.service_jobs WHERE status='PENDING' AND kind<>'DELIVERY_TEST' AND expires_at>now() AND attempts<3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")).rows[0]
  if(!job){if(options.ledgerDirectory){const {rows:[last]}=await db.query("SELECT max(snapshot_at) at FROM staffly_admin.backup_components WHERE component='deletions'");if(!last.at||Date.now()-+last.at>15*60000)await exportDeletionLedger(db,options.ledgerDirectory)}return{status:'idle'}}
  const current=job
  timer=setInterval(()=>void db.query("WITH heartbeat AS(UPDATE staffly_admin.service_runner_state SET heartbeat_at=now() WHERE id=1) UPDATE staffly_admin.service_jobs SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND lease_token=$2 AND status='RUNNING'",[current.id,current.lease_token]).catch(()=>{}),10000)
  let result:unknown={ok:true}
  if(job.kind==='USER_RECOVERY'){
   const {rows:[user]}=await db.query('SELECT email,deleted_at AS "deletedAt",email_verified_at AS "emailVerifiedAt",security_version AS "securityVersion" FROM public.users WHERE id=$1',[job.target_id])
   const payload=job.payload as {userVersion?:number}
   if(!user||user.deletedAt||!user.emailVerifiedAt||user.securityVersion!==payload.userVersion)throw new Error('RECOVERY_ACCOUNT_CHANGED')
   // A guide to the ordinary recovery flow; no reset token/code is created here.
   if(!options.sendRecovery&&(!process.env.SMTP_USER||!process.env.SMTP_APP_PASSWORD))throw new Error('RECOVERY_EMAIL_UNCONFIGURED')
   await (options.sendRecovery??(await import('../../mail/transport.ts')).deliverEmail)(user.email,{title:'Помощь со входом в Staffly',intro:'Поддержка направила вам ссылку на штатное восстановление доступа. Запросите новый код на странице восстановления. Если вы входите через Яндекс, используйте этот способ на странице входа.',action:{label:'Восстановить доступ',path:'/forgot-password'},footer:'Поддержка не знает ваш пароль и не получает код. Никому не сообщайте коды подтверждения.'})
   result={instructionSent:true,passwordChanged:false}
  }else if(job.kind==='RESTORE_CHECK'){
   if(!options.restoreAdminUrl)throw new Error('RESTORE_UNCONFIGURED')
   result=await runRestoreRehearsal({management:db,backupId:String(job.target_id),restoreAdminUrl:options.restoreAdminUrl,directory:options.directory,filesDirectory:options.filesDirectory,ledgerDirectory:options.ledgerDirectory,pgBin:options.pgBin})
  }else if(job.kind==='BACKUP_CLEANUP'){
   result=await pruneBackups(options.directory,{apply:true})
   await db.query("UPDATE staffly_admin.backups SET file_state='MISSING',check_code='BACKUP_EXPIRED' WHERE expires_at<=now()")
   // File snapshot retention is handled separately by the coordinated set manifests.
   const {pruneFileSnapshots}=await import('./snapshot-retention.ts');if(options.filesDirectory)await pruneFileSnapshots(options.filesDirectory)
  }else if(job.kind==='LEDGER_BACKUP'){
   if(!options.ledgerDirectory)throw new Error('LEDGER_UNCONFIGURED');result=await exportDeletionLedger(db,options.ledgerDirectory)
  }else throw new Error('SERVICE_JOB_UNSUPPORTED')
  await db.query("UPDATE staffly_admin.service_jobs SET status='SUCCEEDED',finished_at=now(),lease_token=NULL,lease_until=NULL,result=$3,error_code=NULL WHERE id=$1 AND lease_token=$2 AND status='RUNNING'",[job.id,job.lease_token,JSON.stringify(result)])
  await db.query("INSERT INTO staffly_admin.audit_events(id,user_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),$1,'SERVICE_JOB_COMPLETED','SUCCEEDED','SERVICE_JOB',$2)",[job.requested_by,job.id])
  return{status:'succeeded',jobId:job.id}
 }catch(error){
  const code=error instanceof Error&&/^[A-Z_]{3,64}$/.test(error.message)?error.message:'SERVICE_MAINTENANCE_FAILED'
  if(job)await db.query("UPDATE staffly_admin.service_jobs SET status='FAILED',finished_at=now(),lease_token=NULL,lease_until=NULL,error_code=$3 WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token,code])
  if(job)await db.query("INSERT INTO staffly_admin.audit_events(id,user_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),$1,'SERVICE_JOB_FAILED','FAILED','SERVICE_JOB',$2)",[job.requested_by,job.id]).catch(()=>{})
  await db.query('UPDATE staffly_admin.service_runner_state SET last_error_code=$1 WHERE id=1',[code]).catch(()=>{})
  return{status:'failed',jobId:job?.id??null,code}
 }finally{if(timer)clearInterval(timer);if(locked)await db.query('SELECT pg_advisory_unlock(681947261::bigint)').catch(()=>{});db.release();await pool.end()}
}
