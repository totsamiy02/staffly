import { z } from 'zod'
import { databasePool, prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { activePresenceSql } from './collection.ts'
import { adminPool } from './database.ts'
import { effectiveSubscription, type SubscriptionRecord } from '../../app/subscriptions/plans.ts'

const querySchema=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),search:z.string().trim().max(120).default(''),plan:z.enum(['ALL','FREE','TEAM','BUSINESS']).default('ALL'),status:z.enum(['all','online','attention','verified','pending']).default('all'),sort:z.enum(['newest','online']).default('newest')})
const rangeSchema=z.object({days:z.coerce.number().int().refine(v=>[0,1,7,30,90,180,365].includes(v)).default(1)})
const limit=20
const activeSession=`s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now()`
const onlineSession=`${activeSession} AND s.last_active_at>now()-interval '90 seconds'`
const planSql=`CASE WHEN sub.next_plan IS NOT NULL AND sub.next_starts_at<=now() THEN sub.next_plan ELSE COALESCE(sub.plan,'FREE') END`
const untilSql=`CASE WHEN sub.next_plan IS NOT NULL AND sub.next_starts_at<=now() THEN sub.next_ends_at ELSE sub.period_end END`
const effectivePlanSql=`CASE WHEN (${planSql})='FREE' THEN 'FREE' WHEN (sub.next_plan IS NULL OR sub.next_starts_at IS NULL OR sub.next_starts_at>now()) AND sub.trial_ends_at>now() THEN (${planSql}) WHEN (${untilSql})+interval '7 days'>now() THEN (${planSql}) ELSE 'FREE' END`
const escapeSearch=(search:string)=>/^#?[1-9]\d{0,9}$/.test(search.trim())?search.trim().replace(/^#/,''):'%'+search.replace(/[\\%_]/g,'\\$&')+'%'
const iso=(value:Date|string|null|undefined)=>value?new Date(value).toISOString():null
const number=(value:unknown)=>Number(value??0)
type Row=Record<string,unknown>
function organizationDto(row:Row){
 const record:SubscriptionRecord={plan:String(row.plan??'FREE'),periodStart:row.period_start as Date|null,periodEnd:row.period_end as Date|null,trialEndsAt:row.trial_ends_at as Date|null,trialStartedAt:row.trial_started_at as Date|null,nextPlan:row.next_plan as string|null,nextStartsAt:row.next_starts_at as Date|null,nextEndsAt:row.next_ends_at as Date|null}
 const subscription=effectiveSubscription(record)
 return {id:String(row.id),publicId:Number(row.public_id),name:String(row.name),timezone:String(row.timezone),createdAt:iso(row.created_at as Date),lastActiveAt:iso(row.last_active_at as Date|null),members:number(row.members),locations:number(row.locations),storageBytes:number(row.storage_bytes),online:number(row.online),onlineSessions:number(row.online_sessions),subscription,attention:number(row.members)>=subscription.limits.members*.8||number(row.locations)>=subscription.limits.locations*.8||number(row.storage_bytes)>=subscription.limits.storageBytes*.8}
}
const organizationSelect=`SELECT o.id,o.public_id,o.name,o.timezone,o.created_at,sub.plan,sub.period_start,sub.period_end,sub.trial_ends_at,sub.trial_started_at,sub.next_plan,sub.next_starts_at,sub.next_ends_at,
 COALESCE(b.storage_bytes,0) AS storage_bytes,
 (SELECT count(*)::int FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=o.id AND m.left_at IS NULL AND u.deleted_at IS NULL) AS members,
 (SELECT count(*)::int FROM organization_locations l WHERE l.organization_id=o.id AND l.archived_at IS NULL) AS locations,
 (SELECT count(DISTINCT p.user_id)::int ${activePresenceSql} AND p.organization_id=o.id) AS online,
 (SELECT count(DISTINCT p.session_id)::int ${activePresenceSql} AND p.organization_id=o.id) AS online_sessions,
 a.last_active_at
 FROM organizations o LEFT JOIN organization_subscriptions sub ON sub.organization_id=o.id LEFT JOIN organization_resource_budgets b ON b.organization_id=o.id LEFT JOIN platform_organization_activity a ON a.organization_id=o.id`
