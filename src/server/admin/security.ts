import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import type { PoolClient } from 'pg'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import type { AuthenticatedRequest } from '../auth.ts'
import { passwordHash, verifyLoginPassword } from '../auth/passwords.ts'
import { reserveAuthAttempt, clearAuthAttempts } from '../auth/attempt-limits.ts'
import { adminConfigured, adminPool, adminTransaction, checkAdminDatabase } from './database.ts'

export const ADMIN_IDLE_MS = 5 * 60_000
export const ADMIN_ABSOLUTE_MS = 4 * 60 * 60_000
export const ADMIN_CODE_MS = 5 * 60_000
const cookieName = () => process.env.NODE_ENV === 'production' ? '__Host-staffly_admin' : 'staffly_admin'
const challengeCookie = () => process.env.NODE_ENV === 'production' ? '__Host-staffly_admin_challenge' : 'staffly_admin_challenge'
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => process.env.ADMIN_AUTH_SECRET || createHmac('sha256', process.env.JWT_SECRET!).update('staffly-admin-development-only').digest('hex')
const digest = (purpose: string, value: string) => createHmac('sha256', secret()).update(`${purpose}:${value}`).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const auth = (request: Request) => (request as AuthenticatedRequest).auth!
type Principal = { userId: string; authSessionId: string; email: string; version: number; userVersion: number; pinSet: boolean }
export type AdminSession = { id: string; user_id: string; auth_session_id: string; grant_version: number; user_version: number; created_at:Date; expires_at: Date; activity_at: Date; locked_at: Date | null; revoked_at: Date | null; setup_allowed: boolean; pin_attempts: number }
export type AdminState = { eligible: boolean; state: 'authenticate' | 'setup-pin' | 'locked' | 'active'; expiresAt?: string; lockAt?: string; pinSet?: boolean; attemptsRemaining?: number }
type AuditAction = 'CHALLENGE_SENT' | 'CHALLENGE_DENIED' | 'LOGIN' | 'PIN_CREATED' | 'PIN_RESET' | 'PIN_DENIED' | 'UNLOCK' | 'LOCK' | 'LOGOUT' | 'MONITOR_VIEWED' | 'ACCESS_DENIED'
export async function audit(db: Pick<PoolClient,'query'>, userId: string, action: AuditAction, outcome: 'SUCCEEDED' | 'DENIED' | 'FAILED' = 'SUCCEEDED', sessionId?: string, resource?: string, resourceId?: string) {
  await db.query('INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),userId,sessionId ?? null,action,outcome,resource ?? null,resourceId ?? null])
}
export async function principal(request: Request): Promise<Principal> {
  await checkAdminDatabase()
  const actor = auth(request)
  const [user, { rows: [grant] }] = await Promise.all([
    prisma.user.findUnique({ where: { id: actor.userId }, select: { email:true, securityVersion:true, emailVerifiedAt:true, deletedAt:true } }),
    adminPool().query('SELECT a.version, EXISTS(SELECT 1 FROM staffly_admin.credentials c WHERE c.user_id=a.user_id) AS pin_set FROM staffly_admin.accounts a WHERE a.user_id=$1 AND a.enabled=true',[actor.userId]),
  ])
  if (!user || user.deletedAt || !user.emailVerifiedAt || !grant) throw new ApiError(403, 'ADMIN_FORBIDDEN', 'Административный доступ не предоставлен.')
  return { userId:actor.userId,authSessionId:actor.sessionId,email:user.email,version:grant.version,userVersion:user.securityVersion,pinSet:grant.pin_set }
}
function cookie(response: Response, name: string, value: string, maxAge: number) { response.cookie(name,value,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge}) }
export function clearAdminCookie(response: Response) { response.clearCookie(cookieName(),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/'}) }
async function sessionFor(request: Request, actor: Principal): Promise<AdminSession | null> {
  const raw = request.cookies?.[cookieName()]
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(raw)) return null
  const { rows:[session] } = await adminPool().query<AdminSession>('SELECT * FROM staffly_admin.sessions WHERE token_hash=$1 AND user_id=$2 AND auth_session_id=$3',[hashToken(raw),actor.userId,actor.authSessionId])
  if (!session || session.revoked_at || session.expires_at <= new Date() || session.grant_version !== actor.version || session.user_version !== actor.userVersion || session.setup_allowed&&session.created_at.getTime()+10*60_000<Date.now()) return null
  return session
}
function stateOf(session: AdminSession | null, actor: Principal): AdminState {
  if (!session) return {eligible:true,state:'authenticate',pinSet:actor.pinSet}
  const state = session.setup_allowed && !actor.pinSet ? 'setup-pin' : session.locked_at || session.activity_at.getTime() + ADMIN_IDLE_MS <= Date.now() ? 'locked' : 'active'
  return {eligible:true,state,expiresAt:session.expires_at.toISOString(),lockAt:new Date(session.activity_at.getTime()+ADMIN_IDLE_MS).toISOString(),pinSet:actor.pinSet,attemptsRemaining:Math.max(0,5-session.pin_attempts)}
}
export async function accessState(request: Request): Promise<AdminState> {
  if (!adminConfigured()) return {eligible:false,state:'authenticate'}
  let actor: Principal
  try { actor = await principal(request) } catch (error) { if (error instanceof ApiError && error.code==='ADMIN_FORBIDDEN') return {eligible:false,state:'authenticate'}; throw error }
  return stateOf(await sessionFor(request,actor),actor)
}
export async function requireAdminSession(request: Request, unlocked = true) {
  const actor = await principal(request), session = await sessionFor(request,actor)
  if (!session) throw new ApiError(403,'ADMIN_AUTH_REQUIRED','Подтвердите вход в панель администратора.')
  const state = stateOf(session,actor)
  if (unlocked && state.state !== 'active') throw new ApiError(423,'ADMIN_LOCKED','Панель заблокирована. Введите PIN-код.')
  return {actor,session,state}
}
export function validateNewPin(value: string) {
  if (!/^\d{6}$/.test(value) || /^(\d)\1{5}$/.test(value) || ['123456','654321','012345','543210','121212','123123'].includes(value)) throw new ApiError(400,'ADMIN_WEAK_PIN','Используйте 6 цифр без простых последовательностей и повторов.')
}
const pinSecret = (pin: string) => digest('admin-lock-pin',pin)
export type AdminMailer = (email: string, code: string, purpose: 'LOGIN' | 'RESET_PIN') => Promise<void>
export async function createChallenge(request: Request, response: Response, password: string, purpose: 'LOGIN' | 'RESET_PIN', sendCode: AdminMailer) {
  const actor = await principal(request)
  const passwordBucket=await reserveAuthAttempt('admin-password',actor.userId,5)
  const user = await prisma.user.findUniqueOrThrow({where:{id:actor.userId},select:{passwordHash:true}})
  if (!await verifyLoginPassword(user.passwordHash,password)) { await audit(adminPool(),actor.userId,'CHALLENGE_DENIED','DENIED'); throw new ApiError(400,'ADMIN_CONFIRMATION_INVALID','Не удалось подтвердить пароль.') }
  await clearAuthAttempts(passwordBucket)
  await reserveAuthAttempt('admin-send-code',actor.userId,5)
  const id=randomUUID(), code=String(randomInt(1000000)).padStart(6,'0'), browser=randomBytes(32).toString('base64url')
  await adminTransaction(async db=>{
    const {rows:[grant]}=await db.query('SELECT * FROM staffly_admin.lock_account($1)',[actor.userId])
    if(!grant?.enabled||grant.version!==actor.version)throw new ApiError(403,'ADMIN_FORBIDDEN','Административный доступ не предоставлен.')
    const {rows:[recent]}=await db.query('SELECT 1 FROM staffly_admin.challenges WHERE user_id=$1 AND created_at>now()-interval \'60 seconds\' LIMIT 1',[actor.userId])
    if(recent)throw new ApiError(429,'ADMIN_EMAIL_COOLDOWN','Повторный код можно запросить через минуту.')
    await db.query('UPDATE staffly_admin.challenges SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[actor.userId])
    await db.query('INSERT INTO staffly_admin.challenges(id,user_id,auth_session_id,grant_version,user_version,purpose,code_hash,browser_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,actor.userId,actor.authSessionId,actor.version,actor.userVersion,purpose,digest('email-code',`${id}:${code}`),hashToken(browser),new Date(Date.now()+ADMIN_CODE_MS)])
  })
  try { await sendCode(actor.email,code,purpose) }
  catch { await adminPool().query('UPDATE staffly_admin.challenges SET used_at=now() WHERE id=$1',[id]); throw new ApiError(502,'SECURITY_EMAIL_UNAVAILABLE','Не удалось отправить код. Попробуйте позже.') }
  await adminPool().query('UPDATE staffly_admin.challenges SET sent_at=now() WHERE id=$1 AND used_at IS NULL',[id])
  await audit(adminPool(),actor.userId,'CHALLENGE_SENT')
  cookie(response,challengeCookie(),browser,ADMIN_CODE_MS)
  return {challengeId:id,purpose,expiresIn:ADMIN_CODE_MS/1000}
}
export async function verifyChallenge(request: Request,response: Response,id: string,code: string,newPin?: string) {
  const actor=await principal(request)
  await reserveAuthAttempt('admin-email-code',actor.userId,10)
  if(newPin)validateNewPin(newPin)
  const newHash=newPin?await passwordHash(pinSecret(newPin)):null
  const raw=randomBytes(32).toString('base64url'), sessionId=randomUUID()
  const result=await adminTransaction(async db=>{
    const {rows:[grant]}=await db.query('SELECT * FROM staffly_admin.lock_account($1)',[actor.userId])
    const {rows:[challenge]}=await db.query('SELECT * FROM staffly_admin.challenges WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,actor.userId])
    const browser=request.cookies?.[challengeCookie()]
    if(!grant?.enabled||grant.version!==actor.version||!challenge||challenge.used_at||!challenge.sent_at||challenge.expires_at<=new Date()||challenge.attempts>=5||challenge.auth_session_id!==actor.authSessionId||challenge.user_version!==actor.userVersion||challenge.grant_version!==actor.version||typeof browser!=='string'||!same(challenge.browser_hash,hashToken(browser)))return {invalid:true}
    if(!same(challenge.code_hash,digest('email-code',`${id}:${code}`))){await db.query('UPDATE staffly_admin.challenges SET attempts=attempts+1,used_at=CASE WHEN attempts>=4 THEN now() ELSE NULL END WHERE id=$1',[id]);await audit(db,actor.userId,'CHALLENGE_DENIED','DENIED');return {invalid:true}}
    if(challenge.purpose==='RESET_PIN'&&!newHash)throw new ApiError(400,'ADMIN_PIN_REQUIRED','Укажите новый PIN-код.')
    await db.query('UPDATE staffly_admin.challenges SET used_at=now() WHERE id=$1',[id])
    await db.query('UPDATE staffly_admin.sessions SET revoked_at=now() WHERE user_id=$1 AND auth_session_id=$2 AND revoked_at IS NULL',[actor.userId,actor.authSessionId])
    if(challenge.purpose==='RESET_PIN'){
      await db.query('INSERT INTO staffly_admin.credentials(user_id,pin_hash) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET pin_hash=$2,updated_at=now()',[actor.userId,newHash])
      await db.query('UPDATE staffly_admin.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[actor.userId])
      await audit(db,actor.userId,'PIN_RESET')
      return {reset:true}
    }
    const {rows:[credential]}=await db.query('SELECT 1 FROM staffly_admin.credentials WHERE user_id=$1',[actor.userId])
    await db.query('INSERT INTO staffly_admin.sessions(id,token_hash,user_id,auth_session_id,grant_version,user_version,expires_at,locked_at,setup_allowed) VALUES ($1,$2,$3,$4,$5,$6,now()+interval \'4 hours\',now(),$7)',[sessionId,hashToken(raw),actor.userId,actor.authSessionId,actor.version,actor.userVersion,!credential])
    await audit(db,actor.userId,'LOGIN','SUCCEEDED',sessionId)
    return {created:true}
  })
  if(result.invalid)throw new ApiError(400,'ADMIN_CODE_INVALID','Неверный или истёкший код. После пяти ошибок запросите новый.')
  response.clearCookie(challengeCookie(),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/'})
  if(result.reset){clearAdminCookie(response);return {eligible:true,state:'authenticate',pinSet:true,reset:true} as const}
  cookie(response,cookieName(),raw,ADMIN_ABSOLUTE_MS)
  request.cookies={...request.cookies,[cookieName()]:raw}
  return accessState(request)
}
export async function setPin(request: Request,pin: string) {
  validateNewPin(pin)
  const {actor,session}=await requireAdminSession(request,false), hashed=await passwordHash(pinSecret(pin))
  await adminTransaction(async db=>{
    const {rows:[grant]}=await db.query('SELECT * FROM staffly_admin.lock_account($1)',[actor.userId])
    if(!grant?.enabled||grant.version!==actor.version)throw new ApiError(403,'ADMIN_FORBIDDEN','Административный доступ не предоставлен.')
    const {rows:[current]}=await db.query('SELECT * FROM staffly_admin.sessions WHERE id=$1 FOR UPDATE',[session.id])
    if(!current?.setup_allowed||current.revoked_at||current.expires_at<=new Date()||current.created_at.getTime()+10*60_000<Date.now())throw new ApiError(403,'ADMIN_SETUP_EXPIRED','Подтвердите административный вход заново.')
    const inserted=await db.query('INSERT INTO staffly_admin.credentials(user_id,pin_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING',[actor.userId,hashed])
    if(!inserted.rowCount)throw new ApiError(409,'ADMIN_PIN_EXISTS','PIN-код уже создан. Разблокируйте панель.')
    await db.query('UPDATE staffly_admin.sessions SET setup_allowed=false,locked_at=NULL,activity_at=now(),pin_attempts=0 WHERE id=$1',[session.id])
    await audit(db,actor.userId,'PIN_CREATED','SUCCEEDED',session.id)
  })
  return accessState(request)
}
export async function unlock(request: Request,pin: string) {
  const {actor,session}=await requireAdminSession(request,false)
  const bucket=await reserveAuthAttempt('admin-unlock',actor.userId,10)
  const valid=await adminTransaction(async db=>{
    const {rows:[grant]}=await db.query('SELECT * FROM staffly_admin.lock_account($1)',[actor.userId])
    if(!grant?.enabled||grant.version!==actor.version)return false
    const {rows:[current]}=await db.query('SELECT * FROM staffly_admin.sessions WHERE id=$1 FOR UPDATE',[session.id])
    if(!current||current.revoked_at||current.expires_at<=new Date()||current.pin_attempts>=5)return false
    const {rows:[credential]}=await db.query('SELECT pin_hash FROM staffly_admin.credentials WHERE user_id=$1',[actor.userId])
    if(!credential||!await verifyLoginPassword(credential.pin_hash,pinSecret(pin))){await db.query('UPDATE staffly_admin.sessions SET pin_attempts=LEAST(pin_attempts+1,5),revoked_at=CASE WHEN pin_attempts>=4 THEN now() ELSE revoked_at END WHERE id=$1',[session.id]);await audit(db,actor.userId,'PIN_DENIED','DENIED',session.id);return current.pin_attempts>=4?'revoked' as const:false}
    await db.query('UPDATE staffly_admin.sessions SET locked_at=NULL,activity_at=now(),pin_attempts=0 WHERE id=$1',[session.id])
    await audit(db,actor.userId,'UNLOCK','SUCCEEDED',session.id)
    return true
  })
  if(valid==='revoked')throw new ApiError(403,'ADMIN_AUTH_REQUIRED','Лимит попыток PIN исчерпан. Подтвердите вход паролем и кодом из письма.')
  if(!valid)throw new ApiError(400,'ADMIN_PIN_INVALID','Неверный PIN-код. После пяти ошибок потребуется новый вход.')
  await clearAuthAttempts(bucket)
  return accessState(request)
}
export async function lock(request: Request) {
  const {actor,session}=await requireAdminSession(request,false)
  await adminTransaction(async db=>{await db.query('UPDATE staffly_admin.sessions SET locked_at=now() WHERE id=$1 AND revoked_at IS NULL',[session.id]);await audit(db,actor.userId,'LOCK','SUCCEEDED',session.id)})
  return accessState(request)
}
export async function activity(request: Request) {
  const {session}=await requireAdminSession(request)
  // A background GET, refresh, or presence heartbeat never extends this deadline.
  const saved=await adminPool().query('UPDATE staffly_admin.sessions SET activity_at=now() WHERE id=$1 AND locked_at IS NULL AND revoked_at IS NULL AND activity_at>now()-interval \'5 minutes\' AND expires_at>now() RETURNING id',[session.id])
  if(!saved.rowCount)throw new ApiError(423,'ADMIN_LOCKED','Панель заблокирована. Введите PIN-код.')
  return accessState(request)
}
export async function endAdminSession(request: Request,response: Response) {
  const actor=await principal(request),session=await sessionFor(request,actor)
  if(session)await adminTransaction(async db=>{await db.query('UPDATE staffly_admin.sessions SET revoked_at=now() WHERE id=$1',[session.id]);await audit(db,actor.userId,'LOGOUT','SUCCEEDED',session.id)})
  clearAdminCookie(response)
  return {ok:true}
}
