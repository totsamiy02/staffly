import { z } from 'zod'
import { databasePool } from '../db.ts'
import { eventActionLabels } from '../../features/admin/event-labels.ts'
const schema=z.object({organizationId:z.uuid().optional(),userId:z.uuid().optional(),search:z.string().trim().max(120).default(''),outcome:z.enum(['all','SUCCEEDED','DENIED','FAILED']).default('all'),module:z.enum(['all','reports','planning','security','organization','members','locations','invitations','schedule','requests','documents','events','access','subscription']).default('all'),from:z.iso.date().optional(),to:z.iso.date().optional(),page:z.coerce.number().int().min(1).max(10000).default(1)})
export async function monitoringEvents(raw:unknown){
 const q=schema.parse(raw),search='%'+q.search.replace(/[\\%_]/g,'\\$&')+'%'
 const source=`WITH labels AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS l(action text,label text)), entries AS (
 SELECT id,organization_id,user_id,resource_id,action,outcome,created_at,'security' AS source,
 CASE resource_type WHEN 'DOCUMENT' THEN 'documents' WHEN 'ATTACHMENT' THEN 'requests' WHEN 'ACCESS' THEN 'access' WHEN 'LOCATION' THEN 'locations' WHEN 'MEMBER' THEN 'members' ELSE 'security' END AS module
 FROM security_events WHERE expires_at>now() AND ($2::uuid IS NULL OR organization_id=$2) AND ($3::uuid IS NULL OR user_id=$3)
 UNION ALL SELECT id,organization_id,user_id,resource_id,module||'_'||action,'SUCCEEDED',created_at,'operation',module FROM platform_operation_events WHERE expires_at>now() AND ($2::uuid IS NULL OR organization_id=$2) AND ($3::uuid IS NULL OR user_id=$3)
 ), filtered AS (SELECT e.*,COALESCE(l.label,'Действие безопасности') AS label,
 CASE WHEN e.user_id IS NULL THEN 'Системный журнал БД' ELSE COALESCE(NULLIF(trim(concat_ws(' ',u.last_name,u.first_name)),''),'Пользователь') END AS actor
 FROM entries e LEFT JOIN labels l ON l.action=e.action LEFT JOIN users u ON u.id=e.user_id
 WHERE ($4='all' OR e.outcome=$4) AND ($5='all' OR e.module=$5)
 AND ($6::date IS NULL OR e.created_at >= $6::date AT TIME ZONE 'Europe/Moscow') AND ($7::date IS NULL OR e.created_at < ($7::date+1) AT TIME ZONE 'Europe/Moscow')
 AND (COALESCE(l.label,'') ILIKE $8 OR e.action ILIKE $8 OR e.id::text ILIKE $8 OR e.resource_id::text ILIKE $8 OR e.user_id::text ILIKE $8 OR concat_ws(' ',u.last_name,u.first_name) ILIKE $8))`
 const args=[JSON.stringify(Object.entries(eventActionLabels).map(([action,label])=>({action,label}))),q.organizationId??null,q.userId??null,q.outcome,q.module,q.from??null,q.to??null,search]
 const [{rows},{rows:[count]}]=await Promise.all([databasePool.query(`${source} SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $9`,[...args,(q.page-1)*20]),databasePool.query(`${source} SELECT count(*)::int AS total FROM filtered`,args)])
 return {items:rows.map(row=>({id:row.id,organizationId:row.organization_id,userId:row.user_id,resourceId:row.resource_id,action:row.action,label:row.label,outcome:row.outcome,module:row.module,actor:row.actor,source:row.source,createdAt:row.created_at.toISOString()})),total:count.total,page:q.page,pageSize:20}
}
