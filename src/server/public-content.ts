import { Router,type RequestHandler } from 'express'
import { z } from 'zod'
import { databasePool } from './db.ts'
import { ApiError } from './api-error.ts'
export const publicContentRouter=Router()
publicContentRouter.get('/content',async(request,response)=>{
 const kind=z.enum(['guide','home','faq','contacts','announcement','legal']).optional().parse(request.query.kind)
 const search=z.string().trim().max(200).default('').parse(request.query.search),patterns=search.split(/\s+/).filter(Boolean).map(v=>'%'+v.replace(/[\\%_]/g,'\\$&')+'%')
 const {rows}=await databasePool.query(`SELECT key,kind,title,metadata,left(body,300) summary,revision,effective_at,GREATEST(1,ceil(char_length(body)/1100.0))::int AS reading_minutes,
  ($3='' OR to_tsvector('russian',title||' '||body)@@plainto_tsquery('russian',$3) OR NOT EXISTS(SELECT 1 FROM unnest($2::text[]) terms(term) WHERE (title||' '||body) NOT ILIKE term)) AS matches
  FROM public.platform_public_content WHERE ($1::text IS NULL OR kind=$1) ORDER BY key LIMIT 300`,[kind??null,patterns,search]);response.set('Cache-Control','no-store').json({items:rows})
})
publicContentRouter.get('/content/:key',async(request,response)=>{
 const key=z.string().max(160).parse(request.params.key),{rows:[item]}=await databasePool.query('SELECT key,kind,title,body,metadata,revision,effective_at,published_at FROM public.platform_public_content WHERE key=$1',[key]);response.set('Cache-Control','no-store').json(item??null)
})
publicContentRouter.get('/service-notice',async(_request,response)=>{const {rows}=await databasePool.query('SELECT id,starts_at,ends_at,announcement,read_only,status FROM public.platform_maintenance_notice ORDER BY starts_at');response.set('Cache-Control','no-store').json({windows:rows,now:new Date().toISOString()})})
export const maintenanceWriteGate:RequestHandler=async(request,_response,next)=>{
 if(['GET','HEAD','OPTIONS'].includes(request.method)||/^\/(auth|admin|public)(\/|$)/.test(request.path)||request.path==='/support/client-errors'||request.path==='/profile/presence'){next();return}
 const {rows:[window]}=await databasePool.query('SELECT ends_at FROM public.platform_maintenance_notice WHERE read_only AND starts_at<=now() AND ends_at>now() LIMIT 1')
 if(window)throw new ApiError(503,'SERVICE_MAINTENANCE','Идёт плановое обслуживание. Изменения временно приостановлены.',{until:window.ends_at.toISOString()})
 next()
}
