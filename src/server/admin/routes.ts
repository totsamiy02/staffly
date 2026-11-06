import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { appUrl, deliverEmail } from '../mail/transport.ts'
import { ApiError } from '../api-error.ts'
import { safeError } from '../security/safe-error.ts'
import { accountRateLimit } from '../security/rate-limit.ts'
import { adminPool } from './database.ts'
import { accessState, activity, audit, createChallenge, endAdminSession, lock, requireAdminSession, setPin, unlock, verifyChallenge, type AdminMailer } from './security.ts'
import { monitoringEvents } from './events.ts'
import { monitoringOverview, monitoringOrganizations, monitoringOrganization, monitoringUsers, monitoringOnline, monitoringAnalytics, monitoringUser } from './monitoring.ts'

const pin=z.string().regex(/^\d{6}$/,'Введите 6 цифр.')
const empty=z.object({}).strict()
const defaultMailer: AdminMailer=async(email,code,purpose)=>{
  if(!process.env.SMTP_USER||!process.env.SMTP_APP_PASSWORD)throw new ApiError(503,'SECURITY_EMAIL_UNAVAILABLE','Для административного входа настройте отправку писем.')
  await deliverEmail(email,{title:purpose==='LOGIN'?'Вход в панель администратора':'Сброс PIN-кода администратора',eyebrow:'Безопасность Staffly',intro:purpose==='LOGIN'?'Подтвердите административный вход кодом. Код привязан к текущему сеансу и действует 5 минут.':'Подтвердите смену PIN-кода. После смены все административные сеансы будут завершены.',code,codeMinutes:5,footer:'Если вы не запрашивали это действие, никому не сообщайте код и проверьте безопасность аккаунта.'})
}
const defaultNotice=async(email:string)=>deliverEmail(email,{title:'PIN-код администратора изменён',eyebrow:'Безопасность Staffly',intro:'PIN-код панели администратора изменён. Все административные сеансы завершены. Если вы не выполняли это действие, проверьте безопасность аккаунта и отзовите административный доступ.',footer:'Служебное уведомление о безопасности аккаунта.'})
export function createAdminRouter({sendCode=defaultMailer,sendNotice=defaultNotice}:{sendCode?:AdminMailer;sendNotice?:(email:string)=>Promise<void>}={}) {
  const router=Router()
  router.use(requireAuth)
  router.use(accountRateLimit('admin-traffic',120))
  router.use((request,response,next)=>{
    response.set({'Cache-Control':'private, no-store','Pragma':'no-cache','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'})
    if(!['GET','HEAD'].includes(request.method)&& (request.get('origin')!==appUrl||!request.is('application/json')||request.get('sec-fetch-site')==='cross-site'))throw new ApiError(403,'ADMIN_ORIGIN_REJECTED','Недопустимый источник запроса.')
    next()
  })
  router.get('/access',async(request,response)=>response.json(await accessState(request)))
  router.post('/challenge',async(request,response)=>{const body=z.object({password:z.string().min(1).max(256),purpose:z.enum(['LOGIN','RESET_PIN']).default('LOGIN')}).strict().parse(request.body);response.json(await createChallenge(request,response,body.password,body.purpose,sendCode))})
  router.post('/verify',async(request,response)=>{
    const body=z.object({challengeId:z.uuid(),code:pin,newPin:pin.optional(),confirmPin:pin.optional()}).strict().refine(v=>!v.newPin||v.newPin===v.confirmPin,'PIN-коды не совпадают.').parse(request.body)
    const result=await verifyChallenge(request,response,body.challengeId,body.code,body.newPin)
    if('reset'in result&&result.reset)await sendNotice((request as AuthenticatedRequest).auth!.email).catch(error=>console.warn('Admin PIN notification unavailable:',safeError(error)))
    response.json(result)
  })
  router.post('/pin',async(request,response)=>{const body=z.object({pin,confirmPin:pin}).strict().refine(v=>v.pin===v.confirmPin,'PIN-коды не совпадают.').parse(request.body);response.json(await setPin(request,body.pin))})
  router.post('/unlock',async(request,response)=>response.json(await unlock(request,z.object({pin}).strict().parse(request.body).pin)))
  router.post('/lock',async(request,response)=>{empty.parse(request.body);response.json(await lock(request))})
  router.post('/activity',async(request,response)=>{empty.parse(request.body);response.json(await activity(request))})
  router.post('/logout',async(request,response)=>{empty.parse(request.body);response.json(await endAdminSession(request,response))})
  const read=(resource:string,work:(request:Parameters<typeof requireAdminSession>[0])=>Promise<unknown>)=>async(request:Parameters<typeof requireAdminSession>[0],response:Parameters<typeof endAdminSession>[1])=>{
    const {actor,session}=await requireAdminSession(request)
    const data=await work(request)
    // Recheck after DB work; lock/revoke during a read cannot publish its result.
    await requireAdminSession(request)
    await audit(adminPool(),actor.userId,'MONITOR_VIEWED','SUCCEEDED',session.id,resource)
    response.json(data)
  }
  router.get('/monitoring/events',read('EVENTS',request=>monitoringEvents(request.query)))
  router.get('/monitoring/overview',read('OVERVIEW',request=>monitoringOverview(request.query)))
  router.get('/monitoring/organizations',read('ORGANIZATIONS',request=>monitoringOrganizations(request.query)))
  router.get('/monitoring/organizations/:id',read('ORGANIZATION',request=>monitoringOrganization(z.uuid().parse(request.params.id),request.query)))
  router.get('/monitoring/users',read('USERS',request=>monitoringUsers(request.query)))
  router.get('/monitoring/users/:id',read('USER',request=>monitoringUser(z.uuid().parse(request.params.id),request.query)))
  router.get('/monitoring/online',read('ONLINE',request=>monitoringOnline(request.query)))
  router.get('/monitoring/analytics',read('ANALYTICS',request=>monitoringAnalytics(request.query)))
  return router
}
export default createAdminRouter()
