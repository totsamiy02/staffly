import { createHash,randomBytes,randomInt,randomUUID } from 'node:crypto'
import type { Request,Response } from 'express'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { verifyLoginPassword } from '../../auth/passwords.ts'
import { reserveAuthAttempt,clearAuthAttempts } from '../../auth/attempt-limits.ts'
import { adminPool,adminTransaction } from '../database.ts'
import { requireAdminSession,managementProof,audit } from '../security.ts'
import { managementActions,alertCatalog } from '../../../features/admin/management/catalog.ts'
import type { ActionSpec } from './schemas.ts'
import { candidate } from './read-model.ts'
export type ManagementMailer=(email:string,code:string,summary:string)=>Promise<void>
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
export const actionCookie=()=>process.env.NODE_ENV==='production'?'__Host-staffly_admin_action':'staffly_admin_action'
const cookieOptions=()=>({httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict' as const,path:'/'})
export const clearActionCookie=(response:Response)=>response.clearCookie(actionCookie(),cookieOptions())
export function actionError(result:string):never{
 if(result==='LOCKED')throw new ApiError(423,'ADMIN_LOCKED','Панель заблокирована. Введите PIN-код.')
 if(result==='FORBIDDEN')throw new ApiError(403,'ADMIN_AUTH_REQUIRED','Подтвердите административный вход заново.')
 if(result==='SELF'||result==='LAST_ADMIN')throw new ApiError(409,'ADMIN_LAST_ADMIN','Свой доступ и последний действующий административный аккаунт нельзя отключить через панель.')
 if(result==='BUSY')throw new ApiError(409,'ADMIN_BACKUP_BUSY','Уже есть задание резервного копирования. Дождитесь его завершения.')
 if(result==='LIMIT')throw new ApiError(429,'ADMIN_MANAGEMENT_LIMIT','Достигнут лимит этой операции. Повторите позже.')
 throw new ApiError(409,'ADMIN_ACTION_CHANGED','Данные изменились или действие уже выполнено. Закройте окно, обновите данные и подготовьте действие заново.')
}
async function checkSpec(spec:ActionSpec,actorId:string,sessionId:string){
 if(spec.action==='ACCESS_GRANT'||spec.action==='ACCESS_REVOKE'){
  const value=await candidate(spec.targetId,actorId)
  if(value.self)actionError('SELF')
  if(value.version!==spec.payload.version||value.userVersion!==spec.payload.userVersion)actionError('CONFLICT')
  if(spec.action==='ACCESS_GRANT'&&(!value.ready||value.enabled)||spec.action==='ACCESS_REVOKE'&&!value.enabled)actionError('CONFLICT')
  return value.name+' · '+value.email+' · ID '+value.publicId
 }
 if(spec.action==='SESSION_REVOKE'){
  if(spec.targetId===sessionId)actionError('SELF')
  const {rows:[value]}=await adminPool().query('SELECT display_name,grant_version FROM staffly_admin.session_directory WHERE id=$1 AND valid',[spec.targetId])
  if(!value||value.grant_version!==spec.payload.version)actionError('CONFLICT')
  return String(value.display_name||'Администратор')+' · '+spec.targetId
 }
 if(spec.action==='ALERT_RULE'){
  const {rows:[rule]}=await adminPool().query('SELECT * FROM staffly_admin.alert_rules WHERE id=$1',[spec.targetId])
  if(!rule||rule.version!==spec.payload.version||spec.payload.threshold<rule.minimum||spec.payload.threshold>rule.maximum||rule.required&&!spec.payload.enabled)actionError('CONFLICT')
  if(rule.enabled===spec.payload.enabled&&rule.threshold===spec.payload.threshold)throw new ApiError(409,'ADMIN_ACTION_UNCHANGED','Настройки не изменились.')
  return (alertCatalog[rule.key as keyof typeof alertCatalog]?.title??'Оповещение')+' · '+(spec.payload.enabled?'включено':'выключено')+' · порог '+spec.payload.threshold
 }
 const {rows:[limit]}=await adminPool().query(`SELECT EXISTS(SELECT 1 FROM staffly_admin.backup_jobs WHERE status IN ('PENDING','RUNNING') AND expires_at>now()) AS busy,EXISTS(SELECT 1 FROM staffly_admin.backup_jobs WHERE kind='CREATE' AND created_at>now()-interval '15 minutes') AS limited`)
 if(limit.busy)actionError('BUSY');if(limit.limited)actionError('LIMIT')
 return 'Снимок базы данных. Файлы хранилища сохраняются отдельно.'
}
export async function beginAction(request:Request,response:Response,spec:ActionSpec,password:string,sendCode:ManagementMailer){
 const {actor,session}=await requireAdminSession(request)
 const target=await checkSpec(spec,actor.userId,session.id)
 const bucket=await reserveAuthAttempt('admin-password',actor.userId,5),user=await prisma.user.findUniqueOrThrow({where:{id:actor.userId},select:{passwordHash:true}})
 if(!await verifyLoginPassword(user.passwordHash,password)){await audit(adminPool(),actor.userId,'MANAGEMENT_CHALLENGE_DENIED','DENIED',session.id);throw new ApiError(400,'ADMIN_CONFIRMATION_INVALID','Не удалось подтвердить пароль.')}
 await clearAuthAttempts(bucket);await reserveAuthAttempt('admin-management-mail',actor.userId,10)
 const id=randomUUID(),code=String(randomInt(1000000)).padStart(6,'0'),browser=randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+300000)
 await adminTransaction(async db=>{
  const {rows:[grant]}=await db.query('SELECT * FROM staffly_admin.lock_account($1)',[actor.userId])
  if(!grant?.enabled||grant.version!==actor.version)actionError('FORBIDDEN')
  const {rows:[current]}=await db.query('SELECT * FROM staffly_admin.sessions WHERE id=$1 FOR UPDATE',[session.id])
  if(!current||current.revoked_at||current.expires_at<=new Date()||current.locked_at||+new Date(current.activity_at)+300000<=Date.now())actionError('LOCKED')
  const {rows:[previous]}=await db.query("SELECT created_at FROM staffly_admin.action_challenges WHERE user_id=$1 AND sent_at IS NOT NULL ORDER BY created_at DESC LIMIT 1",[actor.userId])
  if(previous&&Date.now()-+new Date(previous.created_at)<60000){response.set('Retry-After','60');throw new ApiError(429,'ADMIN_ACTION_WAIT','Между письмами подтверждения должна пройти минута.')}
  await db.query('UPDATE staffly_admin.action_challenges SET used_at=now() WHERE session_id=$1 AND used_at IS NULL',[session.id])
  await db.query('INSERT INTO staffly_admin.action_challenges(id,user_id,session_id,auth_session_id,grant_version,user_version,action,target_id,payload,code_hash,browser_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,actor.userId,session.id,actor.authSessionId,actor.version,actor.userVersion,spec.action,'targetId'in spec?spec.targetId:null,JSON.stringify(spec.payload),managementProof(id+':'+code),hash(browser),expiresAt])
 })
 const summary=managementActions[spec.action]+' — '+target
 try{await sendCode(actor.email,code,summary)}catch(error){await adminPool().query('UPDATE staffly_admin.action_challenges SET used_at=now() WHERE id=$1',[id]);throw new ApiError(503,'SECURITY_EMAIL_UNAVAILABLE','Письмо подтверждения не отправлено. Повторите позже.',undefined,error)}
 await requireAdminSession(request)
 const sent=await adminPool().query('UPDATE staffly_admin.action_challenges SET sent_at=now() WHERE id=$1 AND used_at IS NULL',[id])
 if(sent.rowCount!==1)actionError('CONFLICT')
 await audit(adminPool(),actor.userId,'MANAGEMENT_CHALLENGE_SENT','SUCCEEDED',session.id,spec.action,'targetId'in spec?spec.targetId:undefined)
 response.cookie(actionCookie(),browser,{...cookieOptions(),maxAge:300000})
 return{challengeId:id,expiresAt:expiresAt.toISOString(),retryAt:new Date(+expiresAt-240000).toISOString(),summary,attemptsRemaining:5}
}
export async function actionStatus(request:Request,id:string){
 const {actor,session}=await requireAdminSession(request)
 return adminTransaction(async db=>{
  // Wait for any execution/cancellation already holding the challenge row. The
  // next statement sees its committed receipt, even when the POST response died.
  const {rows:[challenge]}=await db.query('SELECT expires_at,created_at,used_at,attempts,sent_at FROM staffly_admin.action_challenges WHERE id=$1 AND user_id=$2 AND auth_session_id=$3 AND session_id=$4 FOR SHARE',[id,actor.userId,actor.authSessionId,session.id])
  if(!challenge)throw new ApiError(404,'ADMIN_ACTION_NOT_FOUND','Подтверждение не найдено в этом сеансе.')
  const {rows:[receipt]}=await db.query('SELECT resource_id,completed_at FROM staffly_admin.action_receipts WHERE challenge_id=$1',[id])
  return{state:receipt?'completed':challenge.used_at?'cancelled':+new Date(challenge.expires_at)<=Date.now()?'expired':'pending',resourceId:receipt?.resource_id??null,completedAt:receipt?.completed_at?.toISOString()??null,expiresAt:challenge.expires_at.toISOString(),retryAt:new Date(+challenge.created_at+60000).toISOString(),attemptsRemaining:Math.max(0,5-Number(challenge.attempts))}
 })
}
export async function executeAction(request:Request,response:Response,id:string,code:string){
 const {actor,session}=await requireAdminSession(request),browser=request.cookies?.[actionCookie()]
 if(typeof browser!=='string'||browser.length!==43)actionError('CONFLICT')
 await reserveAuthAttempt('admin-management-code',actor.userId,10)
 const {rows:[result]}=await adminPool().query<{result:string;resource_id:string|null}>('SELECT * FROM staffly_admin.execute_management_action($1,$2,$3,$4,$5,$6,$7)',[actor.userId,actor.authSessionId,session.id,session.token_hash,id,hash(browser),managementProof(id+':'+code)])
 if(result.result==='CODE'){
  const {rows:[challenge]}=await adminPool().query('SELECT attempts FROM staffly_admin.action_challenges WHERE id=$1 AND user_id=$2 AND session_id=$3',[id,actor.userId,session.id])
  const remaining=Math.max(0,5-Number(challenge?.attempts??5))
  if(!remaining)clearActionCookie(response)
  throw new ApiError(400,'ADMIN_ACTION_CODE',remaining?`Неверный код. Осталось попыток: ${remaining}.`:'Попытки исчерпаны. Подготовьте действие заново.',{attemptsRemaining:remaining})
 }
 clearActionCookie(response)
 if(result.result!=='OK')actionError(result.result)
 await requireAdminSession(request)
 return{ok:true,resourceId:result.resource_id}
}
export async function cancelAction(request:Request,response:Response,id:string){
 const {actor,session}=await requireAdminSession(request,false),browser=request.cookies?.[actionCookie()]
 if(typeof browser==='string'){
  const cancelled=await adminPool().query('UPDATE staffly_admin.action_challenges SET used_at=COALESCE(used_at,now()) WHERE id=$1 AND user_id=$2 AND session_id=$3 AND browser_hash=$4',[id,actor.userId,session.id,hash(browser)])
  if(cancelled.rowCount)clearActionCookie(response)
 }
 return{ok:true}
}
export async function simpleAction(request:Request,action:'ALERT_ACK'|'BACKUP_VERIFY',id:string,expected:string|null=null){
 const {actor,session}=await requireAdminSession(request)
 const {rows:[result]}=await adminPool().query<{result:string;resource_id:string|null}>('SELECT * FROM staffly_admin.simple_management_action($1,$2,$3,$4,$5,$6,$7)',[actor.userId,actor.authSessionId,session.id,session.token_hash,action,id,expected])
 if(result.result!=='OK')actionError(result.result)
 await requireAdminSession(request)
 return{ok:true,resourceId:result.resource_id}
}
