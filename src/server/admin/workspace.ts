import { z } from 'zod'
import { adminPool } from './database.ts'
import { monitoringUsers,monitoringOrganizations } from './monitoring.ts'
import { backgroundJobs,supportErrors } from './operations/read-model.ts'
export async function globalSearch(raw:unknown){
 const {search}=z.object({search:z.string().trim().min(1).max(120)}).parse(raw)
 const [users,organizations,jobs,errors]=await Promise.all([monitoringUsers({search}),monitoringOrganizations({search}),backgroundJobs({search,days:0}),supportErrors({search,days:0})])
 return{search,groups:[
  {key:'users',title:'Пользователи',total:users.total,href:'/admin/users?search='+encodeURIComponent(search),items:users.items.slice(0,5).map(user=>({id:user.id,title:`Пользователь №${user.publicId} · ${user.displayName}`,note:user.email,href:'/admin/users/'+user.id}))},
  {key:'organizations',title:'Организации',total:organizations.total,href:'/admin/organizations?search='+encodeURIComponent(search),items:organizations.items.slice(0,5).map(org=>({id:org.id,title:`Организация №${org.publicId} · ${org.name}`,note:org.subscription.effectivePlan,href:'/admin/organizations/'+org.id}))},
  {key:'diagnostics',title:'Ошибки и разборы',total:errors.total,href:'/admin/operations/support?days=0&search='+encodeURIComponent(search),items:errors.items.slice(0,5).map(error=>({id:error.id,title:`Код ошибки ${error.id}`,note:error.eventCode??error.diagnostic.code??(error.status?'HTTP '+error.status:'Служебный сбой'),href:'/admin/operations/support/'+error.id}))},
  {key:'jobs',title:'Фоновые задачи',total:jobs.total,href:'/admin/operations/jobs?days=0&search='+encodeURIComponent(search),items:jobs.items.slice(0,5).map(job=>({id:String(job.kind)+job.id,title:`Задача: ${job.category} · ${job.id}`,note:[job.organizationName,job.userName].filter(Boolean).join(' · '),href:`/admin/operations/jobs/${job.kind}/${job.id}`}))},
 ]}
}
export async function attentionState(){
 const [alerts,jobs,diagnostics,backup]=await Promise.all([
  adminPool().query("SELECT a.id,r.key,count(*) OVER()::int AS total FROM staffly_admin.alerts a JOIN staffly_admin.alert_rules r ON r.id=a.rule_id WHERE a.resolved_at IS NULL AND r.severity='critical' ORDER BY a.first_seen_at DESC,a.id LIMIT 3"),
  backgroundJobs({attention:'yes',days:1}),supportErrors({assignment:'unassigned',level:'actionable',days:1}),
  adminPool().query("SELECT r.threshold,b.id,b.created_at,b.verified_at FROM staffly_admin.alert_rules r LEFT JOIN LATERAL(SELECT id,created_at,verified_at FROM staffly_admin.backups WHERE file_state='AVAILABLE' AND verified_at IS NOT NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1)b ON true WHERE r.key='BACKUP_STALE'"),
 ])
 const copy=backup.rows[0],ageHours=copy?.created_at?(Date.now()-+new Date(copy.created_at))/3600000:null
 return{critical:{total:alerts.rows[0]?.total??0,items:alerts.rows.map(row=>({id:row.id,key:row.key}))},jobs:{total:jobs.total,items:jobs.items.slice(0,3)},unassigned:{total:diagnostics.total,items:diagnostics.items.slice(0,3)},backup:{id:copy?.id??null,createdAt:copy?.created_at?.toISOString()??null,ageHours,stale:ageHours===null||ageHours>=Number(copy?.threshold??24)}}
}
