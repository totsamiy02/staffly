import { definitionOf, visibleField, type RequestAnswers, type RequestDefinition } from '../../app/requests/workflow.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { hasPermission, permissionRecipients } from '../organizations/access/access.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import type { prisma } from '../db.ts'
type DB=Prisma.TransactionClient | typeof prisma
export async function lockRequest(db: DB,id:string){await db.$queryRaw`SELECT id FROM requests WHERE id=${id}::uuid FOR UPDATE`}
export async function validateDefinition(db:DB,org:string,raw:unknown){
  const d=definitionOf(raw)
  if(['TASK','NOTIFY'].includes(d.action)&&!d.recipientMemberIds.length)throw new ApiError(400,'OUTCOME_RECIPIENT_REQUIRED','Выберите исполнителя задачи или получателя уведомления.')
  const roleIds=[...d.submitRoleIds,...d.stages.flatMap(s=>s.roleId?[s.roleId]:[])],memberIds=[...d.recipientMemberIds,...d.stages.flatMap(s=>s.memberId?[s.memberId]:[])]
  if(await db.accessRole.count({where:{organizationId:org,id:{in:[...new Set(roleIds)]}}})!==new Set(roleIds).size || await db.organizationMember.count({where:{organizationId:org,id:{in:[...new Set(memberIds)]},leftAt:null,user:{deletedAt:null}}})!==new Set(memberIds).size)throw new ApiError(400,'INVALID_WORKFLOW_AUDIENCE','Выберите действующих сотрудников и роли этой организации.')
  return d
}
export async function validateAnswers(db:DB,org:string,locationId:string,d:RequestDefinition,raw:unknown){
  const answers=(raw??{}) as RequestAnswers,result:RequestAnswers={}
  if(typeof answers!=='object'||Array.isArray(answers))throw new ApiError(400,'INVALID_ANSWERS','Проверьте поля обращения.')
  for(const f of d.fields){
    if(!visibleField(f,result))continue
    const v=answers[f.key];if(v===undefined||v===''){if(f.required&&f.kind!=='FILE')throw new ApiError(400,'REQUIRED_FIELD',`Заполните «${f.label}».`);continue}
    if(f.kind==='FILE')continue
    if(['NUMBER','MONEY'].includes(f.kind)){if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e12)throw new ApiError(400,'INVALID_NUMBER',`Проверьте «${f.label}».`)}
    else if(f.kind==='PERIOD'){const p=v as {start:string;end:string};if(!p||!validDate(p.start)||!validDate(p.end)||p.start>p.end)throw new ApiError(400,'INVALID_PERIOD',`Проверьте «${f.label}».`)}
    else if(typeof v!=='string'||v.length>2000||f.kind==='DATE'&&!validDate(v)||f.kind==='SELECT'&&!f.options.includes(v))throw new ApiError(400,'INVALID_FIELD',`Проверьте «${f.label}».`)
    if(['MEMBER','LOCATION'].includes(f.kind)&&!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(String(v)))throw new ApiError(400,'INVALID_REFERENCE','Выберите значение из списка.')
    if(f.kind==='MEMBER'&&!await db.organizationMember.findFirst({where:{id:String(v),organizationId:org,leftAt:null,locationMemberships:{some:{locationId,leftAt:null}}}}))throw new ApiError(400,'INVALID_MEMBER','Сотрудник недоступен в этой точке.')
    if(f.kind==='LOCATION'&&!await db.organizationLocation.findFirst({where:{id:String(v),organizationId:org,archivedAt:null}}))throw new ApiError(400,'INVALID_LOCATION','Точка недоступна.')
    result[f.key]=v
  }return result
}
function validDate(v:unknown){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v}
export async function stageReviewers(db:DB,item:{organizationId:string;locationId:string;createdByMemberId:string;formSnapshot:unknown;approvalStep:number;systemCodeSnapshot:string|null}){
  const d=definitionOf(item.formSnapshot),stage=d.stages[item.approvalStep],key=item.systemCodeSnapshot==='VACATION'?'vacations.resolve':'requests.resolve'
  const recipients=await permissionRecipients(db,item.organizationId,key,item.locationId)
  const filtered=[]
  for(const m of recipients){const user=await db.organizationMember.findUniqueOrThrow({where:{id:m.id},include:{accessAssignments:true,locationMemberships:true}});const actor=await getMembership(user.userId,item.organizationId,db)
    if(m.id===item.createdByMemberId&&!hasPermission(actor,'requests.selfResolve',item.locationId)&&!actor.owner)continue
    if(stage?.memberId&&stage.memberId!==m.id)continue
    if(stage?.roleId){const role=await db.accessRole.findUnique({where:{id:stage.roleId}});if(user.accessRoleId!==stage.roleId&&!user.accessAssignments.some(a=>a.locationId===item.locationId&&a.roleId===stage.roleId)&&!(!user.accessConfigured&&role?.systemCode&&user.locationMemberships.some(l=>l.locationId===item.locationId&&l.leftAt===null&&l.role===role.systemCode)))continue}
    filtered.push(m)
  }return filtered
}
export async function ensureReviewers(db:DB,item:Parameters<typeof stageReviewers>[1]){const people=await stageReviewers(db,item);if(!people.length)throw new ApiError(409,'NO_REVIEWER','Нет доступного согласующего. Владелец должен проверить маршрут и права роли.');return people}
export async function notifyStage(db:DB,item:Parameters<typeof stageReviewers>[1]&{id:string;typeNameSnapshot:string},recipients?:Awaited<ReturnType<typeof stageReviewers>>){const people=recipients??await stageReviewers(db,item);if(people.length)await db.accountNotification.createMany({data:people.map(p=>({organizationId:item.organizationId,userId:p.userId,requestId:item.id,type:'REQUEST_CREATED',title:'Обращение на рассмотрении',message:item.typeNameSnapshot}))})}
export async function canReadCustom(db:DB,actor:Awaited<ReturnType<typeof getMembership>>,item:{createdByMemberId:string;authorMemberId:string|null;locationId:string;formSnapshot:unknown;outcome?:unknown},roles?:Array<{id:string;systemCode:string|null}>){
  if(actor.owner||item.createdByMemberId===actor.id||item.authorMemberId===actor.id)return true
  const outcome=item.outcome as {assignees?:string[]}|null
  if(outcome?.assignees?.includes(actor.id))return hasPermission(actor,'requests.own',item.locationId)
  if(!hasPermission(actor,'requests.view',item.locationId))return false
  const d=definitionOf(item.formSnapshot)
  if(d.visibility==='TEAM')return true
  if(!d.stages.length)return hasPermission(actor,'requests.resolve',item.locationId)||d.version===undefined
  for(const stage of d.stages){if(stage.memberId===actor.id)return true;if(stage.roleId){const role=roles?roles.find(role=>role.id===stage.roleId):await db.accessRole.findFirst({where:{id:stage.roleId,organizationId:actor.organizationId}});if(actor.accessRoleId===stage.roleId||actor.accessAssignments.some(a=>a.locationId===item.locationId&&a.roleId===stage.roleId)||!actor.accessConfigured&&role?.systemCode===actor.role)return true}}
  return false
}
