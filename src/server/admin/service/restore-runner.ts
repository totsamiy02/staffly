import { Pool,type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { checkDatabaseRestore } from '../../../../scripts/database-restore-check.ts'
import { verifyBackupComponents } from './backup-components.ts'
export async function runRestoreRehearsal({management,backupId,restoreAdminUrl,directory,filesDirectory,ledgerDirectory,pgBin}:{management:PoolClient;backupId:string;restoreAdminUrl:string;directory:string;filesDirectory?:string;ledgerDirectory?:string;pgBin?:string}){
 const {rows:[backup]}=await management.query("SELECT id,sha256,created_at FROM staffly_admin.backups WHERE id=$1 AND verified_at IS NOT NULL AND file_state='AVAILABLE' AND expires_at>now()",[backupId])
 if(!backup)throw new Error('RESTORE_BACKUP_UNAVAILABLE')
 const started=Date.now(),name='staffly_rehearsal_'+randomUUID().replaceAll('-',''),url=new URL(restoreAdminUrl),control=new Pool({connectionString:restoreAdminUrl,max:1,connectionTimeoutMillis:10000,statement_timeout:30000})
 let created=false,schemaVersion:string|null=null,checks:Record<string,unknown>={},status='FAILED',code:string|null=null
 try{
  // Only a generated database is created/dropped. No target URL comes from HTTP.
  await control.query('CREATE DATABASE "'+name+'" TEMPLATE template0');created=true;url.pathname='/'+name
  const result=await checkDatabaseRestore({targetUrl:url.toString(),directory,backupId,sha256:backup.sha256,pgBin})
  const target=new Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:10000,statement_timeout:15000}),db=await target.connect()
  try{
   const {rows:[schema]}=await db.query("SELECT (SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1) AS version,(SELECT installation_id FROM staffly_admin.management_state WHERE id=1) AS installation_id,(SELECT count(*)::int FROM pg_constraint WHERE contype='f' AND NOT convalidated) AS invalid_constraints")
   const identity=(await management.query('SELECT installation_id FROM staffly_admin.management_state WHERE id=1')).rows[0]
   if(!schema.version||schema.installation_id!==identity.installation_id||schema.invalid_constraints!==0)throw new Error('RESTORE_VALIDATION_FAILED')
   schemaVersion=schema.version;checks={databaseRestored:result.restored,schemaValidated:!!schema.version,foreignKeysValidated:true,users:result.users,organizations:result.organizations,files:result.files,filesVerified:false,ledgerVerified:false}
   if(filesDirectory&&ledgerDirectory)checks={...checks,...await verifyBackupComponents({backupId,filesDirectory,ledgerDirectory,backupAt:backup.created_at,installationId:identity.installation_id,schemaVersion:schema.version,db})}
   if(checks.filesVerified&&checks.ledgerVerified){
    await management.query("INSERT INTO staffly_admin.backup_components(backup_id,component,snapshot_at,checked_at,expires_at,status,sha256,objects,consistent,schema_version) VALUES($1,'files',$2,now(),$2::timestamptz+interval '30 days','VERIFIED',$3,$4,true,$5)",[backupId,backup.created_at,checks.filesManifestSha256,checks.files,schemaVersion])
    await management.query("INSERT INTO staffly_admin.backup_components(backup_id,component,snapshot_at,checked_at,expires_at,status,sha256,objects,consistent) VALUES($1,'deletions',$2,now(),$2::timestamptz+interval '30 days','VERIFIED',$3,$4,true)",[backupId,checks.ledgerSnapshotAt,checks.ledgerManifestSha256,checks.deletionRecords])
   }
   status='SUCCEEDED'
  }finally{db.release();await target.end()}
 }catch(error){
  code=error instanceof Error&&error.message==='Backup checksum mismatch'?'BACKUP_CHANGED':error instanceof Error&&/^(BACKUP|RESTORE)_[A-Z_]{1,55}$/.test(error.message)?error.message:'RESTORE_CHECK_FAILED'
  const component=code.startsWith('BACKUP_LEDGER')?'deletions':code==='BACKUP_CHANGED'?'database':code.startsWith('BACKUP_')?'files':null
  if(component){await management.query("INSERT INTO staffly_admin.backup_components(backup_id,component,snapshot_at,checked_at,expires_at,status,consistent,check_code) VALUES($1,$2,$3,now(),$3::timestamptz+interval '30 days','FAILED',false,$4)",[backupId,component,backup.created_at,code]);if(component==='database')await management.query("UPDATE staffly_admin.backups SET file_state='INVALID',check_code='BACKUP_CHANGED' WHERE id=$1",[backupId])}
 }
 finally{
  try{if(created&&/^staffly_rehearsal_[a-f0-9]{32}$/.test(name))await control.query('DROP DATABASE "'+name+'" WITH (FORCE)');checks.rehearsalDatabaseRemoved=true}
  catch{status='FAILED';code='RESTORE_CLEANUP_FAILED';checks.rehearsalDatabaseRemoved=false}
  finally{await control.end()}
  const duration=Math.min(2147483647,Date.now()-started)
  await management.query('INSERT INTO staffly_admin.restore_checks(backup_id,status,duration_ms,schema_version,checks,error_code) VALUES($1,$2,$3,$4,$5,$6)',[backupId,status,duration,schemaVersion,JSON.stringify(checks),code])
 }
 if(code)throw new Error(code)
 return{restored:status==='SUCCEEDED',schemaVersion,checks}
}
