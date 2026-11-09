import { loadEnvFile } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { runExternalProbe } from '../src/server/admin/service/external-probe.ts'
try{loadEnvFile(process.env.OBSERVER_ENV_FILE??'src/server/.env')}catch{}
const databaseUrl=process.env.ADMIN_OBSERVER_DATABASE_URL
if(!databaseUrl)throw new Error('Set ADMIN_OBSERVER_DATABASE_URL in the independent observer environment')
const stateDirectory=process.env.ADMIN_OBSERVER_STATE_DIRECTORY
if(!stateDirectory)throw new Error('Set a persistent private ADMIN_OBSERVER_STATE_DIRECTORY')
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort())
do{
 try{await runExternalProbe({databaseUrl,url:process.env.ADMIN_PROBE_URL,stateDirectory})}catch{console.error('Independent observer cycle failed; details omitted')}
 if(!process.argv.includes('--watch')||controller.signal.aborted)break
 await delay(15000,undefined,{signal:controller.signal}).catch(()=>{})
}while(!controller.signal.aborted)
