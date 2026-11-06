import { databasePool } from '../db.ts'
import { startBackgroundTask } from '../background-task.ts'

export async function recordOrganizationPresence(userId: string, sessionId: string, organizationId: string) {
  await recordOrganizationPresences([{userId,sessionId,organizationId}])
}
export async function recordOrganizationPresences(items:Array<{userId:string;sessionId:string;organizationId:string}>) {
  for(let offset=0;offset<items.length;offset+=500){
    // Existing batched SSE validation supplies visible tabs. Recheck tenant
    // membership and sessions in SQL; never attribute every membership as online.
    await databasePool.query(`WITH touched AS (
      INSERT INTO platform_organization_presence(session_id,organization_id,user_id,last_active_at)
      SELECT DISTINCT s.id,m.organization_id,s.user_id,now() FROM jsonb_to_recordset($1::jsonb) input(user_id uuid,session_id uuid,organization_id uuid)
      JOIN auth_sessions s ON s.id=input.session_id AND s.user_id=input.user_id
      JOIN users u ON u.id=s.user_id AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL
      JOIN organization_members m ON m.user_id=s.user_id AND m.organization_id=input.organization_id AND m.left_at IS NULL
      JOIN organizations o ON o.id=m.organization_id AND o.deleted_at IS NULL
      WHERE s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now()
      ON CONFLICT(session_id,organization_id) DO UPDATE SET last_active_at=now() WHERE platform_organization_presence.last_active_at<now()-interval '20 seconds'
      RETURNING organization_id,user_id
    ), days AS (
      INSERT INTO platform_activity_days(organization_id,user_id,day) SELECT DISTINCT organization_id,user_id,(now() AT TIME ZONE 'Europe/Moscow')::date FROM touched ON CONFLICT DO NOTHING
    ) INSERT INTO platform_organization_activity(organization_id,last_active_at) SELECT DISTINCT organization_id,now() FROM touched ON CONFLICT(organization_id) DO UPDATE SET last_active_at=now()`,[JSON.stringify(items.slice(offset,offset+500).map(i=>({user_id:i.userId,session_id:i.sessionId,organization_id:i.organizationId})))])
  }
}
const featureWrites=new Map<string,Promise<void>>()
export async function recordFeature(organizationId: string, feature: string) {
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow'}).format(new Date()),key=`${organizationId}:${feature}:${day}`
  let pending=featureWrites.get(key)
  if(!pending){
    if(featureWrites.size>=10000)featureWrites.delete(featureWrites.keys().next().value!)
    pending=databasePool.query(`INSERT INTO platform_feature_days(organization_id,day,feature) SELECT id,(now() AT TIME ZONE 'Europe/Moscow')::date,$2 FROM organizations WHERE id=$1 AND deleted_at IS NULL ON CONFLICT DO NOTHING`,[organizationId,feature]).then(()=>{}).catch(error=>{featureWrites.delete(key);throw error})
    featureWrites.set(key,pending)
  }
  await pending
}
export const activePresenceSql=`FROM platform_organization_presence p
  JOIN auth_sessions presence_session ON presence_session.id=p.session_id AND presence_session.user_id=p.user_id AND presence_session.revoked_at IS NULL AND presence_session.idle_expires_at>now() AND presence_session.absolute_expires_at>now()
  JOIN users presence_user ON presence_user.id=p.user_id AND presence_user.deleted_at IS NULL AND presence_user.email_verified_at IS NOT NULL
  JOIN organizations presence_org ON presence_org.id=p.organization_id AND presence_org.deleted_at IS NULL
  JOIN organization_members presence_member ON presence_member.organization_id=p.organization_id AND presence_member.user_id=p.user_id AND presence_member.left_at IS NULL
  WHERE p.last_active_at>now()-interval '90 seconds'`
type MonitoringQuery = (sql: string) => Promise<unknown>
const queryMonitoring: MonitoringQuery = sql => databasePool.query(sql)
export async function collectMonitoringSample(query: MonitoringQuery = queryMonitoring) {
  await query(`INSERT INTO platform_online_samples(bucket,users_count,organizations_count,sessions_count)
    SELECT to_timestamp(floor(extract(epoch FROM now())/300)*300),
    (SELECT count(DISTINCT s.user_id)::int FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now() AND s.last_active_at>now()-interval '90 seconds'),
    count(DISTINCT p.organization_id)::int,
    (SELECT count(*)::int FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now() AND s.last_active_at>now()-interval '90 seconds') ${activePresenceSql}
    ON CONFLICT(bucket) DO NOTHING`)
}
const cleanupSteps = [
  ['MONITOR_CLEANUP_OPERATIONS', 'SELECT public.platform_cleanup_operations()'],
  ['MONITOR_CLEANUP_PRESENCE', "DELETE FROM platform_organization_presence WHERE last_active_at<now()-interval '1 day'"],
  ['MONITOR_CLEANUP_ONLINE', "DELETE FROM platform_online_samples WHERE bucket<now()-interval '180 days'"],
  ['MONITOR_CLEANUP_ACTIVITY', "DELETE FROM platform_activity_days WHERE day<(now() AT TIME ZONE 'Europe/Moscow')::date-180"],
  ['MONITOR_CLEANUP_FEATURES', "DELETE FROM platform_feature_days WHERE day<(now() AT TIME ZONE 'Europe/Moscow')::date-180"],
] as const
export async function collectMonitoringCycle(shouldContinue: () => boolean = () => true, cleanup = true, query: MonitoringQuery = queryMonitoring) {
  async function step(operation: string, work: () => Promise<unknown>) {
    try { await work() }
    catch (cause) { throw Object.assign(new Error('Monitoring collection failed', { cause }), { operation }) }
  }
  if (!shouldContinue()) return false
  await step('MONITOR_SAMPLE', () => collectMonitoringSample(query))
  if (!cleanup) return false
  for (const [operation, sql] of cleanupSteps) {
    if (!shouldContinue()) return false
    await step(operation, () => query(sql))
  }
  return true
}
export function startMonitoringCollection() {
  let cleanedAt=0
  return startBackgroundTask({name:'Platform monitoring',intervalMs:30000,run:async shouldContinue=>{
    if (await collectMonitoringCycle(shouldContinue, Date.now()-cleanedAt>=3600000)) cleanedAt=Date.now()
  }})
}
