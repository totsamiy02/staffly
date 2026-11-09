// Run on an independent host. Cached configuration and incident state survive a DB outage.
import { Pool } from 'pg'
import { createHash,randomInt,randomUUID } from 'node:crypto'
import { open,readFile,rename,lstat } from 'node:fs/promises'
import path from 'node:path'
import { privateDirectory } from './backup-components.ts'
type Settings={enabled:boolean;channel:'webhook'|'email'|'telegram';recipients:string[];escalation_recipients:string[];escalation_minutes:number;repeat_minutes:number}
type Incident={id:string;since:number;sent:Record<string,number>;available:boolean;title:string;acknowledged?:boolean}
type State={completedTests?:Record<string,{accepted:number;failed:number;at:number}>;version:1;failures:number;settings:Settings;incidents:Record<string,Incident>;windows:Array<{starts_at:string;ends_at:string}>;pending:Array<Record<string,unknown>>}
const empty=():State=>({version:1,failures:0,settings:{enabled:false,channel:'webhook',recipients:[],escalation_recipients:[],escalation_minutes:15,repeat_minutes:60},incidents:{},windows:[],pending:[]})
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
export type SignalMessage={id:string;incidentId:string;stage:string;text:string;receiptCode:string}
export async function sendExternalSignal(channel:Settings['channel'],recipient:string,message:SignalMessage){
 if(channel==='webhook'){
  const target=process.env.ADMIN_SIGNAL_WEBHOOK_URL;if(!target||new URL(target).protocol!=='https:'&&process.env.NODE_ENV!=='test')throw new Error('SIGNAL_UNCONFIGURED')
  const response=await fetch(target,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(process.env.ADMIN_SIGNAL_WEBHOOK_TOKEN?{Authorization:'Bearer '+process.env.ADMIN_SIGNAL_WEBHOOK_TOKEN}:{})},body:JSON.stringify({...message,recipient}),signal:AbortSignal.timeout(10000)})
  if(!response.ok)throw new Error('SIGNAL_PROVIDER_REJECTED');await response.body?.cancel();return{providerId:message.id}
 }
 if(channel==='telegram'){
  const token=process.env.ADMIN_SIGNAL_TELEGRAM_TOKEN;if(!token||!/^\d+:[A-Za-z0-9_-]+$/.test(token)||!/^[-\d]{1,20}$/.test(recipient))throw new Error('SIGNAL_UNCONFIGURED')
  // https://core.telegram.org/bots/api#sendmessage — plain text, no user HTML.
  const response=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:recipient,text:message.text+'\nКод проверки доставки: '+message.receiptCode}),signal:AbortSignal.timeout(10000)})
  if(!response.ok)throw new Error('SIGNAL_PROVIDER_REJECTED');const body=await response.json();if(!body.ok||!body.result?.message_id)throw new Error('SIGNAL_PROVIDER_REJECTED');return{providerId:String(body.result.message_id)}
 }
 if(!process.env.SMTP_USER||!process.env.SMTP_APP_PASSWORD)throw new Error('SIGNAL_UNCONFIGURED')
 const {deliverEmail}=await import('../../mail/transport.ts');await deliverEmail(recipient,{title:'Критический сигнал Staffly',intro:message.text+'\nКод проверки доставки: '+message.receiptCode,footer:'Введите код в журнале внешней доставки для подтверждения фактического получения.'});return{providerId:message.id}
}
export async function runExternalProbe({databaseUrl,url,stateDirectory,probe=async(target:string)=>{const response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(5000)});const body=await response.json();return response.ok&&body.ok===true},send=sendExternalSignal,now=Date.now()}:{databaseUrl:string;url?:string;stateDirectory:string;probe?:(url:string)=>Promise<boolean>;send?:typeof sendExternalSignal;now?:number}){
 const root=await privateDirectory(stateDirectory),file=path.join(root,'probe-state.json'),info=await lstat(file).catch(()=>null)
 if(info&&(info.isSymbolicLink()||!info.isFile()||info.mode&0o077||info.size>4*1024*1024))throw new Error('PROBE_STATE_UNSAFE')
 const state:State=info?JSON.parse(await readFile(file,'utf8')):empty();if(state.version!==1)throw new Error('PROBE_STATE_INVALID')
 const pool=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:3000,statement_timeout:5000});let databaseAvailable=true
 const persist=async()=>{const temporary=path.join(root,randomUUID()+'.tmp'),handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(state)+'\n');await handle.sync()}finally{await handle.close()}await rename(temporary,file)}
 try{
 try{
  const {rows:[lease]}=await pool.query('SELECT pg_try_advisory_lock(681947263::bigint) AS acquired');if(!lease.acquired)return{configured:false,available:null,databaseAvailable:true,suppressed:false,accepted:0,failed:0,busy:true}
  const settings=(await pool.query('SELECT * FROM staffly_admin.delivery_settings WHERE id=1')).rows[0];state.settings=settings
  state.windows=(await pool.query("SELECT starts_at,ends_at FROM staffly_admin.maintenance_windows WHERE status IN ('PLANNED','IN_PROGRESS','VERIFYING') AND ends_at>now()")).rows.map(w=>({starts_at:w.starts_at.toISOString(),ends_at:w.ends_at.toISOString()}))
  // Flush only safe delivery metadata accumulated during a DB outage.
  for(const delivery of state.pending){
   await pool.query('INSERT INTO staffly_admin.signal_deliveries(id,incident_id,stage,channel,recipient,status,attempted_at,error_code,provider_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING',[delivery.id,delivery.incidentId,delivery.stage,delivery.channel,delivery.recipient,delivery.status,delivery.at,delivery.errorCode,delivery.providerId])
   if(delivery.status==='ACCEPTED'&&delivery.receiptProof)await pool.query("INSERT INTO staffly_admin.signal_receipts(delivery_id,proof,expires_at) VALUES($1,$2,$3::timestamptz+interval '30 minutes') ON CONFLICT(delivery_id) DO NOTHING",[delivery.id,delivery.receiptProof,delivery.at])
  }
  state.pending=[]
 }catch{databaseAvailable=false}
 let available=false
 if(url){try{const target=new URL(url);if(target.protocol!=='https:'&&process.env.NODE_ENV!=='test'&&process.env.NODE_ENV!=='development')throw new Error('PROBE_URL_INVALID');available=await probe(url)}catch{available=false}}
 state.failures=available?0:state.failures+1
 const suppressed=state.windows.some(w=>Date.parse(w.starts_at)<=now&&Date.parse(w.ends_at)>now)
 if(url&&state.failures>=3&&!state.incidents.availability)state.incidents.availability={id:randomUUID(),since:now,sent:{},available:false,title:'Независимая проверка: сервис недоступен'}
 if(available&&state.incidents.availability)state.incidents.availability.available=true
 let testJob:{id:string}|null=null
 if(databaseAvailable){
  const alerts=(await pool.query("SELECT a.id,a.first_seen_at,a.acknowledged_at,r.key FROM staffly_admin.alerts a JOIN staffly_admin.alert_rules r ON r.id=a.rule_id WHERE a.resolved_at IS NULL AND r.severity='critical'")).rows
  const ids=new Set(alerts.map(a=>a.id));for(const alert of alerts){state.incidents[alert.id]??={id:alert.id,since:+alert.first_seen_at,sent:{},available:false,title:'Критическое условие: '+alert.key};state.incidents[alert.id].acknowledged=!!alert.acknowledged_at}
  for(const [key,incident]of Object.entries(state.incidents))if(key!=='availability'&&!key.startsWith('test:')&&!ids.has(key))incident.available=true
  await pool.query("UPDATE staffly_admin.service_jobs SET status='PENDING',lease_until=NULL WHERE kind='DELIVERY_TEST' AND status='RUNNING' AND lease_until<=now() AND attempts<3 AND expires_at>now()")
  await pool.query("UPDATE staffly_admin.service_jobs SET status='FAILED',finished_at=now(),error_code='SIGNAL_REQUEST_EXPIRED' WHERE kind='DELIVERY_TEST' AND status IN ('PENDING','RUNNING') AND (expires_at<=now() OR attempts>=3 AND lease_until<=now())")
  testJob=(await pool.query("UPDATE staffly_admin.service_jobs SET status='RUNNING',started_at=now(),attempts=attempts+1,lease_until=now()+interval '45 seconds' WHERE id=(SELECT id FROM staffly_admin.service_jobs WHERE kind='DELIVERY_TEST' AND status='PENDING' AND expires_at>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id")).rows[0]??null
  if(testJob&&!state.completedTests?.[testJob.id])state.incidents['test:'+testJob.id]??={id:testJob.id,since:now,sent:{},available:false,title:'Контрольная доставка сигнала Staffly'}
 }
 let sent=0,failed=0
 for(const [key,incident]of Object.entries(state.incidents)){
  const test=key.startsWith('test:'),settings=state.settings,testResult={accepted:0,failed:0,at:now}
  if(!settings.enabled||suppressed&&!test||incident.acknowledged&&!incident.available&&!test){if(incident.available)delete state.incidents[key];continue}
  if(incident.available&&!Object.keys(incident.sent).length){delete state.incidents[key];continue}
  const stage=incident.available?'resolved':!test&&now-incident.since>=settings.escalation_minutes*60000?'escalation':test?'test':'initial'
  const recipients=stage==='escalation'&&settings.escalation_recipients.length?settings.escalation_recipients:settings.recipients
  for(const recipient of recipients){
   const stamp=stage+':'+recipient,last=incident.sent[stamp];if(last!==undefined&&(test||now-last<settings.repeat_minutes*60000))continue
   const id=randomUUID(),code=String(randomInt(1000000)).padStart(6,'0'),delivery={id,incidentId:incident.id,stage,channel:settings.channel,recipient,status:'FAILED',at:new Date(now).toISOString(),errorCode:null as string|null,providerId:null as string|null}
   // Persist the attempt before network I/O; a crash does not silently resend it.
   incident.sent[stamp]=now;await persist()
   try{const response=await send(settings.channel,recipient,{id,incidentId:incident.id,stage,text:incident.available?'Состояние восстановлено: '+incident.title:incident.title,receiptCode:code});delivery.status='ACCEPTED';delivery.providerId=response.providerId;sent++;testResult.accepted++}catch(error){delivery.errorCode=error instanceof Error&&/^SIGNAL_[A-Z_]+$/.test(error.message)?error.message:'SIGNAL_DELIVERY_FAILED';failed++;testResult.failed++}
   const pending={...delivery,receiptProof:delivery.status==='ACCEPTED'?hash(id+':'+code):null};state.pending.push(pending);await persist()
   if(databaseAvailable){try{
    await pool.query('INSERT INTO staffly_admin.signal_deliveries(id,incident_id,stage,channel,recipient,status,attempted_at,error_code,provider_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING',[id,incident.id,stage,settings.channel,recipient,delivery.status,delivery.at,delivery.errorCode,delivery.providerId])
    if(delivery.status==='ACCEPTED')await pool.query("INSERT INTO staffly_admin.signal_receipts(delivery_id,proof,expires_at) VALUES($1,$2,now()+interval '30 minutes') ON CONFLICT(delivery_id) DO NOTHING",[id,pending.receiptProof])
    state.pending=state.pending.filter(row=>row.id!==id)
   }catch{databaseAvailable=false}}
  }
  if(test){state.completedTests??={};state.completedTests[incident.id]=testResult;state.completedTests=Object.fromEntries(Object.entries(state.completedTests).sort((a,b)=>b[1].at-a[1].at).slice(0,100));await persist()}
  if(incident.available||test)delete state.incidents[key]
 }
 if(databaseAvailable){
  await pool.query('UPDATE staffly_admin.external_probe SET heartbeat_at=now(),checked_at=CASE WHEN $1 THEN now() ELSE checked_at END,available=$2,consecutive_failures=$3,last_delivery_at=CASE WHEN $4>0 THEN now() ELSE last_delivery_at END,last_delivery_error=CASE WHEN $5>0 THEN $6 ELSE NULL END,configuration=$7,incident_id=$8 WHERE id=1',[!!url,url?available:null,state.failures,sent,failed,'SIGNAL_DELIVERY_FAILED',JSON.stringify({probe:!!url,webhook:!!process.env.ADMIN_SIGNAL_WEBHOOK_URL,email:!!process.env.SMTP_USER&&!!process.env.SMTP_APP_PASSWORD,telegram:!!process.env.ADMIN_SIGNAL_TELEGRAM_TOKEN}),state.incidents.availability?.id??null])
  if(testJob){const testResult=state.completedTests?.[testJob.id]??{accepted:0,failed:0};await pool.query("UPDATE staffly_admin.service_jobs SET status=$2,finished_at=now(),lease_until=NULL,result=$3,error_code=$4 WHERE id=$1",[testJob.id,testResult.accepted>0&&testResult.failed===0?'SUCCEEDED':'FAILED',JSON.stringify(testResult),!state.settings.enabled?'SIGNAL_DISABLED':testResult.failed?'SIGNAL_DELIVERY_FAILED':testResult.accepted?null:'SIGNAL_NO_RECIPIENTS'])}
 }
 await persist();return{configured:state.settings.enabled,available:url?available:null,databaseAvailable,suppressed,accepted:sent,failed}
 }finally{await pool.end()}
}
