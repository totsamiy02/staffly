import { z } from 'zod'
import { periodSql,validatePeriod } from '../period.ts'
import type { Request } from 'express'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { adminPool } from '../database.ts'
import { requireAdminSession,ADMIN_ABSOLUTE_MS,ADMIN_IDLE_MS,ADMIN_CODE_MS } from '../security.ts'
import { matching,searchPatterns } from '../search.ts'
import { alertCatalog,backupErrors,auditLabels } from '../../../features/admin/management/catalog.ts'
import { iso,pageSize,queryBase } from './schemas.ts'
import { effectiveBackupState } from '../../../shared/admin-backup.ts'
import { publicNumber } from '../../support/public-numbers.ts'
type Row=Record<string,unknown>
const name=(row:Row)=>String(row.display_name||'Неактивный аккаунт')
function accountDto(row:Row,actorId:string){return{id:String(row.user_id),publicId:Number(row.public_id),name:name(row),email:row.email?String(row.email):null,enabled:Boolean(row.enabled),version:Number(row.version),userVersion:Number(row.user_version),grantedAt:iso(row.granted_at as Date),revokedAt:iso(row.revoked_at as Date|null),pinSet:Boolean(row.pin_set),ready:!row.deleted&&Boolean(row.email_verified&&row.password_set),self:row.user_id===actorId}}
export async function candidate(raw:unknown,actorId:string){
 const search=z.string().trim().min(1).max(120).parse(raw),isId=z.uuid().safeParse(search).success,number=publicNumber(search)
 if(!number&&!isId&&!z.email().safeParse(search).success)throw new ApiError(400,'ADMIN_CANDIDATE_QUERY','Укажите ID пользователя (например, 12) или полную почту.')
 const user=await prisma.user.findUnique({where:number?{publicId:number}:isId?{id:search}:{email:search.toLowerCase()},select:{id:true,publicId:true,firstName:true,lastName:true,email:true,deletedAt:true,emailVerifiedAt:true,passwordHash:true,securityVersion:true}})
 if(!user)throw new ApiError(404,'ADMIN_CANDIDATE_NOT_FOUND','Аккаунт не найден. Проверьте почту или ID.')
 const {rows:[grant]}=await adminPool().query('SELECT enabled,version FROM staffly_admin.accounts WHERE user_id=$1',[user.id])
 const self=user.id===actorId,ready=!user.deletedAt&&Boolean(user.emailVerifiedAt&&user.passwordHash)
 return{id:user.id,publicId:user.publicId,name:user.deletedAt?'Удалённый аккаунт':[user.lastName,user.firstName].filter(Boolean).join(' ')||'Пользователь',email:user.deletedAt?'Данные удалены':user.email[0]+'•••'+user.email.slice(user.email.indexOf('@')),version:Number(grant?.version??0),userVersion:user.securityVersion,enabled:Boolean(grant?.enabled),self,ready,reason:self?'Свой административный доступ нельзя менять через панель.':user.deletedAt?'Аккаунт удалён.':!user.emailVerifiedAt?'Почта не подтверждена.':!user.passwordHash?'Сначала пользователь должен установить пароль аккаунта.':grant?.enabled?'Административный доступ уже выдан.':null}
}
export async function administrators(request:Request){
 const {actor}=await requireAdminSession(request),q=queryBase.extend({status:z.enum(['all','active','disabled']).default('all')}).parse(request.query)
 const exact=q.search.includes('@')?await prisma.user.findUnique({where:{email:q.search.toLowerCase()},select:{id:true}}):null
 const values=[searchPatterns(q.search),q.status,exact?.id??null]
 const where=`($2='all' OR enabled=($2='active')) AND (${matching(['user_id::text','public_id::text','display_name','email'])} OR user_id=$3::uuid)`
 const [items,total,summary]=await Promise.all([
  adminPool().query(`SELECT * FROM staffly_admin.administrator_directory WHERE ${where} ORDER BY enabled DESC,granted_at DESC,user_id LIMIT $4 OFFSET $5`,[...values,pageSize,(q.page-1)*pageSize]),
  adminPool().query(`SELECT count(*)::int AS total FROM staffly_admin.administrator_directory WHERE ${where}`,values),
  adminPool().query(`SELECT count(*) FILTER(WHERE enabled AND NOT deleted AND email_verified AND password_set)::int AS active,count(*) FILTER(WHERE NOT enabled)::int AS revoked,count(*) FILTER(WHERE enabled AND NOT pin_set)::int AS awaiting_pin,(SELECT count(*)::int FROM staffly_admin.session_directory WHERE valid) AS sessions FROM staffly_admin.administrator_directory`),
 ])
 return{items:items.rows.map(row=>accountDto(row,actor.userId)),total:total.rows[0].total,page:q.page,pageSize,summary:summary.rows[0],actorId:actor.userId}
}
const auditGroups:Record<string,string[]>={access:['ACCESS_GRANTED','ACCESS_REVOKED'],work:['WORK_ASSIGNED'],auth:['CHALLENGE_SENT','CHALLENGE_DENIED','LOGIN','PIN_CREATED','PIN_RESET','PIN_DENIED','UNLOCK'],sessions:['LOCK','LOGOUT','ADMIN_SESSION_REVOKED','ACCESS_DENIED'],backups:['BACKUP_REQUESTED','BACKUP_VERIFY_REQUESTED','BACKUP_COMPLETED','BACKUP_FAILED','BACKUP_VERIFIED','BACKUP_VERIFY_FAILED'],alerts:['ALERT_OPENED','ALERT_RESOLVED','ALERT_ACKNOWLEDGED','ALERT_RULE_CHANGED'],reads:['MONITOR_VIEWED','OPERATIONS_VIEWED','MANAGEMENT_VIEWED']}
export async function securityState(request:Request){
 const {session}=await requireAdminSession(request),q=queryBase.extend({sessionSearch:z.string().trim().max(120).default(''),sessionPage:z.coerce.number().int().min(1).max(10000).default(1),sessionState:z.enum(['all','active','locked','setup']).default('all'),group:z.enum(['all','access','auth','sessions','backups','alerts','reads','work']).default('all'),outcome:z.enum(['all','SUCCEEDED','DENIED','FAILED']).default('all')}).parse(request.query)
 validatePeriod(q)
 const sessionSource="WITH entries AS (SELECT *,CASE WHEN setup_allowed THEN 'setup' WHEN locked_at IS NOT NULL OR activity_at<now()-interval '5 minutes' THEN 'locked' ELSE 'active' END AS session_state FROM staffly_admin.session_directory WHERE valid)",sessionWhere=`${matching(['id::text','user_id::text','public_id::text','display_name'])} AND ($2='all' OR session_state=$2)`
 const sessionValues=[searchPatterns(q.sessionSearch),q.sessionState]
 const labels=Object.entries(auditLabels).filter(([,label])=>q.search.toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean).every(term=>label.toLocaleLowerCase('ru-RU').includes(term))).map(([key])=>key)
 const values=[searchPatterns(q.search),q.days,q.outcome,q.group==='all'?[]:auditGroups[q.group],labels,q.from??null,q.to??null],where=`${periodSql('created_at',2,6,7)} AND ($3='all' OR outcome=$3) AND (CASE WHEN cardinality($4::text[])>0 THEN action=ANY($4::text[]) ELSE action NOT IN ('MONITOR_VIEWED','OPERATIONS_VIEWED','MANAGEMENT_VIEWED') END) AND (${matching(['id::text','user_id::text','actor_public_id::text','target_public_id::text','resource_id::text','actor_name','target_name','action'])} OR action=ANY($5::text[]))`
 const [rows,total,sessions,sessionTotal,summary]=await Promise.all([
  adminPool().query(`SELECT * FROM staffly_admin.audit_directory WHERE ${where} ORDER BY created_at DESC,id LIMIT $8 OFFSET $9`,[...values,pageSize,(q.page-1)*pageSize]),
  adminPool().query(`SELECT count(*)::int AS total FROM staffly_admin.audit_directory WHERE ${where}`,values),
  adminPool().query(`${sessionSource} SELECT * FROM entries WHERE ${sessionWhere} ORDER BY activity_at DESC,id LIMIT $3 OFFSET $4`,[...sessionValues,pageSize,(q.sessionPage-1)*pageSize]),
  adminPool().query(`${sessionSource} SELECT count(*)::int AS total FROM entries WHERE ${sessionWhere}`,sessionValues),
  adminPool().query(`SELECT (SELECT count(*)::int FROM staffly_admin.administrator_directory WHERE enabled AND NOT deleted AND email_verified AND password_set) AS administrators,(SELECT count(*)::int FROM staffly_admin.session_directory WHERE valid) AS sessions,(SELECT count(*)::int FROM staffly_admin.audit_events WHERE outcome='DENIED' AND created_at>now()-interval '24 hours') AS denials`),
 ])
 return{policy:{idleSeconds:ADMIN_IDLE_MS/1000,absoluteSeconds:ADMIN_ABSOLUTE_MS/1000,codeSeconds:ADMIN_CODE_MS/1000,pinDigits:6,pinAttempts:5,passwordAndEmail:true,secureCookies:process.env.NODE_ENV==='production',environment:process.env.NODE_ENV==='production'?'production':'development',auditDays:180},summary:summary.rows[0],sessionTotal:sessionTotal.rows[0].total,sessionPage:q.sessionPage,sessionPageSize:pageSize,sessions:sessions.rows.map(row=>({id:String(row.id),userId:String(row.user_id),userPublicId:Number(row.public_id),name:name(row),version:Number(row.grant_version),current:row.id===session.id,createdAt:iso(row.created_at as Date),expiresAt:iso(row.expires_at as Date),activityAt:iso(row.activity_at as Date),state:row.setup_allowed?'setup':row.locked_at||+new Date(row.activity_at as Date)+ADMIN_IDLE_MS<Date.now()?'locked':'active'})),audit:{items:rows.rows.map(row=>({id:String(row.id),actorPublicId:row.actor_public_id?Number(row.actor_public_id):null,targetPublicId:row.target_public_id?Number(row.target_public_id):null,actorId:row.user_id?String(row.user_id):null,actor:String(row.actor_name||'Оператор или служебный процесс'),target:row.target_name?String(row.target_name):null,action:String(row.action),outcome:String(row.outcome),resourceId:row.resource_id?String(row.resource_id):null,at:iso(row.created_at as Date)})),total:total.rows[0].total,page:q.page,pageSize}}
}
function backupJobDto(row:Row){return {id:String(row.id),kind:String(row.kind),backupId:row.backup_id?String(row.backup_id):null,userId:String(row.requested_by),status:String(row.status),attempts:Number(row.attempts),createdAt:iso(row.created_at as Date),startedAt:iso(row.started_at as Date|null),finishedAt:iso(row.finished_at as Date|null),expiresAt:iso(row.expires_at as Date),error:row.error_code?backupErrors[String(row.error_code)]??'Не удалось завершить служебную операцию':null}}
export async function backupJob(id:string){
 const {rows:[row]}=await adminPool().query('SELECT id,kind,backup_id,requested_by,status,attempts,created_at,started_at,finished_at,expires_at,error_code FROM staffly_admin.backup_jobs WHERE id=$1',[id])
 if(!row)throw new ApiError(404,'ADMIN_BACKUP_JOB_NOT_FOUND','Задание не найдено или срок хранения истёк.')
 return backupJobDto(row)
}
export async function backupsState(raw:unknown){
 const q=queryBase.extend({days:queryBase.shape.days.default(0),status:z.enum(['all','AVAILABLE','MISSING','INVALID','EXPIRED']).default('all')}).parse(raw)
 validatePeriod(q)
 const values=[searchPatterns(q.search),q.days,q.status,q.from??null,q.to??null],where=`${periodSql('created_at',2,4,5)} AND ($3='all' OR (CASE WHEN expires_at<=now() THEN 'EXPIRED' ELSE file_state END)=$3) AND ${matching(['id::text','sha256'])}`
 const [items,total,jobs,state]=await Promise.all([
  adminPool().query(`SELECT id,size_bytes,sha256,created_at,expires_at,verified_at,file_state,check_code,(SELECT jsonb_build_object('status',r.status,'checkedAt',r.checked_at,'durationMs',r.duration_ms,'schemaVersion',r.schema_version,'fullSet',r.checks->>'filesVerified'='true' AND r.checks->>'ledgerVerified'='true') FROM staffly_admin.restore_checks r WHERE r.backup_id=staffly_admin.backups.id ORDER BY r.checked_at DESC LIMIT 1) AS restore_check FROM staffly_admin.backups WHERE ${where} ORDER BY created_at DESC,id LIMIT $6 OFFSET $7`,[...values,pageSize,(q.page-1)*pageSize]),
  adminPool().query(`SELECT count(*)::int AS total FROM staffly_admin.backups WHERE ${where}`,values),
  adminPool().query('SELECT id,kind,backup_id,requested_by,status,attempts,created_at,started_at,finished_at,expires_at,error_code FROM staffly_admin.backup_jobs ORDER BY created_at DESC,id LIMIT 20'),
  adminPool().query(`SELECT maintenance_heartbeat,maintenance_stopped_at,(SELECT max(created_at)+interval '15 minutes' FROM staffly_admin.backup_jobs WHERE kind='CREATE') AS next_create_at,(SELECT count(*)::int FROM staffly_admin.backup_jobs WHERE status IN ('PENDING','RUNNING') AND expires_at>now()) AS queued,(SELECT max(verified_at) FROM staffly_admin.backups WHERE file_state='AVAILABLE' AND expires_at>now()) AS verified_at,(SELECT count(*)::int FROM staffly_admin.backups WHERE file_state='AVAILABLE' AND expires_at>now()) AS available FROM staffly_admin.management_state WHERE id=1`),
 ])
 const s=state.rows[0]
 return{items:items.rows.map(row=>({id:String(row.id),size:Number(row.size_bytes),sha256:String(row.sha256),createdAt:iso(row.created_at as Date),expiresAt:iso(row.expires_at as Date),verifiedAt:iso(row.verified_at as Date|null),state:effectiveBackupState(String(row.file_state),iso(row.expires_at)),checkCode:row.check_code?String(row.check_code):null,restoreCheck:row.restore_check??null})),total:total.rows[0].total,page:q.page,pageSize,retentionDays:30,workerOnline:!s.maintenance_stopped_at&&Boolean(s.maintenance_heartbeat)&&Date.now()-+new Date(s.maintenance_heartbeat)<45000,lastHeartbeat:iso(s.maintenance_heartbeat),nextCreateAt:iso(s.next_create_at),queued:s.queued,available:s.available,lastVerifiedAt:iso(s.verified_at),jobs:jobs.rows.map(backupJobDto)}
}
export async function alertsState(raw:unknown){
 const q=queryBase.extend({status:z.enum(['all','open','new','acknowledged','resolved']).default('open'),severity:z.enum(['all','warning','critical']).default('all')}).parse(raw)
 validatePeriod(q)
 const terms=q.search.toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean),keys=Object.entries(alertCatalog).filter(([key,value])=>terms.every(term=>(key+' '+value.title+' '+value.description).toLocaleLowerCase('ru-RU').includes(term))).map(([key])=>key)
 const values=[searchPatterns(q.search),q.days,q.status,keys,q.severity,q.from??null,q.to??null]
 const where=`(${periodSql('a.first_seen_at',2,6,7)} OR ($6::timestamptz IS NULL AND $7::timestamptz IS NULL AND a.resolved_at IS NULL)) AND ($3='all' OR $3='open' AND a.resolved_at IS NULL OR $3='new' AND a.resolved_at IS NULL AND a.acknowledged_at IS NULL OR $3='acknowledged' AND a.resolved_at IS NULL AND a.acknowledged_at IS NOT NULL OR $3='resolved' AND a.resolved_at IS NOT NULL) AND (${matching(['a.id::text','r.key'])} OR r.key=ANY($4::text[])) AND ($5='all' OR r.severity=$5)`
 const source="FROM staffly_admin.alerts a JOIN staffly_admin.alert_rules r ON r.id=a.rule_id LEFT JOIN staffly_admin.administrator_directory d ON d.user_id=a.acknowledged_by LEFT JOIN staffly_admin.work_directory w ON w.subject_kind='alert' AND w.subject_id=a.id"
 const [items,total,rules,state,summary]=await Promise.all([
  adminPool().query(`SELECT a.*,r.key,r.severity,d.display_name AS acknowledged_name,w.assignee_id,w.assignee_name,w.assignee_available ${source} WHERE ${where} ORDER BY a.resolved_at IS NULL DESC,r.severity='critical' DESC,a.first_seen_at DESC,a.id LIMIT $8 OFFSET $9`,[...values,pageSize,(q.page-1)*pageSize]),
  adminPool().query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE a.resolved_at IS NULL AND a.acknowledged_at IS NULL)::int AS unread,count(*) FILTER(WHERE a.resolved_at IS NULL AND r.severity='critical')::int AS critical,count(*) FILTER(WHERE a.resolved_at IS NOT NULL)::int AS resolved ${source} WHERE ${where}`,values),
  adminPool().query('SELECT id,key,enabled,severity,threshold,minimum,maximum,required,version,updated_at,measured,checked_at FROM staffly_admin.alert_rules ORDER BY id'),
  adminPool().query('SELECT alerts_checked_at FROM staffly_admin.management_state WHERE id=1'),
  adminPool().query(`SELECT count(*) FILTER(WHERE a.resolved_at IS NULL)::int AS open,count(*) FILTER(WHERE a.resolved_at IS NULL AND a.acknowledged_at IS NULL)::int AS unread,count(*) FILTER(WHERE a.resolved_at IS NULL AND r.severity='critical')::int AS critical,count(*) FILTER(WHERE a.resolved_at IS NOT NULL)::int AS resolved FROM staffly_admin.alerts a JOIN staffly_admin.alert_rules r ON r.id=a.rule_id WHERE ${periodSql('a.first_seen_at',1,2,3)} OR ($2::timestamptz IS NULL AND $3::timestamptz IS NULL AND a.resolved_at IS NULL)`,[q.days,q.from??null,q.to??null]),
 ])
 return{items:items.rows.map(row=>({id:String(row.id),ruleId:String(row.rule_id),key:String(row.key),severity:String(row.severity),measured:Number(row.measured),threshold:Number(row.threshold),firstSeenAt:iso(row.first_seen_at as Date),lastSeenAt:iso(row.last_seen_at as Date),resolvedAt:iso(row.resolved_at as Date|null),acknowledgedAt:iso(row.acknowledged_at as Date|null),acknowledgedBy:row.acknowledged_by?String(row.acknowledged_by):null,acknowledgedName:row.acknowledged_by?String(row.acknowledged_name??'Неактивный администратор'):null,assigneeName:row.assignee_id?String(row.assignee_name??'Неактивный администратор'):null,assigneeAvailable:Boolean(row.assignee_available)})),total:total.rows[0].total,page:q.page,pageSize,summary:summary.rows[0],checkedAt:iso(state.rows[0].alerts_checked_at),rules:rules.rows.map(row=>({id:String(row.id),key:String(row.key),enabled:Boolean(row.enabled),severity:String(row.severity),threshold:Number(row.threshold),minimum:Number(row.minimum),maximum:Number(row.maximum),measured:row.measured===null?null:Number(row.measured),checkedAt:iso(row.checked_at as Date|null),required:Boolean(row.required),version:Number(row.version),updatedAt:iso(row.updated_at as Date)}))}
}
