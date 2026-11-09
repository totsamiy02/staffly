import { Pool } from 'pg'
import { createReadStream } from 'node:fs'
import { access,lstat,realpath,readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadEnvFile } from 'node:process'
import { libpqEnvironment } from './database-backup.ts'

/** Operator-only rehearsal. Never cleans, drops or overwrites an existing DB. */
export async function checkDatabaseRestore({targetUrl,directory,backupId,sha256,pgBin=''}:{targetUrl:string;directory:string;backupId:string;sha256:string;pgBin?:string}){
 if(!/^[0-9a-f-]{36}$/.test(backupId)||!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Expected backup UUID and SHA-256')
 const url=new URL(targetUrl),database=decodeURIComponent(url.pathname.slice(1))
 if(!['postgres:','postgresql:'].includes(url.protocol)||['postgres','template0','template1'].includes(database))throw new Error('Choose a separate empty rehearsal database')
 const root=path.resolve(directory),rootStat=await lstat(root)
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('Choose a real private backup directory')
 const file=path.join(await realpath(root),'staffly-'+backupId+'.dump'),stat=await lstat(file)
 if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error('Expected a private regular backup file')
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk)
 if(hash.digest('hex')!==sha256)throw new Error('Backup checksum mismatch')
 const manifestFile=file+'.retention.json',manifestStat=await lstat(manifestFile);if(!manifestStat.isFile()||manifestStat.isSymbolicLink()||manifestStat.mode&0o077||manifestStat.size>16384)throw new Error('BACKUP_MANIFEST_INVALID')
 const manifest=JSON.parse(await readFile(manifestFile,'utf8'));if(manifest.format!=='staffly-database-backup-v1'||manifest.sha256!==sha256||manifest.file!==path.basename(file)||Date.parse(manifest.expiresAt)!==Date.parse(manifest.createdAt)+30*86400000||Date.parse(manifest.expiresAt)<=Date.now())throw new Error('BACKUP_MANIFEST_INVALID')
 const pool=new Pool({connectionString:targetUrl,max:1,connectionTimeoutMillis:10000,statement_timeout:15000})
 try{
  const db=await pool.connect()
  try{
  const {rows:[state]}=await db.query("SELECT count(*)::int AS objects FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','S','v','m','f')")
  if(state.objects!==0)throw new Error('Restore refused: target database is not empty')
  const child=spawn(pgBin?path.join(pgBin,'pg_restore'):'pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-privileges','--dbname',database,file],{env:libpqEnvironment(targetUrl),stdio:'ignore',signal:AbortSignal.timeout(900000)})
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
  if(code!==0)throw new Error('Restore rehearsal failed; target is separate and working data was not changed')
  const {rows:[counts]}=await db.query('SELECT (SELECT count(*)::int FROM public.users) users,(SELECT count(*)::int FROM public.organizations) organizations,(SELECT count(*)::int FROM public.stored_files) files')
  const {rows:[schema]}=await db.query("SELECT (SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1) AS version,(SELECT installation_id FROM staffly_admin.management_state WHERE id=1) AS installation_id,(SELECT count(*)::int FROM pg_constraint WHERE contype='f' AND NOT convalidated) AS invalid_constraints")
  if(!schema.version||schema.invalid_constraints)throw new Error('RESTORE_VALIDATION_FAILED')
  return{restored:true,...counts,schemaVersion:String(schema.version),installationId:String(schema.installation_id),foreignKeysValidated:true}
  }finally{db.release()}
 }finally{await pool.end()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{loadEnvFile('src/server/.env')}catch{}
 const args=Object.fromEntries(process.argv.slice(2).map(value=>value.replace(/^--/,'').split('=')))
 if(!process.env.RESTORE_DATABASE_URL)throw new Error('Set RESTORE_DATABASE_URL to a separate empty database in the private operator environment')
 const defaultBin='/Applications/Postgres.app/Contents/Versions/18/bin',pgBin=process.env.PG_BIN||await access(defaultBin).then(()=>defaultBin,()=>'')
 const started=Date.now(),managementUrl=process.env.ADMIN_MANAGEMENT_DATABASE_URL
 let result:Awaited<ReturnType<typeof checkDatabaseRestore>>|null=null,registered=false
 try{result=await checkDatabaseRestore({targetUrl:process.env.RESTORE_DATABASE_URL,directory:process.env.ADMIN_BACKUP_DIRECTORY||'artifacts/backups',backupId:args['backup-id']??'',sha256:args.sha256??'',pgBin});}catch{console.error('Restore rehearsal refused or failed. Check target emptiness, backup checksum and operator configuration.');process.exitCode=1}
 if(managementUrl){const pool=new Pool({connectionString:managementUrl,max:1,connectionTimeoutMillis:10000,statement_timeout:10000});try{
  const {rows:[backup]}=await pool.query('SELECT b.id,s.installation_id FROM staffly_admin.backups b CROSS JOIN staffly_admin.management_state s WHERE b.id=$1 AND b.sha256=$2',[args['backup-id'],args.sha256])
  if(!backup||result&&result.installationId!==backup.installation_id)throw new Error('RESTORE_DATABASE_MISMATCH')
  await pool.query('INSERT INTO staffly_admin.restore_checks(backup_id,status,duration_ms,schema_version,checks,error_code) VALUES($1,$2,$3,$4,$5,$6)',[backup.id,result?'SUCCEEDED':'FAILED',Math.min(2147483647,Date.now()-started),result?.schemaVersion??null,JSON.stringify({databaseRestored:!!result,schemaValidated:!!result?.schemaVersion,foreignKeysValidated:!!result?.foreignKeysValidated,filesVerified:false,ledgerVerified:false}),result?null:'RESTORE_CHECK_FAILED'])
  registered=true
 }catch{console.error('Restore result was not registered; check the operator management database');process.exitCode=1}finally{await pool.end()}}
 if(result)console.log(JSON.stringify({...result,registered}))
}