export async function monitoringOrganizations(raw:unknown){
 const q=querySchema.parse(raw), parameters=[escapeSearch(q.search),q.plan]
 // Filtering stays before count/pagination, including effective plan after expiry.
 const conditions=`o.deleted_at IS NULL AND (o.name ILIKE $1 OR o.id::text ILIKE $1 OR o.public_id::text ILIKE $1) AND ($2='ALL' OR (${effectivePlanSql})=$2)`
 const extra=q.status==='online'?' AND item.online>0':q.status==='attention'?` AND (item.members>=CASE item.effective_plan WHEN 'BUSINESS' THEN 80 WHEN 'TEAM' THEN 20 ELSE 4 END OR item.locations>=CASE item.effective_plan WHEN 'BUSINESS' THEN 8 WHEN 'TEAM' THEN 2.4 ELSE .8 END OR item.storage_bytes>=item.storage_limit*.8)`:''
 const source=`WITH item AS (${organizationSelect}, LATERAL (SELECT (${effectivePlanSql}) AS effective_plan, CASE (${effectivePlanSql}) WHEN 'BUSINESS' THEN 10737418240::bigint WHEN 'TEAM' THEN 2147483648::bigint ELSE 262144000::bigint END AS storage_limit) limits WHERE ${conditions})`
 // organizationSelect columns intentionally contain only monitoring metadata.
 const selectSource=source.replace('SELECT o.id,o.name','SELECT limits.effective_plan,limits.storage_limit,o.id,o.name')
 const {rows:[count]}=await databasePool.query(`${selectSource} SELECT count(*)::int AS total FROM item WHERE true${extra}`,parameters)
 const {rows}=await databasePool.query(`${selectSource} SELECT * FROM item WHERE true${extra} ORDER BY ${q.sort==='online'?'online DESC,':''}created_at DESC,id DESC LIMIT $3 OFFSET $4`,[...parameters,limit,(q.page-1)*limit])
 return {items:rows.map(organizationDto),total:count.total,page:q.page,pageSize:limit}
}
export async function onlineSummary(){
 const [{rows:[sessions]},{rows:[orgs]}]=await Promise.all([
  databasePool.query(`SELECT count(DISTINCT s.user_id)::int AS users,count(*)::int AS sessions FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND ${onlineSession}`),
  databasePool.query(`SELECT count(DISTINCT p.organization_id)::int AS organizations ${activePresenceSql}`),
 ])
 return {...sessions,...orgs,at:new Date().toISOString()}
}
async function monitoringStarted(){const {rows:[row]}=await databasePool.query('SELECT started_at FROM platform_monitoring_state WHERE id=1');return iso(row.started_at)}
async function samples(days:number){
 const unit=days===0||days>30?'day':days>1?'hour':'minute'
 const {rows}=await databasePool.query(`SELECT date_trunc($2,bucket) AS at,round(avg(users_count))::int AS users,round(avg(organizations_count))::int AS organizations,round(avg(sessions_count))::int AS sessions FROM platform_online_samples WHERE ($1::int=0 OR bucket>=now()-$1*interval '1 day') GROUP BY 1 ORDER BY 1`,[days,unit]);return rows
}
export async function monitoringOverview(raw:unknown){
 const {days}=rangeSchema.parse(raw)
 const [{rows:[totals]},online,history,organizations,latest,startedAt]=await Promise.all([
  databasePool.query(`SELECT (SELECT count(*)::int FROM organizations WHERE deleted_at IS NULL) AS organizations,
   (SELECT count(*)::int FROM organizations WHERE deleted_at IS NULL AND created_at>now()-interval '30 days') AS new_organizations,
   (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,
   (SELECT count(*)::int FROM users WHERE deleted_at IS NULL AND created_at>now()-interval '30 days') AS new_users,
   (SELECT count(DISTINCT a.organization_id)::int FROM platform_activity_days a JOIN organizations o ON o.id=a.organization_id AND o.deleted_at IS NULL WHERE a.day>=(now() AT TIME ZONE 'Europe/Moscow')::date-29) AS active_month`),
  onlineSummary(),samples(days),monitoringOrganizations({status:'online',sort:'online'}),monitoringOrganizations({}),monitoringStarted(),
 ])
 return {totals,online,history,onlineOrganizations:organizations.items.slice(0,4),newOrganizations:latest.items.slice(0,4),startedAt,days}
}
export async function monitoringOrganization(id:string,raw:unknown={}){
 const {days}=rangeSchema.parse({...raw as object,days:(raw as {days?:unknown})?.days??30})
 const {rows:[row]}=await databasePool.query(`${organizationSelect} WHERE o.id=$1 AND o.deleted_at IS NULL`,[id])
 if(!row)throw new ApiError(404,'ADMIN_ORGANIZATION_NOT_FOUND','Организация не найдена.')
 const [owner,{rows:daily},{rows:features},events]=await Promise.all([
  prisma.organizationMember.findFirst({where:{organizationId:id,role:'OWNER',leftAt:null,user:{deletedAt:null}},select:{user:{select:{firstName:true,lastName:true}}}}),
  databasePool.query(`SELECT day::text AS day,count(DISTINCT user_id)::int AS users FROM platform_activity_days WHERE organization_id=$1 AND ($2::int=0 OR day>=(now() AT TIME ZONE 'Europe/Moscow')::date-($2-1)) GROUP BY day ORDER BY day`,[id,days]),
  databasePool.query(`SELECT feature,count(*)::int AS days FROM platform_feature_days WHERE organization_id=$1 AND ($2::int=0 OR day>=(now() AT TIME ZONE 'Europe/Moscow')::date-($2-1)) GROUP BY feature`,[id,days]),
  prisma.securityEvent.findMany({where:{organizationId:id,expiresAt:{gt:new Date()}},select:{action:true,outcome:true,createdAt:true},orderBy:[{createdAt:'desc'},{id:'desc'}],take:12}),
 ])
 return {...organizationDto(row),ownerName:owner?[owner.user.lastName,owner.user.firstName].filter(Boolean).join(' ')||'Владелец организации':null,daily,features,events,startedAt:await monitoringStarted()}
}
function maskEmail(email:string){const at=email.lastIndexOf('@');return `${email.slice(0,1)}•••${email.slice(at)}`}
const userSelect=`SELECT u.id,u.public_id,u.email,u.first_name,u.last_name,u.created_at,u.email_verified_at,u.last_seen_at,
 (SELECT count(*)::int FROM organization_members m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=u.id AND m.left_at IS NULL AND o.deleted_at IS NULL) AS organizations,
 (SELECT count(*)::int FROM auth_sessions s WHERE s.user_id=u.id AND ${activeSession}) AS sessions,
 EXISTS(SELECT 1 FROM auth_sessions s WHERE s.user_id=u.id AND ${onlineSession}) AS online FROM users u`
