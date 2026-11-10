import { verifiedReleaseChecks } from '../../../shared/release-check.ts'
import type { Request } from 'express'
import { z } from 'zod'
import { adminPool } from '../database.ts'
import { requireAdminSession } from '../security.ts'
import { backupSetState } from './read-model.ts'
import { actionError } from '../management/actions.ts'
export async function runtimeChecks(){
 const db=adminPool(),[schema,backup,release,workers]=await Promise.all([
  db.query('SELECT * FROM staffly_admin.release_schema_state'),
  backupSetState(),
  db.query("SELECT passed,checks,checked_at,schema_version FROM staffly_admin.release_checks WHERE app_version=$1 AND source='operator-ci' ORDER BY checked_at DESC LIMIT 1",[process.env.APP_VERSION||'development']),
  db.query('SELECT maintenance_heartbeat,maintenance_stopped_at FROM staffly_admin.management_state WHERE id=1')
 ])
 const checks={database:schema.rows[0]?.failed===0,backup:!!backup?.complete&&!!backup.recovery&&Date.now()-+new Date(backup.created_at)<86400000,release:!!release.rows[0]?.passed&&verifiedReleaseChecks(release.rows[0]?.checks,process.env.APP_VERSION||'development')&&release.rows[0].schema_version===schema.rows[0].version&&Date.now()-+new Date(release.rows[0].checked_at)<86400000,workers:!!workers.rows[0].maintenance_heartbeat&&!workers.rows[0].maintenance_stopped_at&&Date.now()-+new Date(workers.rows[0].maintenance_heartbeat)<45000}
 return{...checks,passed:Object.values(checks).every(Boolean),checkedAt:new Date().toISOString(),appVersion:process.env.APP_VERSION||'development',schemaVersion:schema.rows[0]?.version??null}
}
export async function checkMaintenance(request:Request,id:string){
 z.object({confirm:z.literal(true)}).strict().parse(request.body)
 const {actor,session}=await requireAdminSession(request),checks=await runtimeChecks()
 const {rows:[row]}=await adminPool().query('SELECT staffly_admin.record_runtime_checks($1,$2,$3,$4,$5,$6,$7,$8) AS result',[actor.userId,actor.authSessionId,session.id,session.token_hash,id,JSON.stringify(checks),checks.appVersion,checks.schemaVersion])
 if(row.result!=='OK')actionError(row.result)
 await requireAdminSession(request);return checks
}
