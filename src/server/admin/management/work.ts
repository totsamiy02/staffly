import type { Request } from 'express'
import { z } from 'zod'
import { databasePool } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { adminPool } from '../database.ts'
import { requireAdminSession } from '../security.ts'
import { iso,pageSize } from './schemas.ts'
export const workKind=z.enum(['alert','diagnostic'])
export async function workState(request:Request,kind:'alert'|'diagnostic',id:string){
 const page=z.coerce.number().int().min(1).max(10000).default(1).parse(request.query.page)
 const subject=kind==='alert'?await adminPool().query('SELECT resolved_at FROM staffly_admin.alerts WHERE id=$1',[id]):await databasePool.query("SELECT id FROM platform_request_errors WHERE id=$1 AND created_at>now()-interval '30 days'",[id])
 if(!subject.rowCount)throw new ApiError(404,'ADMIN_WORK_NOT_FOUND','Запись для разбора не найдена или срок хранения истёк.')
 const [current,history,total]=await Promise.all([
  adminPool().query('SELECT * FROM staffly_admin.work_directory WHERE subject_kind=$1 AND subject_id=$2',[kind,id]),
  adminPool().query('SELECT * FROM staffly_admin.work_history_directory WHERE subject_kind=$1 AND subject_id=$2 ORDER BY created_at DESC,id LIMIT $3 OFFSET $4',[kind,id,pageSize,(page-1)*pageSize]),
  adminPool().query('SELECT count(*)::int AS total FROM staffly_admin.work_history_directory WHERE subject_kind=$1 AND subject_id=$2',[kind,id]),
 ])
 const row=current.rows[0]
 return{version:Number(row?.version??0),assigneeId:row?.assignee_id??null,assigneePublicId:row?.assignee_public_id?Number(row.assignee_public_id):null,assigneeName:row?.assignee_id?row.assignee_name??'Неактивный администратор':null,assigneeAvailable:Boolean(row?.assignee_available),canAssign:kind!=='alert'||!subject.rows[0].resolved_at,
  history:{items:history.rows.map(h=>({id:h.id,at:iso(h.created_at),actorId:h.actor_id,actorPublicId:h.actor_public_id?Number(h.actor_public_id):null,actor:h.actor_name??'Неактивный администратор',from:h.from_assignee?h.from_name??'Неактивный администратор':'Не назначен',to:h.to_assignee?h.to_name??'Неактивный администратор':'Не назначен',version:Number(h.version)})),total:total.rows[0].total,page,pageSize}}
}
export async function assignWork(request:Request,kind:'alert'|'diagnostic',id:string){
 const body=z.object({assigneeId:z.uuid().nullable(),version:z.number().int().min(0).max(2147483647),confirm:z.literal(true)}).strict().parse(request.body)
 const {actor,session}=await requireAdminSession(request)
 const {rows:[value]}=await adminPool().query('SELECT * FROM staffly_admin.assign_work($1,$2,$3,$4,$5,$6,$7,$8)',[actor.userId,actor.authSessionId,session.id,session.token_hash,kind,id,body.assigneeId,body.version])
 if(value.result==='LOCKED')throw new ApiError(423,'ADMIN_LOCKED','Панель заблокирована. Введите PIN-код.')
 if(value.result==='FORBIDDEN')throw new ApiError(403,'ADMIN_AUTH_REQUIRED','Подтвердите административный вход заново.')
 if(value.result==='NOT_FOUND')throw new ApiError(409,'ADMIN_WORK_CLOSED','Запись удалена или оповещение уже устранено. Обновите данные.')
 if(value.result==='ASSIGNEE')throw new ApiError(409,'ADMIN_ASSIGNEE_UNAVAILABLE','У выбранного администратора больше нет действующего доступа.')
 if(value.result!=='OK')throw new ApiError(409,'ADMIN_WORK_CHANGED','Ответственный уже изменился. Обновите данные и повторите выбор.')
 await requireAdminSession(request)
 return{ok:true,version:Number(value.new_version)}
}
export async function alertDetails(id:string){
 const {rows:[row]}=await adminPool().query(`SELECT a.*,r.key,r.severity,r.enabled,
  d.display_name AS acknowledged_name,d.public_id AS acknowledged_public_id,
  w.assignee_id,w.assignee_name,w.assignee_public_id,w.assignee_available
  FROM staffly_admin.alerts a JOIN staffly_admin.alert_rules r ON r.id=a.rule_id
  LEFT JOIN staffly_admin.administrator_directory d ON d.user_id=a.acknowledged_by
  LEFT JOIN staffly_admin.work_directory w ON w.subject_kind='alert' AND w.subject_id=a.id WHERE a.id=$1`,[id])
 if(!row)throw new ApiError(404,'ADMIN_ALERT_NOT_FOUND','Оповещение не найдено или срок хранения истёк.')
 return{id:row.id,key:row.key,severity:row.severity,measured:Number(row.measured),threshold:Number(row.threshold),firstSeenAt:iso(row.first_seen_at),lastSeenAt:iso(row.last_seen_at),resolvedAt:iso(row.resolved_at),acknowledgedAt:iso(row.acknowledged_at),acknowledgedBy:row.acknowledged_by,acknowledgedName:row.acknowledged_by?row.acknowledged_name??'Неактивный администратор':null,assigneeName:row.assignee_id?row.assignee_name??'Неактивный администратор':null}
}
