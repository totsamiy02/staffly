// Operator-only module. Paths and object keys never cross the admin HTTP boundary.
import { createHash } from 'node:crypto'
import { createWriteStream,constants } from 'node:fs'
import { mkdir,lstat,open,readFile,writeFile,rename,rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import path from 'node:path'
import type { Pool,PoolClient } from 'pg'
import type { StorageProvider } from '../../storage/provider.ts'
import { createDatabaseBackup } from '../../../../scripts/database-backup.ts'
const day=86400000
export async function privateDirectory(directory:string){
 const absolute=path.resolve(directory),root=process.platform==='darwin'&&(/^\/(tmp|var)(\/|$)/.test(absolute))?'/private'+absolute:absolute;await mkdir(root,{recursive:true,mode:0o700})
 const parts=root.split(path.sep).filter(Boolean);let current=path.parse(root).root
 for(const part of parts){current=path.join(current,part);const stat=await lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('BACKUP_UNSAFE_DIRECTORY')}
 const stat=await lstat(root);if(stat.mode&0o077)throw new Error('BACKUP_DIRECTORY_PERMISSIONS')
 return root
}
async function jsonFile(file:string,value:unknown){const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync()}finally{await handle.close()}}
export async function fileDigest(file:string){const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');try{for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);return hash.digest('hex')}finally{await handle.close()}}
export async function createCoordinatedBackup({source,management,file,id,filesDirectory,ledgerDirectory,storage,pgBin,signal}:{source:Pool;management:PoolClient;file:string;id:string;filesDirectory:string;ledgerDirectory:string;storage:StorageProvider;pgBin?:string;signal?:AbortSignal}){
 const filesRoot=await privateDirectory(filesDirectory),ledgerRoot=await privateDirectory(ledgerDirectory),dbRoot=await privateDirectory(path.dirname(path.resolve(file)))
 if([filesRoot,dbRoot].some(root=>ledgerRoot===root||ledgerRoot.startsWith(root+path.sep)||root.startsWith(ledgerRoot+path.sep)))throw new Error('BACKUP_LEDGER_MUST_BE_SEPARATE')
 const db=await source.connect(),set=path.join(filesRoot,'set-'+id)
 let committed=false
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  const {rows:[snapshot]}=await db.query("SELECT pg_export_snapshot() AS id,clock_timestamp() AS at,(SELECT installation_id FROM staffly_admin.management_state WHERE id=1) AS installation_id,(SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1) AS schema_version")
  const expected=(await management.query('SELECT installation_id FROM staffly_admin.management_state WHERE id=1')).rows[0]
  if(snapshot.installation_id!==expected.installation_id)throw new Error('BACKUP_DATABASE_MISMATCH')
  // Immutable bytes are held against purge until both the dump and copy finish.
  const {rows:files}=await db.query('SELECT id,object_key,size,checksum_sha256 FROM public.stored_files WHERE purged_at IS NULL ORDER BY id FOR SHARE')
  await mkdir(set,{mode:0o700});await mkdir(path.join(set,'objects'),{mode:0o700})
  const manifest=[] as Array<{id:string;size:number;sha256:string}>
  for(const row of files){
   if(signal?.aborted)throw new Error('BACKUP_INTERRUPTED')
   const object=await storage.stream(row.object_key),hash=createHash('sha256');let size=0
   const verify=new Transform({transform(chunk,_encoding,done){size+=chunk.length;hash.update(chunk);done(null,chunk)}})
   await pipeline(object.stream,verify,createWriteStream(path.join(set,'objects',row.id),{flags:'wx',mode:0o600}),{signal})
   const sha256=hash.digest('hex');if(size!==row.size||sha256!==row.checksum_sha256)throw new Error('BACKUP_OBJECT_CHANGED')
   manifest.push({id:row.id,size,sha256})
  }
  await createDatabaseBackup({databaseUrl:source.options.connectionString,file,pgBin,signal,snapshot:snapshot.id,snapshotAt:snapshot.at})
  await jsonFile(path.join(set,'manifest.json'),{format:'staffly-files-backup-v1',backupId:id,installationId:snapshot.installation_id,snapshotAt:snapshot.at,expiresAt:new Date(+snapshot.at+30*day),schemaVersion:snapshot.schema_version,files:manifest})
  await db.query('COMMIT');committed=true
  const ledger=await exportDeletionLedger(management,ledgerRoot,id)
  const sha256=await fileDigest(path.join(set,'manifest.json'))
  await management.query("INSERT INTO staffly_admin.backup_components(backup_id,component,snapshot_at,checked_at,expires_at,status,sha256,objects,consistent,schema_version) VALUES($1,'files',$2,now(),$2::timestamptz+interval '30 days','VERIFIED',$3,$4,true,$5)",[id,snapshot.at,sha256,files.length,snapshot.schema_version])
  return{snapshotAt:snapshot.at,files:files.length,ledger}
 }catch(error){if(!committed)await db.query('ROLLBACK').catch(()=>{});await rm(set,{recursive:true,force:true}).catch(()=>{});throw error}
 finally{db.release()}
}
export async function exportDeletionLedger(db:PoolClient,directory:string,backupId:string|null=null){
 const root=await privateDirectory(directory),{rows:[identity]}=await db.query('SELECT installation_id FROM staffly_admin.management_state WHERE id=1'),{rows:jobs}=await db.query('SELECT kind,subject_id,requested_at,due_at,completed_at,hold FROM public.data_deletions ORDER BY requested_at,id')
 const now=new Date(),name='ledger-'+now.toISOString().replace(/[^0-9]/g,'')+'-'+(backupId??'periodic')+'.json',file=path.join(root,name)
 await jsonFile(file,{format:'staffly-deletion-ledger-v2',installationId:identity.installation_id,exportedAt:now,backupId,jobs})
 const sha256=await fileDigest(file)
 // Atomic latest reference is in the independent ledger volume.
 const temporary=path.join(root,'latest-'+process.pid+'.tmp');await writeFile(temporary,JSON.stringify({file:name,sha256})+'\n',{mode:0o600,flag:'w'});await rename(temporary,path.join(root,'latest.json'))
 await db.query("INSERT INTO staffly_admin.backup_components(backup_id,component,snapshot_at,checked_at,expires_at,status,sha256,objects,consistent) VALUES($1,'deletions',$2,now(),$2::timestamptz+interval '30 days','VERIFIED',$3,$4,true)",[backupId,now,sha256,jobs.length])
 return{exportedAt:now,objects:jobs.length}
}
export async function verifyBackupComponents({backupId,filesDirectory,ledgerDirectory,backupAt,installationId,schemaVersion,db}:{backupId:string;filesDirectory:string;ledgerDirectory:string;backupAt:Date;installationId:string;schemaVersion?:string;db:PoolClient}){
 const root=await privateDirectory(filesDirectory),set=path.join(root,'set-'+backupId);for(const directory of [set,path.join(set,'objects')]){const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('BACKUP_UNSAFE_DIRECTORY')}const file=path.join(set,'manifest.json'),stat=await lstat(file)
 if(stat.isSymbolicLink()||!stat.isFile()||stat.mode&0o077||stat.size>64*1024*1024)throw new Error('BACKUP_MANIFEST_INVALID')
 const manifest=JSON.parse(await readFile(file,'utf8'))
 if(manifest.format!=='staffly-files-backup-v1'||manifest.backupId!==backupId||manifest.installationId!==installationId||schemaVersion&&manifest.schemaVersion!==schemaVersion||Date.parse(manifest.snapshotAt)!==+backupAt||Date.parse(manifest.expiresAt)<=Date.now())throw new Error('BACKUP_SNAPSHOT_MISMATCH')
 const {rows:expected}=await db.query('SELECT id,size,checksum_sha256 FROM public.stored_files WHERE purged_at IS NULL ORDER BY id')
 if(!Array.isArray(manifest.files)||manifest.files.length!==expected.length)throw new Error('BACKUP_FILES_INCOMPLETE')
 const rows=new Map<string,{id:string;size:number;sha256:string}>(manifest.files.map((r:{id:string;size:number;sha256:string})=>[r.id,r]))
 for(const row of expected){const metadata=rows.get(row.id);if(!metadata||metadata.sha256!==row.checksum_sha256||metadata.size!==row.size||!/^[0-9a-f-]{36}$/.test(row.id))throw new Error('BACKUP_FILES_INCOMPLETE');const object=path.join(set,'objects',row.id),info=await lstat(object);if(info.isSymbolicLink()||!info.isFile()||info.size!==row.size||await fileDigest(object)!==row.checksum_sha256)throw new Error('BACKUP_OBJECT_CHANGED')}
 const ledgerRoot=await privateDirectory(ledgerDirectory),latest=JSON.parse(await readFile(path.join(ledgerRoot,'latest.json'),'utf8'))
 if(!/^ledger-[0-9]+-[a-z0-9-]+\.json$/.test(latest.file))throw new Error('BACKUP_LEDGER_INVALID')
 const ledgerFile=path.join(ledgerRoot,latest.file);if(await fileDigest(ledgerFile)!==latest.sha256)throw new Error('BACKUP_LEDGER_INVALID')
 const ledger=JSON.parse(await readFile(ledgerFile,'utf8'))
 if(ledger.format!=='staffly-deletion-ledger-v2'||ledger.installationId!==installationId||Date.parse(ledger.exportedAt)<+backupAt||!Array.isArray(ledger.jobs))throw new Error('BACKUP_LEDGER_STALE')
 for(const row of ledger.jobs)if(!['ACCOUNT','ORGANIZATION'].includes(row.kind)||!/^[a-f0-9-]{36}$/.test(row.subject_id)||!Number.isFinite(Date.parse(row.requested_at))||!Number.isFinite(Date.parse(row.due_at)))throw new Error('BACKUP_LEDGER_INVALID')
 // Apply the independent tombstones only inside the rehearsal database.
 await db.query('BEGIN')
 try{
  for(const row of ledger.jobs){
   if(row.kind==='ACCOUNT'){
    await db.query('UPDATE public.users SET deleted_at=COALESCE(deleted_at,$2::timestamptz),security_version=security_version+1 WHERE id=$1',[row.subject_id,row.requested_at])
    await db.query('UPDATE public.auth_sessions SET revoked_at=COALESCE(revoked_at,now()),last_active_at=NULL WHERE user_id=$1',[row.subject_id])
   }else await db.query('UPDATE public.organizations SET deleted_at=COALESCE(deleted_at,$2::timestamptz) WHERE id=$1',[row.subject_id,row.requested_at])
   const table=row.kind==='ACCOUNT'?'users':'organizations',exists=(await db.query('SELECT id FROM public.'+table+' WHERE id=$1',[row.subject_id])).rowCount
   if(exists)await db.query('INSERT INTO public.data_deletions(id,kind,subject_id,requested_at,due_at,hold) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5) ON CONFLICT(kind,subject_id) DO UPDATE SET requested_at=LEAST(data_deletions.requested_at,EXCLUDED.requested_at),due_at=LEAST(data_deletions.due_at,EXCLUDED.due_at),hold=data_deletions.hold OR EXCLUDED.hold,completed_at=NULL',[row.kind,row.subject_id,row.requested_at,row.due_at,!!row.hold])
  }
  await db.query('COMMIT')
 }catch(error){await db.query('ROLLBACK');throw error}
 return{filesVerified:true,files:expected.length,filesManifestSha256:await fileDigest(file),ledgerVerified:true,ledgerManifestSha256:latest.sha256,ledgerSnapshotAt:ledger.exportedAt,ledgerReconciled:true,deletionRecords:ledger.jobs.length,ledgerReconciliationRequired:false}
}
