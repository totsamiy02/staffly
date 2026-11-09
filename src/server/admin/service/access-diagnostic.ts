import { z } from 'zod'
import { prisma } from '../../db.ts'
import { getMembership } from '../../organizations/access/permissions.ts'
import { locationContext } from '../../organizations/location-context.ts'
import { hasPermission } from '../../organizations/access/access.ts'
import { canReadDocument,docPermission,folderReadable } from '../../access/document-policy.ts'
import { effectiveSubscription,featurePlans,plans,type PlanFeature } from '../../../app/subscriptions/plans.ts'
import { permissionKeys,type Permission } from '../../../app/access/catalog.ts'
import { ApiError } from '../../api-error.ts'
import { organizationAvailable } from '../../organizations/service-state.ts'
const reference=z.string().trim().max(36).refine(v=>z.uuid().safeParse(v).success||/^#?[1-9]\d{0,9}$/.test(v),'Укажите UUID или короткий номер.')
const input=z.object({userId:reference,organizationId:reference,locationId:z.uuid().optional(),action:z.enum(permissionKeys),documentId:z.uuid().optional()}).strict()
type Step={key:string;allowed:boolean;reason:string;next:string|null}
export async function diagnoseAccess(value:unknown){
 const original=input.parse(value),numeric=(v:string)=>/^#?[1-9]\d{0,9}$/.test(v),[selectedUser,selectedOrg]=await Promise.all([prisma.user.findUnique({where:numeric(original.userId)?{publicId:Number(original.userId.replace('#',''))}:{id:original.userId},select:{id:true}}),prisma.organization.findUnique({where:numeric(original.organizationId)?{publicId:Number(original.organizationId.replace('#',''))}:{id:original.organizationId},select:{id:true}})]),q={...original,userId:selectedUser?.id??'00000000-0000-4000-8000-000000000000',organizationId:selectedOrg?.id??'00000000-0000-4000-8000-000000000000'},steps:Step[]=[],add=(key:string,allowed:boolean,reason:string,next:string|null=null)=>steps.push({key,allowed,reason,next:allowed?null:next})
 const [user,organization,member]=await Promise.all([
  prisma.user.findUnique({where:{id:q.userId},select:{deletedAt:true,emailVerifiedAt:true}}),prisma.organization.findUnique({where:{id:q.organizationId},select:{id:true,deletedAt:true,serviceState:true,serviceUntil:true,subscription:true}}),prisma.organizationMember.findUnique({where:{organizationId_userId:{organizationId:q.organizationId,userId:q.userId}},select:{id:true,leftAt:true}})
 ])
 add('account',!!user&&!user.deletedAt&&!!user.emailVerifiedAt,!user?'Аккаунт не найден':user.deletedAt?'Аккаунт удаляется':!user.emailVerifiedAt?'Почта не подтверждена':'Аккаунт действующий','Проверьте состояние аккаунта и штатный вход.')
 add('organization',!!organization&&organizationAvailable(organization),!organization?'Организация не найдена':organization.deletedAt?'Организация удаляется':!organizationAvailable(organization)?'Работа организации приостановлена':'Организация доступна','Откройте состояние организации.')
 add('membership',!!member&&!member.leftAt,!member?'Нет членства':member.leftAt?'Участник покинул организацию':'Членство действует','Владелец должен проверить приглашение и членство.')
 if(steps.some(s=>!s.allowed))return{allowed:false,steps,role:null,resource:null,permission:q.action}
 return locationContext.run({organizationId:q.organizationId,locationId:q.locationId,memberships:new Map()},async()=>{
  let actor:Awaited<ReturnType<typeof getMembership>>
  try{actor=await getMembership(q.userId,q.organizationId)}catch(error){if(!(error instanceof ApiError))throw error;add('location',false,error.message,'Проверьте точку и назначение участника.');return{allowed:false,steps,role:null,resource:null,permission:q.action}}
  const point=q.locationId??actor.locationId
  if(q.locationId)add('location',actor.owner||actor.readableLocationIds.includes(point),'Доступ к выбранной точке '+(actor.owner||actor.readableLocationIds.includes(point)?'есть':'не назначен'),'Владелец должен проверить назначение на точку и локальную роль.')
  const key=q.action as Permission,documentAction=key.startsWith('documents.'),permission=documentAction?docPermission(actor,key,q.locationId??null):hasPermission(actor,key,q.locationId)
  add('permission',permission,permission?'Итоговая роль разрешает действие':'В общей и локальной роли нет нужного разрешения','Владелец должен проверить разрешение «'+q.action+'» в назначенных ролях.')
  const feature:PlanFeature|undefined=key.startsWith('reports.')?'reports':key.startsWith('drafts.')||key.startsWith('demand.')?'planning':undefined
  const subscription=organization!.subscription?effectiveSubscription(organization!.subscription):null
  if(feature)add('plan',!!subscription?.features.includes(feature),subscription?.features.includes(feature)?'Тариф поддерживает функцию':'Нужен тариф «'+plans[featurePlans[feature]].name+'»','Проверьте подписку или временный тариф.')
  const writes=!/\.(view|download|own|export)$/.test(key)
  if(writes)add('subscriptionWrite',!subscription?.readOnly,subscription?.readOnly?'Подписка ограничивает изменения':'Изменения по подписке доступны','Продлите подписку или согласуйте временный тариф.')
  let resource:{id:string;locationId:string|null;visibility:string;folderIds:string[];contentAvailable:boolean}|null=null
  if(q.documentId){
   if(!documentAction)throw new ApiError(400,'ADMIN_DIAGNOSTIC_INPUT','Для документа выберите действие модуля документов.')
   const doc=await prisma.document.findFirst({where:{id:q.documentId,organizationId:q.organizationId},select:{id:true,organizationId:true,locationId:true,visibility:true,targetMemberId:true,deletedAt:true,audienceRoleIds:true,audienceMemberIds:true,inheritAccess:true,folderId:true,storedFile:{select:{pendingDeletionAt:true,purgedAt:true}}}})
   add('document',!!doc,doc?'Документ принадлежит выбранной организации':'Документ в этой организации не найден','Сверьте ID документа и организации.')
   if(doc){
    if(q.locationId)add('resourceLocation',doc.locationId===null||doc.locationId===q.locationId,'Область документа '+(doc.locationId===null?'общая':doc.locationId===q.locationId?'совпадает с выбранной точкой':'отличается от выбранной точки'),'Выберите точку документа.')
    add('audience',canReadDocument(actor,doc),'Проверены аудитория документа, личный доступ и права на архив','Проверьте аудиторию документа и право на личные документы.')
    if(key!=='documents.view')add('documentAction',docPermission(actor,key,doc.locationId),'Проверено разрешение в области самого документа','Проверьте разрешение в общей или локальной роли документа.')
    const visited=new Set<string>();let parent=doc.folderId
    while(parent){
     if(visited.has(parent)||visited.size>=100){add('folder',false,'Обнаружен цикл или недопустимая глубина папок','Исправьте структуру папок.');break}
     visited.add(parent)
     const folder=await prisma.documentFolder.findFirst({where:{id:parent,organizationId:q.organizationId},select:{id:true,parentId:true,locationId:true,visibility:true,audienceRoleIds:true,audienceMemberIds:true,inheritAccess:true,systemKey:true}})
     if(!folder){add('folder',false,'Родительская папка не найдена в организации','Проверьте структуру папок.');break}
     add('folder:'+folder.id,folderReadable(actor,folder),'Проверен доступ к папке '+folder.id,'Владелец должен проверить аудиторию и область этой папки.');parent=folder.parentId
    }
    const available=!!doc.storedFile&&!doc.storedFile.pendingDeletionAt&&!doc.storedFile.purgedAt
    if(key==='documents.download')add('file',available,available?'Запись файла действующая; наличие байтов проверяется отдельно':'Запись файла отсутствует или файл ожидает удаления','Проверьте состояние хранения; доступ не восстановит удалённые байты.')
    resource={id:doc.id,locationId:doc.locationId,visibility:doc.visibility,folderIds:[...visited],contentAvailable:available}
   }
  }
  return{allowed:steps.every(s=>s.allowed),steps,role:actor.roleName,permission:q.action,resource}
 })
}
