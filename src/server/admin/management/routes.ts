import { Router } from 'express'
import { z } from 'zod'
import { adminRead } from '../reads.ts'
import { requireAdminSession } from '../security.ts'
import { accountRateLimit } from '../../security/rate-limit.ts'
import { administrators,backupsState,alertsState,securityState,candidate } from './read-model.ts'
import { beginAction,executeAction,cancelAction,simpleAction,type ManagementMailer } from './actions.ts'
import { actionSpec } from './schemas.ts'
export function createManagementRouter(sendCode:ManagementMailer){
 const router=Router(),read=(resource:string,work:Parameters<typeof adminRead>[1])=>adminRead(resource,work,'MANAGEMENT_VIEWED')
 router.get('/security',read('SECURITY',securityState))
 router.get('/administrators',read('ADMINISTRATORS',administrators))
 router.get('/administrators/candidate',read('ADMINISTRATOR_CANDIDATE',async request=>candidate(request.query.search,(await requireAdminSession(request)).actor.userId)))
 router.get('/backups',read('BACKUPS',request=>backupsState(request.query)))
 router.get('/alerts',read('ALERTS',request=>alertsState(request.query)))
 router.post('/actions',accountRateLimit('admin-management-begin',10),async(request,response)=>{
  const body=z.object({spec:actionSpec,password:z.string().min(1).max(1024)}).strict().parse(request.body)
  response.json(await beginAction(request,response,body.spec,body.password,sendCode))
 })
 router.post('/actions/execute',accountRateLimit('admin-management-execute',15),async(request,response)=>{
  const body=z.object({challengeId:z.uuid(),code:z.string().regex(/^\d{6}$/),confirm:z.literal(true)}).strict().parse(request.body)
  response.json(await executeAction(request,response,body.challengeId,body.code))
 })
 router.post('/actions/:id/cancel',accountRateLimit('admin-management-cancel',15),async(request,response)=>{z.object({}).strict().parse(request.body);response.json(await cancelAction(request,response,z.uuid().parse(request.params.id)))})
 router.post('/alerts/:id/acknowledge',accountRateLimit('admin-alert-acknowledge',20),async(request,response)=>{
  z.object({confirm:z.literal(true)}).strict().parse(request.body)
  response.json(await simpleAction(request,'ALERT_ACK',z.uuid().parse(request.params.id)))
 })
 router.post('/backups/:id/verify',accountRateLimit('admin-backup-verify',5),async(request,response)=>{
  const body=z.object({confirm:z.literal(true),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(request.body)
  response.json(await simpleAction(request,'BACKUP_VERIFY',z.uuid().parse(request.params.id),body.sha256))
 })
 return router
}