function userDto(row:Row){return {id:String(row.id),publicId:Number(row.public_id),displayName:[row.last_name,row.first_name].filter(Boolean).join(' ')||'Пользователь',email:maskEmail(String(row.email)),createdAt:iso(row.created_at as Date),emailVerified:Boolean(row.email_verified_at),lastSeenAt:iso(row.last_seen_at as Date|null),organizations:number(row.organizations),sessions:number(row.sessions),online:Boolean(row.online)}}
export async function monitoringUsers(raw:unknown){
 const q=querySchema.parse(raw),search=escapeSearch(q.search)
 const condition=`u.deleted_at IS NULL AND (u.email ILIKE $1 OR concat_ws(' ',u.last_name,u.first_name) ILIKE $1 OR u.id::text ILIKE $1 OR u.public_id::text ILIKE $1)${q.status==='verified'?' AND u.email_verified_at IS NOT NULL':q.status==='pending'?' AND u.email_verified_at IS NULL':q.status==='online'?` AND EXISTS(SELECT 1 FROM auth_sessions s WHERE s.user_id=u.id AND ${onlineSession})`:''}`
 const [{rows},{rows:[count]},{rows:[totals]}]=await Promise.all([
  databasePool.query(`${userSelect} WHERE ${condition} ORDER BY u.created_at DESC,u.id DESC LIMIT $2 OFFSET $3`,[search,limit,(q.page-1)*limit]),
  databasePool.query(`SELECT count(*)::int AS total FROM users u WHERE ${condition}`,[search]),
  databasePool.query(`SELECT count(*) FILTER(WHERE deleted_at IS NULL)::int AS users,count(*) FILTER(WHERE deleted_at IS NULL AND email_verified_at IS NOT NULL)::int AS verified,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted FROM users`),
 ])
 return {items:rows.map(userDto),total:count.total,page:q.page,pageSize:limit,totals,online:await onlineSummary()}
}
export async function monitoringUser(id:string,raw:unknown={}){
 const {page,search}=querySchema.parse(raw)
 const {rows:[row]}=await databasePool.query(`${userSelect} WHERE u.id=$1 AND u.deleted_at IS NULL`,[id])
 if(!row)throw new ApiError(404,'ADMIN_USER_NOT_FOUND','Пользователь не найден.')
 const memberships=await prisma.organizationMember.findMany({where:{userId:id,leftAt:null,organization:{deletedAt:null,name:{contains:search,mode:'insensitive'}}},take:20,skip:(page-1)*20,orderBy:{joinedAt:'desc'},select:{role:true,organization:{select:{id:true,name:true}}}})
 const membershipsTotal=await prisma.organizationMember.count({where:{userId:id,leftAt:null,organization:{deletedAt:null,name:{contains:search,mode:'insensitive'}}}})
 const grant=(await adminPool().query('SELECT enabled FROM staffly_admin.accounts WHERE user_id=$1',[id])).rows[0]
 return {...userDto(row),platformAdmin:grant?.enabled?'active':grant?'revoked':'none',memberships:memberships.map(m=>({id:m.organization.id,name:m.organization.name,role:m.role})),membershipsTotal,page,pageSize:20}
}
export async function monitoringOnline(raw:unknown){
 const q=querySchema.parse(raw)
 const [online,organizations,history,{rows:[peak]},{rows:plans},startedAt]=await Promise.all([
  onlineSummary(),monitoringOrganizations({...q,status:'online',sort:'online'}),samples(1),
  databasePool.query(`SELECT max(users_count)::int AS users FROM platform_online_samples WHERE (bucket AT TIME ZONE 'Europe/Moscow')::date=(now() AT TIME ZONE 'Europe/Moscow')::date`),
  databasePool.query(`SELECT (${effectivePlanSql}) AS plan,count(DISTINCT o.id)::int AS count FROM organizations o LEFT JOIN organization_subscriptions sub ON sub.organization_id=o.id WHERE o.id IN(SELECT DISTINCT p.organization_id ${activePresenceSql}) GROUP BY 1`),monitoringStarted(),
 ])
 return {online,organizations,history,peak:Math.max(online.users,peak.users??0),plans,startedAt}
}
export async function monitoringAnalytics(raw:unknown){
 const {days}=rangeSchema.parse({...raw as object,days:(raw as {days?:unknown})?.days??30})
 const [{rows:[totals]},{rows:daily},{rows:features},{rows:[funnel]},{rows:cohorts},startedAt]=await Promise.all([
  databasePool.query(`SELECT count(DISTINCT a.organization_id) FILTER(WHERE a.day=(now() AT TIME ZONE 'Europe/Moscow')::date)::int AS day,
   count(DISTINCT a.organization_id) FILTER(WHERE a.day>=(now() AT TIME ZONE 'Europe/Moscow')::date-6)::int AS week,
   count(DISTINCT a.organization_id)::int AS month FROM platform_activity_days a JOIN organizations o ON o.id=a.organization_id AND o.deleted_at IS NULL WHERE a.day>=(now() AT TIME ZONE 'Europe/Moscow')::date-29`),
  databasePool.query(`SELECT a.day::text AS day,count(DISTINCT a.organization_id)::int AS organizations FROM platform_activity_days a JOIN organizations o ON o.id=a.organization_id AND o.deleted_at IS NULL WHERE ($1::int=0 OR a.day>=(now() AT TIME ZONE 'Europe/Moscow')::date-($1::int-1)) GROUP BY a.day ORDER BY a.day`,[days]),
  databasePool.query(`SELECT f.feature,count(DISTINCT f.organization_id)::int AS organizations FROM platform_feature_days f JOIN organizations o ON o.id=f.organization_id AND o.deleted_at IS NULL WHERE ($1::int=0 OR f.day>=(now() AT TIME ZONE 'Europe/Moscow')::date-($1::int-1)) GROUP BY f.feature`,[days]),
  databasePool.query(`SELECT count(*)::int AS created,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM organization_invites i WHERE i.organization_id=o.id))::int AS invited,
   count(*) FILTER(WHERE EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=o.id AND m.left_at IS NULL AND m.role<>'OWNER'))::int AS team,
   count(*) FILTER(WHERE EXISTS(SELECT 1 FROM work_shifts s WHERE s.organization_id=o.id AND s.cancelled_at IS NULL))::int AS schedule FROM organizations o WHERE o.deleted_at IS NULL`),
  databasePool.query(`WITH cohort AS (SELECT organization_id,min(day) AS first_day FROM platform_activity_days GROUP BY organization_id)
   SELECT date_trunc('week',c.first_day::timestamp)::date::text AS cohort,((a.day-c.first_day)/7)::int AS week,count(DISTINCT a.organization_id)::int AS organizations
   FROM cohort c JOIN platform_activity_days a ON a.organization_id=c.organization_id JOIN organizations o ON o.id=a.organization_id AND o.deleted_at IS NULL
   WHERE c.first_day>=(now() AT TIME ZONE 'Europe/Moscow')::date-42 AND a.day>=c.first_day AND a.day<c.first_day+42 GROUP BY 1,2 ORDER BY 1,2 LIMIT 42`),monitoringStarted(),
 ])
 const [{rows:[baseline]},{rows:deltas},{rows:registrations}]=await Promise.all([
 databasePool.query('SELECT * FROM platform_lifetime_metrics WHERE id=1'),
 databasePool.query('SELECT metric,count(*)::bigint AS count FROM platform_creation_events GROUP BY metric'),
 databasePool.query(`WITH registrations AS (SELECT created_at,'users' AS kind FROM users UNION ALL SELECT created_at,'organizations' FROM organizations) SELECT date_trunc(CASE WHEN $1::int=0 OR $1>90 THEN 'month' ELSE 'day' END,created_at AT TIME ZONE 'Europe/Moscow')::date::text AS day,count(*) FILTER(WHERE kind='users')::int AS users,count(*) FILTER(WHERE kind='organizations')::int AS organizations FROM registrations WHERE ($1::int=0 OR created_at>=now()-$1*interval '1 day') GROUP BY 1 ORDER BY 1`,[days]),
 ])
 const lifetime=Object.fromEntries(['users','organizations','shifts','requests','documents','events'].map(metric=>[metric,Number(baseline[metric+'_created'])+Number(deltas.find(row=>row.metric===metric)?.count??0)]))
 return {totals,daily,features,funnel,cohorts,startedAt,days,timezone:'Europe/Moscow',lifetime,registrations}
}
