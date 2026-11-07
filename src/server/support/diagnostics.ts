import { randomUUID } from 'node:crypto'
import type { Request, RequestHandler } from 'express'
import { safeApiError, safeError } from '../security/safe-error.ts'
import { securityCorrelationId } from '../security/journal.ts'
import type { AuthenticatedRequest } from '../auth.ts'

export const runtimeNodeId=randomUUID()
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const identifier=(value:unknown)=>typeof value==='string'&&uuid.test(value)?value:null
const eventCode=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:null
export type Incident={id:string;node_id:string;created_at:string;method:string;route:string;status:number;name:string;code:string|null;event_code:string|null;source:'request'|'client'|'worker';user_id:string|null;organization_id:string|null;task_name:string|null}
const pending:Incident[]=[]
let dropped=0
let wakeup:(()=>void)|undefined
export const setDiagnosticsWakeup=(callback:(()=>void)|undefined)=>{wakeup=callback}
export const diagnosticsPending=()=>pending.length
export const diagnosticsDropped=()=>dropped
export const takeDiagnostics=(limit:number)=>pending.splice(0,limit)
export function restoreDiagnostics(batch:Incident[]){const room=Math.max(0,200-pending.length);pending.unshift(...batch.slice(0,room));dropped+=Math.max(0,batch.length-room)}
export function captureIncident(row:Incident){if(pending.length>=200){dropped++;return}pending.push(row);wakeup?.()}
export function captureRequestFailure(error:unknown,request:Request,status:number,errorId:string,organizationId?:unknown,publicCode?:unknown){
  if(status<400||status>599||!identifier(errorId))return
  const diagnostic=safeApiError(error,request,errorId)
  const route=/^\/[a-zA-Z0-9_/:.*()-]*$/.test(diagnostic.route)?diagnostic.route:'unmatched'
  captureIncident({id:errorId,node_id:runtimeNodeId,created_at:new Date().toISOString(),method:diagnostic.method,route,status,name:diagnostic.name,code:diagnostic.code??null,event_code:eventCode(publicCode),source:'request',user_id:identifier((request as AuthenticatedRequest).auth?.userId),organization_id:identifier(organizationId),task_name:null})
}
export function captureWorkerFailure(taskName:string,error:unknown){
  // Only caller-defined labels from startBackgroundTask; never exception text.
  const safe=safeError(error)
  captureIncident({id:randomUUID(),node_id:runtimeNodeId,created_at:new Date().toISOString(),method:'OTHER',route:'/workers',status:0,name:safe.name,code:safe.code??null,event_code:'BACKGROUND_CYCLE_FAILED',source:'worker',user_id:null,organization_id:null,task_name:/^[A-Za-z ]{1,80}$/.test(taskName)?taskName:null})
}

/** Covers direct validation/permission/rate-limit replies as well as thrown errors. */
export const supportResponses:RequestHandler=(request,response,next)=>{
  const json=response.json.bind(response),eligible=request.path.startsWith('/api/')&&!request.path.startsWith('/api/support/client-errors')
  let recorded=false
  response.json=(body:unknown)=>{
    if(!recorded&&eligible&&response.statusCode>=400){
      recorded=true
      const data=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:{}
      const id=identifier(data.errorId)??securityCorrelationId()??randomUUID()
      response.set('X-Support-Code',id)
      captureRequestFailure(response.locals.supportError??{name:'ApiError'},request,response.statusCode,id,response.locals.operationsOrganizationId,data.code)
      return json({...data,errorId:id})
    }
    return json(body)
  }
  next()
}
