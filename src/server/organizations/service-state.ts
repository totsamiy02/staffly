import type { RequestHandler } from 'express'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
export function organizationAvailable(organization:{deletedAt?:Date|null;serviceState:string;serviceUntil:Date|null},now=new Date()){
 return !organization.deletedAt&&(organization.serviceState==='ACTIVE'||!!organization.serviceUntil&&organization.serviceUntil<=now)
}
export function assertOrganizationAvailable(organization:{deletedAt?:Date|null;serviceState:string;serviceUntil:Date|null;serviceReason?:string|null}){
 if(!organizationAvailable(organization))throw new ApiError(423,'ORGANIZATION_SUSPENDED','Работа организации приостановлена. Обратитесь к владельцу или в поддержку.',{until:organization.serviceUntil?.toISOString()??null})
}
export const organizationServiceGate:RequestHandler=async(request,_response,next)=>{
 const id=String(request.params.organizationId)
 if(!/^[a-f0-9-]{36}$/i.test(id)){next();return}
 const organization=await prisma.organization.findUnique({where:{id},select:{serviceState:true,serviceUntil:true,deletedAt:true}})
 // Membership authorization remains responsible for absent/deleted tenants.
 if(organization&&!organization.deletedAt)assertOrganizationAvailable(organization)
 next()
}

export function suspendedWriteError(error:unknown,depth=0):boolean{
 if(!error||typeof error!=='object'||depth>6)return false
 const e=error as Record<string,unknown>
 if((e.code==='P0001'||e.originalCode==='P0001')&&String(e.message??e.originalMessage??'').includes('ORGANIZATION_SUSPENDED'))return true
 return ['cause','meta','driverAdapterError','originalError'].some(key=>suspendedWriteError(e[key],depth+1))
}
