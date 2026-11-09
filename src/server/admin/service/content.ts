import { guideArticles } from '../../../pages/guide/content/index.ts'
import type { Request } from 'express'
import { z } from 'zod'
import { adminPool } from '../database.ts'
import { requireAdminSession } from '../security.ts'
import { actionError } from '../management/actions.ts'
import { ApiError } from '../../api-error.ts'
import { contentDraft } from './schemas.ts'
export function contentChecks(body:string){
 const errors:string[]=[]
 if(/<\s*\/?\s*[a-z!]/i.test(body))errors.push('HTML не поддерживается. Используйте Markdown.')
 if(/(?:javascript|vbscript|data)\s*:/i.test(body))errors.push('Обнаружена небезопасная ссылка.')
 for(const m of body.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g))if(!/^(https:\/\/|\/(?!\/)|#|mailto:|tel:)/.test(m[1]))errors.push('Ссылка должна начинаться с https://, /, #, mailto: или tel:.')
 return{passed:errors.length===0,errors:[...new Set(errors)],characters:body.length}
}
export async function contentState(key?:string){
 if(key)z.string().max(160).parse(key)
 const [items,revisions,publications]=await Promise.all([
  adminPool().query('SELECT i.*,p.revision_id AS published_revision FROM staffly_admin.content_items i LEFT JOIN LATERAL(SELECT revision_id FROM staffly_admin.content_publications WHERE item_id=i.id ORDER BY id DESC LIMIT 1)p ON true ORDER BY i.kind,i.key'),
  adminPool().query('SELECT r.*,v.reviewed_at,v.reviewed_by FROM staffly_admin.content_revisions r JOIN staffly_admin.content_items i ON i.id=r.item_id LEFT JOIN staffly_admin.content_reviews v ON v.revision_id=r.id WHERE ($1::text IS NULL OR i.key=$1) ORDER BY r.created_at DESC,r.id LIMIT 100',[key??null]),
  adminPool().query('SELECT p.*,r.revision,r.title FROM staffly_admin.content_publications p JOIN staffly_admin.content_items i ON i.id=p.item_id JOIN staffly_admin.content_revisions r ON r.id=p.revision_id WHERE ($1::text IS NULL OR i.key=$1) ORDER BY p.id DESC LIMIT 100',[key??null])
 ])
 return{items:items.rows,revisions:revisions.rows,publications:publications.rows,templates:guideArticles.map(a=>({key:'guide:'+a.slug,kind:'guide',title:a.title,metadata:{category:a.category,audience:a.audience,summary:a.summary},body:a.sections.map(s=>['## '+s.title+' {#'+s.id+'}',...(s.paragraphs??[]),...(s.items??[]).map(t=>'- '+t),...(s.steps??[]).map((t,i)=>(i+1)+'. **'+t.title+'** — '+t.text),...(s.note?[s.note]:[]),...(s.example?['```staffly-example\n'+s.example+'\n```']:[]),...(s.table?['| '+s.table.headings.join(' | ')+' |','| '+s.table.headings.map(()=>'---').join(' | ')+' |',...s.table.rows.map(r=>'| '+r.join(' | ')+' |')]:[])].join('\n\n')).join('\n\n')+(a.questions?.length?'\n\n## Вопросы и ответы {#questions}\n\n'+a.questions.map(q=>'### '+q.question+'\n\n'+q.answer).join('\n\n'):'')}))}
}
export async function saveDraft(request:Request){
 const draft=contentDraft.parse(request.body),checks=contentChecks(draft.body)
 if(!checks.passed)throw new ApiError(400,'ADMIN_CONTENT_INVALID',checks.errors.join(' '))
 const {actor,session}=await requireAdminSession(request),{rows:[result]}=await adminPool().query('SELECT * FROM staffly_admin.save_service_content($1,$2,$3,$4,$5)',[actor.userId,actor.authSessionId,session.id,session.token_hash,JSON.stringify(draft)])
 if(result.result!=='OK')actionError(result.result)
 await requireAdminSession(request)
 return{itemId:result.item_id,revisionId:result.revision_id,checks}
}
export async function reviewContent(request:Request,id:string){
 z.object({confirm:z.literal(true)}).strict().parse(request.body)
 const {actor,session}=await requireAdminSession(request),{rows:[revision]}=await adminPool().query('SELECT body FROM staffly_admin.content_revisions WHERE id=$1',[id])
 if(!revision)throw new ApiError(404,'ADMIN_CONTENT_NOT_FOUND','Версия не найдена.')
 const checks=contentChecks(revision.body)
 if(!checks.passed)throw new ApiError(400,'ADMIN_CONTENT_INVALID',checks.errors.join(' '))
 const {rows:[result]}=await adminPool().query('SELECT staffly_admin.review_service_content($1,$2,$3,$4,$5) AS result',[actor.userId,actor.authSessionId,session.id,session.token_hash,id])
 if(result.result!=='OK')actionError(result.result)
 await requireAdminSession(request);return{ok:true,checks}
}
