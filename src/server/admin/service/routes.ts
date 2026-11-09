import { prisma } from '../../db.ts'
import { createHash } from 'node:crypto'
import { ApiError } from '../../api-error.ts'
import { Router } from 'express'
import { z } from 'zod'
import { adminRead } from '../reads.ts'
import { requireAdminSession,audit } from '../security.ts'
import { adminPool } from '../database.ts'
import { accountRateLimit } from '../../security/rate-limit.ts'
import { actionSpec } from '../management/schemas.ts'
import type { ServiceAction } from './schemas.ts'
import { accountService,organizationService,maintenanceState,cleanupState,fileCleanupState,queueState,queueDetails } from './read-model.ts'
import { previewServiceAction,previewQueue,queueReasons } from './actions.ts'
import { diagnoseAccess } from './access-diagnostic.ts'
import { contentState,saveDraft,reviewContent } from './content.ts'
import { runtimeChecks,checkMaintenance } from './release.ts'
import { serviceReport,reportCsv } from './reports.ts'
export function createServiceRouter(){
 const router=Router(),read=(resource:string,work:Parameters<typeof adminRead>[1])=>adminRead(resource,work,'MANAGEMENT_VIEWED')
 router.get('/accounts/:id',read('ACCOUNT_SERVICE',r=>accountService(z.uuid().parse(r.params.id),r.query)))
 router.get('/organizations/:id',read('ORGANIZATION_SERVICE',r=>organizationService(z.uuid().parse(r.params.id))))
 router.get('/maintenance',read('SERVICE_MAINTENANCE',()=>maintenanceState()))
 router.get('/cleanup/files',read('FILE_CLEANUP',r=>fileCleanupState(r.query)))
 router.get('/cleanup',read('DATA_CLEANUP',r=>cleanupState(r.query)))
 router.get('/queues',read('QUEUE_AGE',()=>queueState()))
 router.get('/queues/:kind/:id',read('QUEUE_HISTORY',r=>queueDetails(z.enum(['email','report']).parse(r.params.kind),z.uuid().parse(r.params.id))))
 router.get('/batches/:id',read('QUEUE_BATCH',async r=>{const {rows:[batch]}=await adminPool().query('SELECT id,command,created_at,results FROM staffly_admin.queue_batches WHERE id=$1',[z.uuid().parse(r.params.id)]);return batch?{...batch,results:await Promise.all(batch.results.map(async(row:{kind:'email'|'report';id:string;result:string})=>{const job=row.kind==='email'?await prisma.emailDelivery.findUnique({where:{id:row.id},select:{status:true,attempts:true}}):await prisma.reportExport.findUnique({where:{id:row.id},select:{status:true,attempts:true}});return{...row,currentStatus:job?.status??null,attempts:job?.attempts??null,reason:row.result==='OK'?(batch.command==='retry'?'Повтор поставлен в очередь':'Отмена сохранена'):queueReasons[row.result]??row.result}}))}:null}))
 router.post('/queues/preview',accountRateLimit('admin-queue-preview',20),read('QUEUE_PREVIEW',r=>{const q=z.object({jobs:z.array(z.object({kind:z.enum(['email','report']),id:z.uuid()}).strict()).min(1).max(20),command:z.enum(['retry','cancel'])}).strict().parse(r.body);return previewQueue(q.jobs,q.command)}))
 router.post('/preview',accountRateLimit('admin-service-preview',30),read('SERVICE_PREVIEW',async r=>{const {actor}=await requireAdminSession(r);const spec=actionSpec.parse(r.body);return previewServiceAction(spec as ServiceAction,actor.userId,actor.authSessionId)}))
 router.post('/access-diagnostic',accountRateLimit('admin-access-diagnostic',20),read('ACCESS_DIAGNOSTIC',r=>diagnoseAccess(r.body)))
 router.get('/content',read('CONTENT',r=>contentState(r.query.key?z.string().max(160).parse(r.query.key):undefined)))
 router.post('/content',accountRateLimit('admin-content-save',20),async(r,s)=>s.json(await saveDraft(r)))
 router.post('/content/:id/review',accountRateLimit('admin-content-review',20),async(r,s)=>s.json(await reviewContent(r,z.uuid().parse(r.params.id))))
 router.get('/release/checks',read('RELEASE_CHECKS',()=>runtimeChecks()))
 router.post('/maintenance/:id/check',accountRateLimit('admin-maintenance-check',10),async(r,s)=>s.json(await checkMaintenance(r,z.uuid().parse(r.params.id))))
 router.post('/signals/:id/confirm',accountRateLimit('admin-signal-confirm',10),async(r,s)=>{
  const {actor,session}=await requireAdminSession(r),id=z.uuid().parse(r.params.id),{code}=z.object({code:z.string().regex(/^\d{6}$/)}).strict().parse(r.body)
  const {rows:[row]}=await adminPool().query('SELECT staffly_admin.confirm_signal($1,$2,$3,$4,$5,$6) result',[actor.userId,actor.authSessionId,session.id,session.token_hash,id,createHash('sha256').update(id+':'+code).digest('hex')])
  if(row.result!=='OK')throw new ApiError(409,'ADMIN_SIGNAL_CODE','Код не подошёл, истёк или попытки исчерпаны.')
  await requireAdminSession(r);s.json({ok:true})
 })
 router.get('/reports',accountRateLimit('admin-service-report',5),async(r,s)=>{
  const {actor,session}=await requireAdminSession(r),report=await serviceReport(r.query);await requireAdminSession(r)
  await audit(adminPool(),actor.userId,'SERVICE_REPORT_EXPORTED','SUCCEEDED',session.id,'SERVICE_REPORT')
  if(r.query.format==='csv')s.type('text/csv; charset=utf-8').attachment('staffly-service-report.csv').send(reportCsv(report));else s.json(report)
 })
 return router
}
