import { searchPatterns,matching } from '../search.ts'
import { z } from 'zod'
import { adminPool } from '../database.ts'
import { periodFields,periodSql,validatePeriod } from '../period.ts'
import { databasePool } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { safeError } from '../../security/safe-error.ts'
import { fillHistory } from '../../../shared/monitoring-history.ts'
import { historyRange } from '../history.ts'

const query=z.object({...periodFields,attention:z.enum(['all','yes']).default('all'),assignment:z.enum(['all','assigned','unassigned']).default('all'),level:z.enum(['all','actionable']).default('all'),page:z.coerce.number().int().min(1).max(10000).default(1),search:z.string().trim().max(120).default(''),kind:z.enum(['all','email','report','request']).default('all'),status:z.enum(['all','PENDING','RUNNING','SCHEDULED','RETRY','DONE','FAILED','SKIPPED']).default('all'),days:z.coerce.number().int().refine(n=>[0,1,7,30].includes(n)).default(30),source:z.preprocess(v=>v==='jobs'?'all':v,z.enum(['all','request','client','email','report','worker']).default('all')),organizationId:z.uuid().optional(),userId:z.uuid().optional()})
const pageSize=20
const iso=(value:Date|string|null)=>value?new Date(value).toISOString():null
export const taskLabels:Record<string,string>={'Admin alerts':'Проверка оповещений','Backup maintenance':'Резервные копии','Platform monitoring':'Сбор мониторинга','Data retention':'Очистка устаревших данных','Pending image cleanup':'Очистка файлов','OAuth cleanup':'Очистка подтверждений входа','Request maintenance':'Обслуживание заявок','Event start notifications':'Уведомления о событиях','Email worker':'Доставка писем','Report exports':'Подготовка отчётов','Subscription reminders':'Напоминания о подписке','Rate counter cleanup':'Очистка лимитов','Worker health':'Проверка фонового процесса','Operations telemetry':'Диагностика процессов'}
const n=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
const task=z.object({name:z.string().max(80),intervalMs:n,startedAt:z.iso.datetime(),finishedAt:z.iso.datetime().nullable(),lastSuccessAt:z.iso.datetime().nullable(),failures:n,runs:n,running:z.boolean(),durationMs:n,error:z.unknown().nullable()})
const snapshot=z.object({rss:n,heapUsed:n,heapTotal:n,uptime:n,pool:z.object({total:n,idle:n,waiting:n}),http:z.object({requests:n,errors:n,active:n,meanMs:n}).nullable(),tasks:z.array(task).max(40),droppedErrors:n,config:z.object({backgroundWorkers:z.boolean(),emailConfigured:z.boolean(),emailPaused:z.boolean(),storage:z.enum(['local','s3']),fileProcessing:z.enum(['service','process','unconfigured'])})})
type Row=Record<string,unknown>
function nodeDto(row:Row){
  const parsed=snapshot.safeParse(row.snapshot),state=row.stopped_at?'stopped':Date.now()-+new Date(row.heartbeat_at as Date)>45000?'offline':!parsed.success?'unknown':row.ready&&parsed.data.config.fileProcessing!=='unconfigured'?'healthy':'warning'
  const value=parsed.success?parsed.data:null
  return{id:String(row.id),role:row.role==='worker'?'worker':'api',startedAt:iso(row.started_at as Date),heartbeatAt:iso(row.heartbeat_at as Date),stoppedAt:iso(row.stopped_at as Date|null),state,
    snapshot:value?{...value,tasks:value.tasks.filter(t=>Object.hasOwn(taskLabels,t.name)).map(t=>({...t,label:taskLabels[t.name],error:t.error?safeError(t.error):null}))}:null}
}
export async function serviceStatus(){
  const range={...historyRange(1,new Date().toISOString()),stepMs:3600000}
  const start=performance.now();await databasePool.query('SELECT 1');const databaseMs=Math.round((performance.now()-start)*10)/10
  const [nodes,stats,history,backup]=await Promise.all([
    databasePool.query(`SELECT id,role,started_at,heartbeat_at,stopped_at,ready,snapshot FROM platform_runtime_nodes WHERE heartbeat_at>now()-interval '24 hours' ORDER BY stopped_at IS NULL DESC,heartbeat_at DESC LIMIT 50`),
    databasePool.query(`SELECT (SELECT count(*)::int FROM platform_request_errors WHERE source='request' AND status>=500 AND created_at>now()-interval '24 hours') AS errors,
      (SELECT count(*)::int FROM email_deliveries WHERE status='FAILED' AND created_at>now()-interval '24 hours') AS email_failed,(SELECT max(delivered_at) FROM email_deliveries WHERE status='SENT' AND delivered_at>now()-interval '24 hours') AS last_delivery_at,
      (SELECT count(*)::int FROM report_exports WHERE status='FAILED' AND expires_at>now()) AS report_failed`),
    databasePool.query(`SELECT date_trunc('hour',created_at) AS at,count(*)::int AS errors FROM platform_request_errors WHERE source='request' AND status>=500 AND created_at>now()-interval '24 hours' GROUP BY 1 ORDER BY 1`),
    adminPool().query("SELECT r.threshold,b.created_at,b.verified_at FROM staffly_admin.alert_rules r LEFT JOIN LATERAL(SELECT created_at,verified_at FROM staffly_admin.backups WHERE file_state='AVAILABLE' AND verified_at IS NOT NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1)b ON true WHERE r.key='BACKUP_STALE'"),
  ])
  const items=nodes.rows.map(nodeDto),live=items.filter(v=>!['offline','stopped','unknown'].includes(v.state)),apis=live.filter(v=>v.role==='api'),workers=live.filter(v=>v.role==='worker'||v.snapshot?.config.backgroundWorkers)
  const needsAttention=items.some(v=>v.state==='offline'||v.state==='warning'||v.state==='unknown')||live.some(v=>v.snapshot?.tasks.some(t=>t.failures>=3))
  const configs=live.flatMap(node=>node.snapshot?[node.snapshot.config]:[]),mailConfigured=configs.length>0&&configs.every(config=>config.emailConfigured),mailPaused=configs.some(config=>config.emailPaused),missingFiles=configs.some(config=>config.fileProcessing==='unconfigured')
  const freshBackup=backup.rows[0]?.created_at&&Date.now()-+new Date(backup.rows[0].created_at)<Number(backup.rows[0]?.threshold??24)*3600000
  const connections=[
   {key:'api',title:'API',state:apis.length?'working':'attention',label:apis.length?'Доступен':'Нет готового API',note:'Состояние по свежим сигналам процессов',href:'/admin/operations/service'},
   {key:'database',title:'База данных',state:'working',label:'Проверена',note:'Запрос выполнен при открытии страницы',href:null},
   {key:'mail',title:'Доставка писем',state:mailPaused||!mailConfigured||stats.rows[0].email_failed?'attention':stats.rows[0].last_delivery_at?'working':'configured',label:mailPaused?'Приостановлена':!mailConfigured?'Не настроена':stats.rows[0].email_failed?'Есть недоставленные письма':stats.rows[0].last_delivery_at?'Доставка подтверждена':'Настроена',at:iso(stats.rows[0].last_delivery_at),note:stats.rows[0].last_delivery_at?'Последняя успешная доставка за сутки':'Наличие настроек не подтверждает доступность провайдера',href:'/admin/operations/jobs?kind=email&attention=yes'},
   {key:'files',title:'Файлы',state:missingFiles?'attention':configs.length?'configured':'unknown',label:missingFiles?'Обработка не настроена':configs.length?'Настроены':'Нет снимков',note:'Доступность файлового провайдера отдельно не проверялась',href:'/admin/operations/support?source=worker'},
   {key:'backups',title:'Резервирование',state:freshBackup?'working':'attention',label:freshBackup?'Есть свежая проверенная копия':'Нужна свежая копия',note:'Проверка целостности БД; восстановление и файлы проверяются отдельно',href:'/admin/management/backups'},
  ]
  return{connections,at:new Date().toISOString(),state:!items.length?'unknown':needsAttention||!apis.length||!workers.length||connections.some(connection=>connection.state==='attention')?'warning':'healthy',databaseMs,nodes:items,totals:{apis:apis.length,workers:workers.length,...stats.rows[0]},history:fillHistory(history.rows.map(r=>({at:iso(r.at),errors:r.errors})),['errors'],range),historyRange:range,retentionDays:30}
}
const emailState=`CASE WHEN e.status='PENDING' AND e.locked_until>now() THEN 'RUNNING' WHEN e.status='PENDING' AND e.available_at>now() THEN CASE WHEN e.attempts>0 THEN 'RETRY' ELSE 'SCHEDULED' END WHEN e.status='SENT' THEN 'DONE' ELSE e.status END`
const jobSource=`SELECT e.id,'email' AS kind,${emailState} AS status,e.attempts,7 AS max_attempts,e.created_at,e.available_at,e.locked_until AS lease_until,e.delivered_at AS finished_at,e.created_at+interval '1 day' AS expires_at,e.organization_id,e.user_id,e.source_kind AS category,e.last_error_code AS error_code,
  (e.status='FAILED' OR e.status='PENDING' AND e.available_at<now()-interval '5 minutes' AND (e.locked_until IS NULL OR e.locked_until<now())) AS attention,false AS can_retry
  FROM email_deliveries e
 UNION ALL
 SELECT j.id,'report',CASE WHEN j.status='READY' THEN 'DONE' ELSE j.status END,j.attempts,3,j.created_at,j.created_at,j.lease_until,NULL::timestamptz,j.expires_at,j.organization_id,j.user_id,'REPORT',j.error_code,
  (j.expires_at>now() AND (j.status='FAILED' OR j.status='RUNNING' AND j.lease_until<now() OR j.status='PENDING' AND j.created_at<now()-interval '5 minutes')),
  (j.status='FAILED' AND j.attempts<3 AND j.expires_at>now() AND j.error_code IN ('EXPORT_FAILED','EXPORT_INTERRUPTED','ORGANIZATION_STORAGE_QUOTA')) FROM report_exports j`
