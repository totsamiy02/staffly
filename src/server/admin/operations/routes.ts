import { Router } from 'express'
import { z } from 'zod'
import { adminRead } from '../reads.ts'
import { adminPool } from '../database.ts'
import { requireAdminSession,audit } from '../security.ts'
import { ApiError } from '../../api-error.ts'
import { accountRateLimit } from '../../security/rate-limit.ts'
import { backgroundJob,backgroundJobs,serviceStatus,supportError,supportErrors } from './read-model.ts'

export function createOperationsRouter(){
  const router=Router(),read=(resource:string,work:Parameters<typeof adminRead>[1])=>adminRead(resource,work,'OPERATIONS_VIEWED')
  router.get('/service',read('OPERATIONS_SERVICE',()=>serviceStatus()))
  router.get('/jobs',read('OPERATIONS_JOBS',request=>backgroundJobs(request.query)))
  router.get('/jobs/:kind/:id',read('OPERATIONS_JOB',request=>backgroundJob(z.enum(['email','report']).parse(request.params.kind),z.uuid().parse(request.params.id))))
  router.get('/support',read('OPERATIONS_SUPPORT',request=>supportErrors(request.query)))
  router.get('/support/:id',read('OPERATIONS_DIAGNOSTIC',request=>supportError(z.uuid().parse(request.params.id))))
  router.post('/jobs/report/:id/retry',accountRateLimit('admin-report-retry',5),async(request,response)=>{
    const {actor,session}=await requireAdminSession(request),id=z.uuid().parse(request.params.id)
    z.object({confirm:z.literal(true)}).strict().parse(request.body)
    const {rows:[result]}=await adminPool().query<{result:string}>('SELECT staffly_admin.retry_report($1,$2,$3,$4,$5) AS result',[actor.userId,actor.authSessionId,session.id,session.token_hash,id])
    if(result.result!=='OK'){
      await audit(adminPool(),actor.userId,'EXPORT_RETRY','DENIED',session.id,'REPORT_EXPORT',id)
      if(result.result==='LOCKED')throw new ApiError(423,'ADMIN_LOCKED','Панель заблокирована. Введите PIN-код.')
      if(result.result==='FORBIDDEN')throw new ApiError(403,'ADMIN_AUTH_REQUIRED','Подтвердите административный вход заново.')
      if(result.result==='NOT_FOUND')throw new ApiError(404,'ADMIN_JOB_NOT_FOUND','Задача не найдена или срок хранения истёк.')
      if(result.result==='LIMIT')throw new ApiError(429,'ADMIN_JOB_LIMIT','Достигнут лимит очереди или частоты выгрузок. Повторите позже.')
      throw new ApiError(409,'ADMIN_JOB_CHANGED','Задача уже изменилась, исчерпала попытки или больше недоступна. Проверьте её состояние.')
    }
    await requireAdminSession(request)
    response.json({ok:true})
  })
  return router
}
