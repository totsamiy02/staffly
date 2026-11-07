import { Router } from 'express'
import { z } from 'zod'
import { requireAuth,type AuthenticatedRequest } from '../auth.ts'
import { accountRateLimit } from '../security/rate-limit.ts'
import { databasePool } from '../db.ts'
import { runtimeNodeId } from './diagnostics.ts'

const report=z.object({id:z.uuid().refine(value=>value[14]==='8'),at:z.iso.datetime(),kind:z.enum(['NETWORK_ERROR','REQUEST_TIMEOUT','INVALID_RESPONSE','CLIENT_RUNTIME_ERROR']),area:z.enum(['authentication','profile','organization','reports','documents','requests','schedule','admin','other']),organizationId:z.uuid().nullable()}).strict()
export function createSupportRouter(){
  const router=Router()
  router.post('/client-errors',accountRateLimit('support-browser-ip',30),async(request,response,next)=>{
    if(request.get('authorization'))await requireAuth(request,response,next)
    else next()
  },accountRateLimit('support-browser-account',20),async(request:AuthenticatedRequest,response)=>{
    const item=report.parse(request.body),at=new Date(item.at),now=Date.now()
    if(+at>now+60_000||+at<now-86400_000){response.status(400).json({code:'DIAGNOSTIC_EXPIRED',message:'Срок отправки диагностики истёк.'});return}
    let organizationId:string|null=null
    if(item.organizationId&&request.auth){
      const {rowCount}=await databasePool.query('SELECT 1 FROM organization_members m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.organization_id=$2 AND m.left_at IS NULL AND o.deleted_at IS NULL',[request.auth.userId,item.organizationId])
      if(rowCount)organizationId=item.organizationId
    }
    // Client reports are explicitly unverified. No arbitrary text/stack/URL/payload.
    await databasePool.query(`INSERT INTO platform_request_errors(id,node_id,created_at,method,route,status,name,event_code,source,user_id,organization_id)
      VALUES($1,$2,$3,'OTHER',$4,0,'Error',$5,'client',$6,$7) ON CONFLICT(id) DO NOTHING`,[item.id,runtimeNodeId,at,'/browser/'+item.area,item.kind,request.auth?.userId??null,organizationId])
    response.set('Cache-Control','no-store').status(202).json({accepted:true})
  })
  return router
}