const categories:Record<string,string>={REPORT:'Выгрузка отчёта',MANDATORY:'Обязательное уведомление',EVENT:'Уведомление о событии',EVENT_START:'Начало события',DOCUMENT:'Документ',DOCUMENT_REMINDER:'Напоминание о документе',DRAFT:'Обсуждение расписания',DRAFT_REMINDER:'Напоминание о расписании',VACATION_REMINDER:'Выбор отпуска',REQUEST:'Обновление заявки',SHIFT:'Изменение смены',SUBSCRIPTION:'Подписка'}
const jobErrors:Record<string,string>={EXPORT_FAILED:'Не удалось подготовить отчёт',EXPORT_INTERRUPTED:'Подготовка прервана',EXPORT_EXPIRED:'Истёк срок подготовки',ORGANIZATION_STORAGE_QUOTA:'Хранилище организации заполнено',EAUTH:'Почтовый сервер отклонил авторизацию',ECONNECTION:'Нет соединения с почтовым сервером',ESOCKET:'Соединение с почтовым сервером прервано',ETIMEDOUT:'Почтовый сервер не ответил вовремя',EMAIL_DELIVERY_FAILED:'Не удалось доставить письмо'}
function jobDto(r:Row){return{id:String(r.id),kind:r.kind,status:r.status,attempts:Number(r.attempts),maxAttempts:Number(r.max_attempts),createdAt:iso(r.created_at as Date),availableAt:iso(r.available_at as Date),leaseUntil:iso(r.lease_until as Date|null),finishedAt:iso(r.finished_at as Date|null),expiresAt:iso(r.expires_at as Date),organizationPublicId:r.organization_public_id?Number(r.organization_public_id):null,userPublicId:r.user_public_id?Number(r.user_public_id):null,organizationId:r.organization_id?String(r.organization_id):null,organizationName:r.organization_name?String(r.organization_name):null,userId:String(r.user_id),userName:String(r.user_name??'Удалённый аккаунт'),category:categories[String(r.category)]??'Письмо',error:r.error_code?jobErrors[String(r.error_code)]??'Ошибка обработки':r.status==='FAILED'?'Доставка не завершена':null,attention:Boolean(r.attention),canRetry:Boolean(r.can_retry),diagnosticCode:r.error_code?String(r.error_code):null,lastFailure:r.failure_id?{id:String(r.failure_id),at:iso(r.failure_at as Date),code:r.failure_event_code?String(r.failure_event_code):null,diagnostic:r.failure_code?String(r.failure_code):null}:null}}
const joinedJobs=`WITH jobs AS (${jobSource}) SELECT j.*,o.public_id AS organization_public_id,u.public_id AS user_public_id,o.name AS organization_name,CASE WHEN u.deleted_at IS NULL THEN u.email END AS user_email,CASE WHEN u.deleted_at IS NULL THEN concat_ws(' ',u.last_name,u.first_name) ELSE 'Удалённый аккаунт' END AS user_name,f.id AS failure_id,f.created_at AS failure_at,f.event_code AS failure_event_code,f.code AS failure_code FROM jobs j LEFT JOIN LATERAL (SELECT id,created_at,event_code,code FROM platform_request_errors WHERE job_id=j.id ORDER BY created_at DESC LIMIT 1) f ON true LEFT JOIN organizations o ON o.id=j.organization_id LEFT JOIN users u ON u.id=j.user_id`
export async function backgroundJobs(raw:unknown){
  const q=query.parse(raw);validatePeriod(q);const params=[searchPatterns(q.search),q.kind,q.status,q.organizationId??null,q.userId??null,q.days,q.search,q.from??null,q.to??null,q.attention]
  const where=`(${periodSql('created_at',6,8,9)} OR ($8::timestamptz IS NULL AND $9::timestamptz IS NULL AND status IN ('PENDING','RUNNING','RETRY','SCHEDULED')) OR ($8::timestamptz IS NULL AND $9::timestamptz IS NULL AND id::text=lower($7))) AND ($10='all' OR attention) AND ($2='all' OR kind=$2) AND ($3='all' OR status=$3) AND ($4::uuid IS NULL OR organization_id=$4) AND ($5::uuid IS NULL OR user_id=$5)
    AND ${matching(['id::text','organization_name','organization_public_id::text','user_public_id::text','user_name','user_email','user_id::text','organization_id::text'])}`
  const source=`WITH items AS (${joinedJobs})`
  const [total,items,summary]=await Promise.all([
    databasePool.query(`${source} SELECT count(*)::int AS total FROM items WHERE ${where}`,params),
    databasePool.query(`${source} SELECT * FROM items WHERE ${where} ORDER BY attention DESC,created_at DESC,id LIMIT $11 OFFSET $12`,[...params,pageSize,(q.page-1)*pageSize]),
    databasePool.query(`${source} SELECT kind,status,count(*)::int AS count FROM items WHERE ${where} GROUP BY kind,status`,params),
  ])
  return{items:items.rows.map(jobDto),total:total.rows[0].total,page:q.page,pageSize,summary:summary.rows,days:q.days}
}
export async function backgroundJob(kind:'email'|'report',id:string){
  const {rows:[row]}=await databasePool.query(`SELECT * FROM (${joinedJobs}) item WHERE kind=$1 AND id=$2`,[kind,id])
  if(!row)throw new ApiError(404,'ADMIN_JOB_NOT_FOUND','Задача не найдена или срок хранения истёк.')
  return jobDto(row)
}
const errorSource=`SELECT (a.subject_id IS NOT NULL) AS assigned,e.id,e.source,e.event_code,e.job_id,e.attempt,e.max_attempts,e.next_attempt_at,e.task_name,e.created_at,e.status,e.method,e.route,e.name,e.code,e.user_id,e.organization_id,o.public_id AS organization_public_id,u.public_id AS user_public_id,o.name AS organization_name,CASE WHEN u.deleted_at IS NULL THEN u.email END AS user_email,
 CASE WHEN u.deleted_at IS NULL THEN concat_ws(' ',u.last_name,u.first_name) ELSE 'Удалённый аккаунт' END AS user_name
 FROM platform_request_errors e LEFT JOIN public.platform_assigned_diagnostics a ON a.subject_id=e.id LEFT JOIN organizations o ON o.id=e.organization_id LEFT JOIN users u ON u.id=e.user_id`
