import type { PoolClient } from 'pg'
import { databasePool } from '../../db.ts'
import { backgroundTaskSnapshot, startBackgroundTask } from '../../background-task.ts'
import { safeError } from '../../security/safe-error.ts'
import { nativeTransaction } from '../database.ts'

export { runtimeNodeId,captureRequestFailure } from '../../support/diagnostics.ts'
import { runtimeNodeId,takeDiagnostics,restoreDiagnostics,diagnosticsDropped,diagnosticsPending,setDiagnosticsWakeup,type Incident } from '../../support/diagnostics.ts'
const startedAt=new Date()
let lastCleanup=0
export type RuntimeOptions={role:'api'|'worker';ready:()=>boolean;http?:()=>{requests:number;errors:number;active:number;meanMs:number};nodeId?:string}
export function runtimeConfiguration(role:RuntimeOptions['role']){
  return{backgroundWorkers:role==='worker'||process.env.RUN_BACKGROUND_WORKERS!=='false',emailConfigured:Boolean(process.env.SMTP_USER&&process.env.SMTP_APP_PASSWORD),emailPaused:process.env.EMAIL_DELIVERY_PAUSED==='true',storage:process.env.STORAGE_DRIVER==='s3'?'s3':'local',fileProcessing:process.env.FILE_PROCESSOR_SOCKET?'service':role==='api'&&process.env.NODE_ENV==='production'?'unconfigured':'process'}
}
export async function publishOperationsSnapshot(options:RuntimeOptions,stopped=false){
  const memory=process.memoryUsage(),batch=takeDiagnostics(stopped?200:50),now=new Date(),cleanup=Date.now()-lastCleanup>=3600_000
  const snapshot={rss:memory.rss,heapUsed:memory.heapUsed,heapTotal:memory.heapTotal,uptime:Math.floor(process.uptime()),pool:{total:databasePool.totalCount,idle:databasePool.idleCount,waiting:databasePool.waitingCount},http:options.http?.()??null,tasks:backgroundTaskSnapshot(),droppedErrors:diagnosticsDropped(),
    config:runtimeConfiguration(options.role)}
  try{
    await nativeTransaction(databasePool,async db=>{
    await db.query("SET LOCAL statement_timeout='2000ms'")
    await db.query(`INSERT INTO platform_runtime_nodes(id,role,started_at,heartbeat_at,stopped_at,ready,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET heartbeat_at=EXCLUDED.heartbeat_at,stopped_at=EXCLUDED.stopped_at,ready=EXCLUDED.ready,snapshot=EXCLUDED.snapshot`,[options.nodeId??runtimeNodeId,options.role,startedAt,now,stopped?now:null,!stopped&&options.ready(),JSON.stringify(snapshot)])
    await writeDiagnostics(db,batch)
    if(cleanup)await db.query('SELECT public.platform_cleanup_diagnostics()')
    });if(cleanup)lastCleanup=Date.now()
  }catch(error){restoreDiagnostics(batch);throw error}
}
async function writeDiagnostics(db:PoolClient,batch:Incident[]){
  if(batch.length)await db.query(`INSERT INTO platform_request_errors(id,node_id,created_at,method,route,status,name,code,user_id,organization_id,source,event_code,task_name)
      SELECT id,node_id,created_at,method,route,status,name,code,user_id,organization_id,source,event_code,task_name FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,node_id uuid,created_at timestamptz,method text,route text,status int,name text,code text,user_id uuid,organization_id uuid,source text,event_code text,task_name text) ON CONFLICT(id) DO NOTHING`,[JSON.stringify(batch)])
}
export function startOperationsTelemetry(options:RuntimeOptions){
  let closing=false,inFlight:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined
  const wake=(delay=100)=>{if(closing||inFlight||timer||!diagnosticsPending())return;timer=setTimeout(()=>{timer=undefined;const batch=takeDiagnostics(50);let failed=false;inFlight=nativeTransaction(databasePool,async db=>{await db.query("SET LOCAL statement_timeout='2000ms'");await writeDiagnostics(db,batch)}).catch(error=>{failed=true;restoreDiagnostics(batch);console.warn('Support diagnostics temporarily unavailable:',safeError(error))}).finally(()=>{inFlight=undefined;wake(failed?5000:100)})},delay);timer.unref()}
  setDiagnosticsWakeup(wake)
  wake()
  const stop=startBackgroundTask({name:'Operations telemetry',intervalMs:10000,run:()=>publishOperationsSnapshot(options)})
  return async()=>{closing=true;setDiagnosticsWakeup(undefined);clearTimeout(timer);await inFlight;await stop();try{await publishOperationsSnapshot(options,true)}catch(error){console.warn('Operations telemetry shutdown unavailable:',safeError(error))}}
}
