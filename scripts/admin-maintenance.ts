import { runServiceMaintenance } from '../src/server/admin/service/runner.ts'
import { loadEnvFile } from 'node:process'
import { access } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { runBackupMaintenance } from '../src/server/admin/management/backup-runner.ts'
try{loadEnvFile('src/server/.env')}catch{}
const local=(url:string)=>['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)
const development=process.env.NODE_ENV!=='production'
const managementUrl=process.env.ADMIN_MANAGEMENT_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||(development&&process.env.DATABASE_URL&&local(process.env.DATABASE_URL)?process.env.DATABASE_URL:'')
const backupUrl=process.env.BACKUP_DATABASE_URL||(development?managementUrl:'')
if(!managementUrl||!backupUrl)throw new Error('Configure operator ADMIN_MANAGEMENT_DATABASE_URL and BACKUP_DATABASE_URL separately from the API')
const directory=process.env.ADMIN_BACKUP_DIRECTORY||(development?'artifacts/backups':'')
if(!directory)throw new Error('Configure private ADMIN_BACKUP_DIRECTORY')
const defaultBin='/Applications/Postgres.app/Contents/Versions/18/bin'
const pgBin=process.env.PG_BIN||await access(defaultBin).then(()=>defaultBin,()=>'')
const controller=new AbortController()
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort())
do{
 try{const service=await runServiceMaintenance({managementUrl,directory,pgBin,restoreAdminUrl:process.env.RESTORE_ADMIN_DATABASE_URL,filesDirectory:process.env.ADMIN_FILES_BACKUP_DIRECTORY,ledgerDirectory:process.env.ADMIN_DELETION_LEDGER_DIRECTORY,signal:controller.signal});if(service.status==='failed')console.log(JSON.stringify(service));const result=await runBackupMaintenance({managementUrl,backupUrl,directory,pgBin,signal:controller.signal,keepOnline:process.argv.includes('--watch'),filesDirectory:process.env.ADMIN_FILES_BACKUP_DIRECTORY,ledgerDirectory:process.env.ADMIN_DELETION_LEDGER_DIRECTORY});if(result.status!=='idle'&&result.status!=='busy')console.log(JSON.stringify(result))}
 catch{console.error('Backup maintenance unavailable; check operator configuration and migrations');if(!process.argv.includes('--watch'))process.exitCode=1}
 if(!process.argv.includes('--watch')||controller.signal.aborted)break
 await delay(5000,undefined,{signal:controller.signal}).catch(()=>{})
}while(!controller.signal.aborted)