function errorDto(r:Row){const safe=safeError({name:r.name,code:r.code});return{assigned:Boolean(r.assigned),jobKind:r.source==='email'?'email':r.source==='report'?'report':r.task_name==='Backup maintenance'?'backup':null,id:String(r.id),kind:String(r.source??'request'),eventCode:r.event_code?String(r.event_code):null,jobId:r.job_id?String(r.job_id):null,attempt:r.attempt===null?null:Number(r.attempt),maxAttempts:r.max_attempts===null?null:Number(r.max_attempts),nextAttemptAt:iso(r.next_attempt_at as Date|null),taskName:r.task_name?taskLabels[String(r.task_name)]??'Фоновый цикл':null,createdAt:iso(r.created_at as Date),status:Number(r.status),method:String(r.method),route:/^\/[a-zA-Z0-9_/:.*()-]*$/.test(String(r.route))?String(r.route):'unmatched',diagnostic:safe,userId:r.user_id?String(r.user_id):null,userName:r.user_name?String(r.user_name):null,organizationPublicId:r.organization_public_id?Number(r.organization_public_id):null,userPublicId:r.user_public_id?Number(r.user_public_id):null,organizationId:r.organization_id?String(r.organization_id):null,organizationName:r.organization_name?String(r.organization_name):null}}
export async function supportErrors(raw:unknown){
  const q=query.parse(raw);validatePeriod(q);const parameters=[searchPatterns(q.search),q.days,q.organizationId??null,q.userId??null,q.source,q.search,q.from??null,q.to??null,q.assignment,q.level]
  const where=`(${periodSql('created_at',2,7,8)} OR ($7::timestamptz IS NULL AND $8::timestamptz IS NULL AND (id::text=lower($6) OR job_id::text=lower($6)))) AND ($9='all' OR ($9='assigned')=assigned) AND ($10='all' OR source='request' AND status>=500 OR source IN ('email','report','worker')) AND ($3::uuid IS NULL OR organization_id=$3) AND ($4::uuid IS NULL OR user_id=$4) AND ($5='all' OR source=$5) AND ${matching(['id::text','job_id::text','organization_name','organization_public_id::text','user_public_id::text','user_name','user_email','user_id::text','organization_id::text','code','event_code','route','task_name'])}`
  const [items,total,summary]=await Promise.all([
    databasePool.query(`SELECT * FROM (${errorSource}) item WHERE ${where} ORDER BY created_at DESC,id LIMIT $11 OFFSET $12`,[...parameters,pageSize,(q.page-1)*pageSize]),
    databasePool.query(`SELECT count(*)::int AS total,count(DISTINCT organization_id)::int AS organizations FROM (${errorSource}) item WHERE ${where}`,parameters),
    databasePool.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '1 hour')::int AS recent,count(*) FILTER(WHERE source='request' AND status>=500)::int AS server,count(*) FILTER(WHERE source IN ('email','report','worker'))::int AS background FROM (${errorSource}) item WHERE ${where}`,parameters),
  ])
  return{items:items.rows.map(errorDto),total:total.rows[0].total,page:q.page,pageSize,organizations:total.rows[0].organizations,summary:summary.rows[0],days:q.days}
}
export async function supportError(id:string){
  const {rows:[item]}=await databasePool.query(`SELECT * FROM (${errorSource}) item WHERE id=$1 OR job_id=$1 ORDER BY (id=$1) DESC,created_at DESC LIMIT 1`,[id])
  if(!item)throw new ApiError(404,'ADMIN_DIAGNOSTIC_NOT_FOUND','Запись не найдена. Проверьте код и период. Диагностика хранится 30 дней; сообщение с устройства без интернета появится после восстановления связи.')
  return errorDto(item)
}
