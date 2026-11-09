import { passwordAttemptState } from '../../auth/attempt-limits.ts'
import { prisma,databasePool } from '../../db.ts'
import { adminPool } from '../database.ts'
import { ApiError } from '../../api-error.ts'
import { effectiveSubscription,plans } from '../../../app/subscriptions/plans.ts'
import { organizationAvailable } from '../../organizations/service-state.ts'
import { listQuery } from './schemas.ts'
const iso=(value:Date|null)=>value?.toISOString()??null
export async function accountService(id:string,query:unknown){
 const {page}=listQuery.parse(query),user=await prisma.user.findUnique({where:{id},select:{id:true,publicId:true,email:true,firstName:true,lastName:true,emailVerifiedAt:true,deletedAt:true,securityVersion:true,createdAt:true,identities:{select:{provider:true}},_count:{select:{sessions:true}}}})
 if(!user)throw new ApiError(404,'ADMIN_USER_NOT_FOUND','Пользователь не найден.')
 const [password,sessions,total,failures,deletion,jobs,loginLimit]=await Promise.all([
  databasePool.query('SELECT password_hash IS NOT NULL AS password_set FROM public.users WHERE id=$1',[id]),
  adminPool().query('SELECT * FROM staffly_admin.user_service_sessions WHERE user_id=$1 AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now() ORDER BY last_used_at DESC,id LIMIT 20 OFFSET $2',[id,(page-1)*20]),
  adminPool().query('SELECT count(*)::int AS n FROM staffly_admin.user_service_sessions WHERE user_id=$1 AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now()',[id]),
  prisma.securityEvent.findMany({where:{userId:id,action:{in:['LOGIN_FAILED','REFRESH_REUSE_DETECTED','SESSION_REVOKED']},createdAt:{gte:new Date(Date.now()-30*86400000)}},select:{id:true,action:true,outcome:true,reasonCode:true,createdAt:true},orderBy:[{createdAt:'desc'},{id:'desc'}],take:30}),
  prisma.dataDeletion.findUnique({where:{kind_subjectId:{kind:'ACCOUNT',subjectId:id}},select:{requestedAt:true,dueAt:true,completedAt:true,hold:true,lastErrorCode:true}}),
  adminPool().query("SELECT id,status,created_at,finished_at,error_code FROM staffly_admin.service_jobs WHERE kind='USER_RECOVERY' AND target_id=$1 ORDER BY created_at DESC LIMIT 5",[id]),passwordAttemptState(user.email)
 ])
 const hasPassword=Boolean(password.rows[0]?.password_set)
 return{loginLimit:user.deletedAt?null:loginLimit,id,publicId:user.publicId,displayName:user.deletedAt?'Удаляемый аккаунт':[user.lastName,user.firstName].filter(Boolean).join(' ')||user.email.split('@')[0],email:user.deletedAt?null:user.email,version:user.securityVersion,
  state:user.deletedAt?'deleting':!user.emailVerifiedAt?'unverified':!hasPassword?'provider':'active',passwordSet:hasPassword,providers:user.identities.map(i=>i.provider),createdAt:iso(user.createdAt),
  sessions:user.deletedAt?[]:sessions.rows.map(row=>({id:row.id,createdAt:iso(row.created_at),lastUsedAt:iso(row.last_used_at),expiresAt:iso(new Date(Math.min(+row.idle_expires_at,+row.absolute_expires_at))),userAgent:row.user_agent,ipAddress:row.ip_address,reuseDetected:!!row.refresh_reuse_detected_at})),total:total.rows[0].n,page,pageSize:20,
  failures:user.deletedAt?[]:failures.map(e=>({...e,createdAt:iso(e.createdAt)})),deletion:deletion?{requestedAt:iso(deletion.requestedAt),dueAt:iso(deletion.dueAt),completedAt:iso(deletion.completedAt),held:deletion.hold,failed:!!deletion.lastErrorCode}:null,recovery:jobs.rows.map(j=>({id:j.id,status:j.status,createdAt:iso(j.created_at),finishedAt:iso(j.finished_at),errorCode:j.error_code}))}
}
export async function organizationService(id:string){
 const organization=await prisma.organization.findUnique({where:{id},select:{id:true,publicId:true,name:true,deletedAt:true,serviceState:true,serviceUntil:true,serviceReason:true,serviceRevision:true,subscription:true,resourceBudget:{select:{storageBytes:true}},_count:{select:{members:{where:{leftAt:null,user:{deletedAt:null}}},locations:{where:{archivedAt:null}},files:{where:{purgedAt:null}}}}}})
 if(!organization)throw new ApiError(404,'ADMIN_ORGANIZATION_NOT_FOUND','Организация не найдена.')
 const [history,jobs]=await Promise.all([adminPool().query("SELECT h.id,h.action,h.reason,h.actor_id,a.display_name AS actor_name,h.before_value,h.after_value,h.created_at FROM staffly_admin.service_history h LEFT JOIN staffly_admin.administrator_directory a ON a.user_id=h.actor_id WHERE subject_id=$1 AND action IN ('ORG_STATE','PLAN_ADJUST') ORDER BY h.created_at DESC,h.id LIMIT 50",[id]),prisma.reportExport.count({where:{organizationId:id,status:{in:['PENDING','RUNNING']}}})])
 return{id,publicId:organization.publicId,name:organization.name,deleted:!!organization.deletedAt,state:organizationAvailable(organization)?'ACTIVE':'SUSPENDED',reason:organization.serviceReason,until:iso(organization.serviceUntil),version:organization.serviceRevision,
  subscription:organization.subscription?effectiveSubscription(organization.subscription):null,subscriptionVersion:organization.subscription?.revision??0,
  resources:{members:organization._count.members,locations:organization._count.locations,files:organization._count.files,storageBytes:Number(organization.resourceBudget?.storageBytes??0),jobs},plans:Object.values(plans).map(({id,name,members,locations,storageBytes,features})=>({id,name,members,locations,storageBytes,features})),
  history:history.rows.map(h=>({id:h.id,action:h.action,reason:h.reason,actor:h.actor_name??'Администратор',actorId:h.actor_id,before:h.before_value,after:h.after_value,createdAt:iso(h.created_at)})),paymentMode:'test' as const}
}
export async function maintenanceState(){
 const db=adminPool(),[schedule,components,checks,windows,delivery,probe,schema,releases,jobs,signals,runner,set]=await Promise.all([
  db.query(`SELECT s.*,a.display_name AS owner_name,
  (SELECT jsonb_build_object('status',j.status,'at',COALESCE(j.finished_at,j.started_at,j.created_at),'error',j.error_code) FROM staffly_admin.backup_jobs j WHERE j.id=s.last_create_id) AS create_result,
  (SELECT jsonb_build_object('status',j.status,'at',COALESCE(j.finished_at,j.started_at,j.created_at),'error',j.error_code) FROM staffly_admin.backup_jobs j WHERE j.id=s.last_verify_id) AS verify_result,
  (SELECT jsonb_build_object('status',j.status,'at',COALESCE(j.finished_at,j.started_at,j.created_at),'error',j.error_code) FROM staffly_admin.service_jobs j WHERE j.id=s.last_cleanup_id) AS cleanup_result
  FROM staffly_admin.backup_schedule s LEFT JOIN staffly_admin.administrator_directory a ON a.user_id=s.owner_id WHERE s.id=1`),db.query('SELECT DISTINCT ON(component) * FROM staffly_admin.backup_components ORDER BY component,checked_at DESC NULLS LAST,snapshot_at DESC,id DESC'),
  db.query('SELECT r.*,b.created_at AS backup_created_at FROM staffly_admin.restore_checks r JOIN staffly_admin.backups b ON b.id=r.backup_id ORDER BY r.checked_at DESC LIMIT 20'),
  db.query('SELECT w.*,a.display_name AS owner_name FROM staffly_admin.maintenance_windows w LEFT JOIN staffly_admin.administrator_directory a ON a.user_id=w.owner_id ORDER BY w.starts_at DESC,w.id LIMIT 40'),db.query('SELECT * FROM staffly_admin.delivery_settings WHERE id=1'),db.query('SELECT * FROM staffly_admin.external_probe WHERE id=1'),
  db.query('SELECT * FROM staffly_admin.release_schema_state'),db.query('SELECT * FROM staffly_admin.release_checks ORDER BY checked_at DESC LIMIT 10'),
  db.query('SELECT id,kind,target_id,status,attempts,created_at,finished_at,error_code,result FROM staffly_admin.service_jobs ORDER BY created_at DESC,id LIMIT 40'),
  db.query('SELECT * FROM staffly_admin.signal_deliveries ORDER BY attempted_at DESC,id LIMIT 30'),db.query('SELECT r.*,GREATEST(r.heartbeat_at,m.maintenance_heartbeat) AS heartbeat_at FROM staffly_admin.service_runner_state r CROSS JOIN staffly_admin.management_state m WHERE r.id=1 AND m.id=1'),backupSetState()
 ])
 return{runner:runner.rows[0],backupSet:set,schedule:schedule.rows[0],components:components.rows,restoreChecks:checks.rows,windows:windows.rows,delivery:delivery.rows[0],probe:probe.rows[0],schema:schema.rows[0],releases:releases.rows,jobs:jobs.rows,signals:signals.rows,version:process.env.APP_VERSION||null,deployedAt:process.env.APP_DEPLOYED_AT||null,now:new Date().toISOString(),purgeEnabled:process.env.DATA_PURGE_ENABLED==='true',externalConfigured:{webhook:!!process.env.ADMIN_SIGNAL_WEBHOOK_URL,email:!!process.env.SMTP_USER&&!!process.env.SMTP_APP_PASSWORD,telegram:!!process.env.ADMIN_SIGNAL_TELEGRAM_TOKEN},probeConfigured:!!process.env.ADMIN_PROBE_URL,restoreConfigured:!!process.env.RESTORE_DATABASE_URL}
}
export async function cleanupState(query:unknown){
 const q=listQuery.parse(query),pattern='%'+q.search.replace(/[\\%_]/g,'\\$&')+'%',where=`(d.id::text ILIKE $1 OR d.subject_id::text ILIKE $1) AND ($2='all' OR $2='held' AND d.hold AND d.completed_at IS NULL OR $2='completed' AND d.completed_at IS NOT NULL OR $2='failed' AND d.last_error_code IS NOT NULL AND d.completed_at IS NULL OR $2='pending' AND NOT d.hold AND d.completed_at IS NULL AND d.last_error_code IS NULL)`
 const [rows,total]=await Promise.all([adminPool().query('SELECT d.*,a.display_name AS owner_name FROM staffly_admin.cleanup_directory d LEFT JOIN staffly_admin.administrator_directory a ON a.user_id=d.owner_id WHERE '+where+' ORDER BY d.due_at,d.id LIMIT 20 OFFSET $3',[pattern,q.status,(q.page-1)*20]),adminPool().query('SELECT count(*)::int AS n FROM staffly_admin.cleanup_directory d WHERE '+where,[pattern,q.status])])
 return{items:rows.rows,total:total.rows[0].n,page:q.page,pageSize:20,enabled:process.env.DATA_PURGE_ENABLED==='true'}
}
export async function queueDetails(kind:'email'|'report',id:string){
 const [history,batches]=await Promise.all([adminPool().query('SELECT attempt,status,error_code,occurred_at FROM staffly_admin.queue_history WHERE kind=$1 AND job_id=$2 ORDER BY occurred_at,id LIMIT 200',[kind,id]),adminPool().query("SELECT id,command,reason,created_at,results FROM staffly_admin.queue_batches WHERE results @> $1::jsonb ORDER BY created_at DESC LIMIT 20",[JSON.stringify([{kind,id}])])])
 return{history:history.rows,batches:batches.rows,historyNote:'История попыток записывается с выпуска этой функции; более ранние переходы не восстановлены.'}
}
export async function queueState(){
 const [rows]=await Promise.all([databasePool.query(`SELECT 'email' AS kind,count(*)::int AS pending,extract(epoch FROM now()-min(created_at))::int AS oldest_seconds,count(*) FILTER(WHERE available_at<now()-interval '5 minutes' AND (locked_until IS NULL OR locked_until<=now()))::int AS delayed FROM public.email_deliveries WHERE status='PENDING' UNION ALL SELECT 'report',count(*)::int,extract(epoch FROM now()-min(created_at))::int,count(*) FILTER(WHERE created_at<now()-interval '5 minutes' AND status='PENDING')::int FROM public.report_exports WHERE status IN ('PENDING','RUNNING') AND expires_at>now()`)])
 return{queues:rows.rows}
}
export async function fileCleanupState(query:unknown){
 const raw=query as Record<string,unknown>,q=listQuery.parse({...raw,page:raw.filePage??1}),pattern='%'+q.search.replace(/[\\%_]/g,'\\$&')+'%',where=`(id::text ILIKE $1 OR organization_id::text ILIKE $1 OR uploaded_by_user_id::text ILIKE $1) AND ($2='all' OR $2='held' AND hold OR $2='failed' AND failed OR $2='pending' AND NOT hold AND NOT failed)`
 const [rows,total]=await Promise.all([adminPool().query('SELECT f.*,(SELECT display_name FROM staffly_admin.administrator_directory a WHERE a.user_id=f.owner_id) AS owner_name FROM staffly_admin.file_cleanup_directory f WHERE '+where+' ORDER BY pending_deletion_at,id LIMIT 20 OFFSET $3',[pattern,q.status,(q.page-1)*20]),adminPool().query('SELECT count(*)::int n FROM staffly_admin.file_cleanup_directory WHERE '+where,[pattern,q.status])])
 return{items:rows.rows,total:total.rows[0].n,page:q.page,pageSize:20}
}
export async function backupSetState(){
 const {rows:[set]}=await adminPool().query(`SELECT b.id,b.created_at,b.expires_at,
  COALESCE(d.status='VERIFIED' AND d.consistent AND d.expires_at>now() AND d.sha256=b.sha256,false) AS database,
  COALESCE(f.status='VERIFIED' AND f.consistent AND f.expires_at>now() AND f.snapshot_at=b.created_at,false) AS files,
  COALESCE(l.status='VERIFIED' AND l.consistent AND l.expires_at>now() AND l.snapshot_at>=b.created_at,false) AS deletions,
  COALESCE(r.status='SUCCEEDED' AND r.checks->>'filesVerified'='true' AND r.checks->>'ledgerVerified'='true',false) AS recovery
  FROM staffly_admin.backups b
  LEFT JOIN LATERAL(SELECT * FROM staffly_admin.backup_components WHERE backup_id=b.id AND component='database' ORDER BY checked_at DESC NULLS LAST,id DESC LIMIT 1)d ON true
  LEFT JOIN LATERAL(SELECT * FROM staffly_admin.backup_components WHERE backup_id=b.id AND component='files' ORDER BY checked_at DESC NULLS LAST,id DESC LIMIT 1)f ON true
  LEFT JOIN LATERAL(SELECT * FROM staffly_admin.backup_components WHERE (backup_id=b.id OR backup_id IS NULL) AND component='deletions' ORDER BY checked_at DESC NULLS LAST,id DESC LIMIT 1)l ON true
  LEFT JOIN LATERAL(SELECT * FROM staffly_admin.restore_checks WHERE backup_id=b.id ORDER BY checked_at DESC,id DESC LIMIT 1)r ON true
  WHERE b.file_state='AVAILABLE' AND b.verified_at IS NOT NULL AND b.expires_at>now() ORDER BY b.created_at DESC LIMIT 1`)
 return set?{...set,complete:!!set.database&&!!set.files&&!!set.deletions}:null
}
