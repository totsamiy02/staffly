import { z } from 'zod'
import { definitionOf,visibleField,type RequestAnswers,type RequestDefinition } from '../../app/requests/workflow.ts'
import { ApiError } from '../api-error.ts'
import type { RequestDatabase as DB } from './request-model.ts'

const rawAnswers = z.record(z.string(), z.unknown())
const periodAnswer = z.object({ start: z.string(), end: z.string() })
export async function validateDefinition(db:DB,org:string,raw:unknown){
  const d=definitionOf(raw)
  if(['TASK','NOTIFY'].includes(d.action)&&!d.recipientMemberIds.length)throw new ApiError(400,'OUTCOME_RECIPIENT_REQUIRED','Выберите исполнителя задачи или получателя уведомления.')
  const roleIds=[...d.submitRoleIds,...d.stages.flatMap(s=>s.roleId?[s.roleId]:[])],memberIds=[...d.recipientMemberIds,...d.stages.flatMap(s=>s.memberId?[s.memberId]:[])]
  if(await db.accessRole.count({where:{organizationId:org,id:{in:[...new Set(roleIds)]}}})!==new Set(roleIds).size || await db.organizationMember.count({where:{organizationId:org,id:{in:[...new Set(memberIds)]},leftAt:null,user:{deletedAt:null}}})!==new Set(memberIds).size)throw new ApiError(400,'INVALID_WORKFLOW_AUDIENCE','Выберите действующих сотрудников и роли этой организации.')
  return d
}
export async function validateAnswers(db:DB,org:string,locationId:string,d:RequestDefinition,raw:unknown){
  const parsed = rawAnswers.safeParse(raw ?? {})
  if(!parsed.success)throw new ApiError(400,'INVALID_ANSWERS','Проверьте поля обращения.')
  const answers=parsed.data,result:RequestAnswers={}
  const references: Array<{ kind: 'MEMBER' | 'LOCATION'; id: string }> = []
  for(const f of d.fields){
    if(!visibleField(f,result))continue
    const v=answers[f.key];if(v===undefined||v===''){if(f.required&&f.kind!=='FILE')throw new ApiError(400,'REQUIRED_FIELD',`Заполните «${f.label}».`);continue}
    if(f.kind==='FILE')continue
    if(['NUMBER','MONEY'].includes(f.kind)){
      if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e12)throw new ApiError(400,'INVALID_NUMBER',`Проверьте «${f.label}».`)
      result[f.key]=v
    } else if(f.kind==='PERIOD'){
      const p=periodAnswer.safeParse(v)
      if(!p.success||!validDate(p.data.start)||!validDate(p.data.end)||p.data.start>p.data.end)throw new ApiError(400,'INVALID_PERIOD',`Проверьте «${f.label}».`)
      result[f.key]=p.data
    } else {
      if(typeof v!=='string'||v.length>2000||f.kind==='DATE'&&!validDate(v)||f.kind==='SELECT'&&!f.options.includes(v))throw new ApiError(400,'INVALID_FIELD',`Проверьте «${f.label}».`)
      result[f.key]=v
    }
    if(['MEMBER','LOCATION'].includes(f.kind)&&!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(String(v)))throw new ApiError(400,'INVALID_REFERENCE','Выберите значение из списка.')
    if(f.kind==='MEMBER'||f.kind==='LOCATION') references.push({kind:f.kind,id:String(v)})
  }
  const memberIds = [...new Set(references.filter(r => r.kind === 'MEMBER').map(r => r.id))]
  const locationIds = [...new Set(references.filter(r => r.kind === 'LOCATION').map(r => r.id))]
  const members = memberIds.length ? await db.organizationMember.findMany({where:{id:{in:memberIds},organizationId:org,leftAt:null,user:{deletedAt:null},locationMemberships:{some:{locationId,leftAt:null}}},select:{id:true}}) : []
  const locations = locationIds.length ? await db.organizationLocation.findMany({where:{id:{in:locationIds},organizationId:org,archivedAt:null},select:{id:true}}) : []
  const validMembers = new Set(members.map(m => m.id)), validLocations = new Set(locations.map(l => l.id))
  for (const reference of references) {
    if (reference.kind === 'MEMBER' && !validMembers.has(reference.id)) throw new ApiError(400,'INVALID_MEMBER','Сотрудник недоступен в этой точке.')
    if (reference.kind === 'LOCATION' && !validLocations.has(reference.id)) throw new ApiError(400,'INVALID_LOCATION','Точка недоступна.')
  }
  return result
}
function validDate(v:unknown){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v}
