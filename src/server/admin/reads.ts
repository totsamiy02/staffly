import type { Request,Response } from 'express'
import { adminPool } from './database.ts'
import { requireAdminSession,audit } from './security.ts'

export const adminRead=(resource:string,work:(request:Request)=>Promise<unknown>,action:'MONITOR_VIEWED'|'OPERATIONS_VIEWED'|'MANAGEMENT_VIEWED'='MONITOR_VIEWED')=>async(request:Request,response:Response)=>{
  const {actor,session}=await requireAdminSession(request)
  const data=await work(request)
  // Lock/revocation during a read cannot publish the completed result.
  await requireAdminSession(request)
  await audit(adminPool(),actor.userId,action,'SUCCEEDED',session.id,resource)
  response.json(data)
}
