import { authorizeExport } from '../../schedule/reports/export-jobs.ts'
import { reportBody } from '../../schedule/reports/report-schemas.ts'
import { prisma } from '../../db.ts'
import { adminPool } from '../database.ts'
import { ApiError } from '../../api-error.ts'
import type { ServiceAction } from './schemas.ts'
import { organizationService,accountService } from './read-model.ts'
import { organizationAvailable } from '../../organizations/service-state.ts'
export const queueReasons:Record<string,string>={OK:'Действие доступно',NOT_FOUND:'Задача не найдена',INVALID_COMMAND:'Неизвестное действие',INVALID_KIND:'Неизвестный вид задачи',SECURITY_MESSAGE:'Защищённое письмо: используйте штатную форму нового запроса',ALREADY_FINISHED:'Задача уже завершена',RUNNING:'Задача выполняется; дождитесь результата',EXPIRED:'Срок задачи истёк',ACCOUNT_UNAVAILABLE:'Создатель или получатель больше недоступен',ORGANIZATION_UNAVAILABLE:'Организация недоступна или приостановлена',NOT_PENDING:'Отменить можно только ожидающую задачу',ATTEMPTS_OR_STATE:'Повтор разрешён только после ошибки и до исчерпания попыток',QUEUE_LIMIT:'Достигнут лимит очереди',CHANGED:'Состояние задачи изменилось',INPUT_INVALID:'Параметры выгрузки несовместимы с текущей версией; создайте новую',PERMISSION_DENIED:'Создатель потерял право или область выгрузки; проверьте доступ и создайте новую',ERROR_NOT_RETRYABLE:'Эта причина ошибки требует новой выгрузки',LIMIT:'Достигнут лимит частоты или размера очереди'}
export async function previewQueue(jobs:Array<{kind:'email'|'report';id:string}>,command:'retry'|'cancel'){
 const rows=[] as Array<{kind:'email'|'report';id:string;expectedStatus:string;expectedAttempts:number;code:string;reason:string}>
 for(const ref of jobs){
  let code='OK',status='',attempts=0
  if(ref.kind==='email'){
   const job=await prisma.emailDelivery.findUnique({where:{id:ref.id},select:{status:true,attempts:true,sourceKind:true,category:true,createdAt:true,lockedUntil:true,organizationId:true,user:{select:{deletedAt:true,emailVerifiedAt:true}}}})
   if(!job)code='NOT_FOUND';else{status=job.status;attempts=job.attempts
    if(job.sourceKind==='MANDATORY'||!job.category)code='SECURITY_MESSAGE';else if(['SENT','SKIPPED'].includes(job.status))code='ALREADY_FINISHED';else if(job.lockedUntil&&job.lockedUntil>new Date())code='RUNNING';else if(+job.createdAt<=Date.now()-86400000)code='EXPIRED';else if(job.user.deletedAt||!job.user.emailVerifiedAt)code='ACCOUNT_UNAVAILABLE';else if(command==='cancel'&&status!=='PENDING')code='NOT_PENDING';else if(command==='retry'&&(status!=='FAILED'||attempts>=7))code='ATTEMPTS_OR_STATE'
    if(code==='OK'&&job.organizationId){const org=await prisma.organization.findUnique({where:{id:job.organizationId},select:{serviceState:true,serviceUntil:true,deletedAt:true}});if(!org||!organizationAvailable(org))code='ORGANIZATION_UNAVAILABLE'}
   }
  }else{
   const job=await prisma.reportExport.findUnique({where:{id:ref.id},select:{status:true,attempts:true,expiresAt:true,leaseUntil:true,input:true,errorCode:true,user:{select:{deletedAt:true}},organization:{select:{serviceState:true,serviceUntil:true,deletedAt:true}},organizationId:true,userId:true}})
   if(!job)code='NOT_FOUND';else{status=job.status;attempts=job.attempts
    if(job.expiresAt<=new Date())code='EXPIRED';else if(status==='RUNNING'||job.leaseUntil&&job.leaseUntil>new Date())code='RUNNING';else if(!organizationAvailable(job.organization))code='ORGANIZATION_UNAVAILABLE';else if(job.user.deletedAt||!await prisma.organizationMember.findFirst({where:{organizationId:job.organizationId,userId:job.userId,leftAt:null},select:{id:true}}))code='ACCOUNT_UNAVAILABLE';else if(command==='cancel'&&status!=='PENDING')code='NOT_PENDING';else if(command==='retry'&&(status!=='FAILED'||attempts>=3))code='ATTEMPTS_OR_STATE';else if(command==='retry'&&!['EXPORT_FAILED','EXPORT_INTERRUPTED','ORGANIZATION_STORAGE_QUOTA'].includes(job.errorCode??''))code='ERROR_NOT_RETRYABLE'
    if(code==='OK'&&command==='retry'){const parsed=reportBody.safeParse(job.input);if(!parsed.success)code='INPUT_INVALID';else try{await authorizeExport(job.userId,job.organizationId,parsed.data)}catch(error){if(error instanceof ApiError&&error.status<500)code='PERMISSION_DENIED';else throw error}}
   }
  }
  rows.push({...ref,expectedStatus:status,expectedAttempts:attempts,code,reason:queueReasons[code]??code})
 }
 return rows
}
export async function previewServiceAction(spec:ServiceAction,_actorId:string,authSessionId:string){
 let title='',consequences:string[]=[],allowed=true,details:unknown=null
 if(spec.action==='ORG_STATE'){
  const org=await organizationService(spec.targetId);allowed=!org.deleted&&org.version===spec.payload.version
  if(spec.payload.state==='SUSPENDED'&&spec.payload.until&&Date.parse(spec.payload.until)<=Date.now())allowed=false
  title=spec.payload.state==='SUSPENDED'?'Приостановить «'+org.name+'»':'Возобновить «'+org.name+'»'
  consequences=spec.payload.state==='SUSPENDED'?[`${org.resources.members} участников потеряют доступ к организации.`,`Файлы (${org.resources.files}) сохранятся; новые просмотры и скачивания будут закрыты.`,`Очередь (${org.resources.jobs} выгрузок) не будет брать новые задания; уже выполняемые операции повторно проверяют доступ.`,`Сроки подписки продолжаются. Плановое удаление по политике хранения не отменяется.`,spec.payload.until?'Доступ возобновится '+new Date(spec.payload.until).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК.':'До отдельного решения администратора.']:['Доступ вернётся в пределах действующих ролей и тарифа.','Задачи с действующим сроком смогут продолжить обработку.']
  details=org.resources
 }else if(spec.action==='PLAN_ADJUST'){
  const org=await organizationService(spec.targetId);allowed=!org.deleted&&org.subscriptionVersion===spec.payload.version
  if(!spec.payload.revoke&&(!spec.payload.endsAt||Date.parse(spec.payload.endsAt)<=Date.now()))allowed=false
  const selected=org.plans.find(p=>p.id===spec.payload.plan)
  title=spec.payload.revoke?'Снять временный тариф':'Предоставить временный тариф «'+(selected?.name??'')+'»'
  consequences=['Корректировка доступа не меняет покупки, реальные списания или возвраты.','После окончания действует обычная подписка на тот момент. Данные сверх квот сохранятся, добавление новых ресурсов ограничится.']
  if(selected)consequences.push(`Квоты: ${selected.members} участников, ${selected.locations} точек, ${Math.round(selected.storageBytes/1024**2)} МБ.`,`Сейчас: ${org.resources.members} участников, ${org.resources.locations} точек, ${Math.ceil(org.resources.storageBytes/1024**2)} МБ.`)
  details={resources:org.resources,limits:selected??null,paymentMode:'test'}
 }else if(spec.action==='USER_SESSION_REVOKE'){
  const session=await prisma.authSession.findUnique({where:{id:spec.targetId},select:{userId:true,lastUsedAt:true,revokedAt:true,idleExpiresAt:true,absoluteExpiresAt:true}})
  allowed=!!session&&session.userId===spec.payload.userId&&!session.revokedAt&&session.lastUsedAt.toISOString()===spec.payload.lastUsedAt&&session.idleExpiresAt>new Date()&&session.absoluteExpiresAt>new Date()&&spec.targetId!==authSessionId
  title='Завершить выбранный обычный сеанс';consequences=['На этом устройстве потребуется новый вход. Другие обычные сеансы сохранятся.','Если к этому сеансу привязана админка, её доступ также завершится.']
 }else if(spec.action==='USER_RECOVERY'){
  const user=await accountService(spec.targetId,{});allowed=user.version===spec.payload.version&&!['unverified','deleting'].includes(user.state)
  title='Направить штатное восстановление пользователю';consequences=['На подтверждённую почту уйдёт инструкция со ссылкой на штатную форму.','Пароль, способы входа и подтверждения не изменятся. Поддержка не получает код восстановления.']
 }else if(spec.action==='QUEUE_ACTION'){
  const rows=await previewQueue(spec.payload.jobs,spec.payload.command);allowed=rows.some(r=>r.code==='OK');title=spec.payload.command==='retry'?'Повторить подходящие задачи':'Отменить ожидающие задачи';details=rows
  consequences=['Сервер повторно проверит каждую задачу. Недоступные задачи пропустит с отдельной причиной.','Повтор письма использует ту же запись и проверяет актуальность уведомления и права получателя. Коды безопасности не повторяются.']
 }else if(spec.action==='FILE_CLEANUP_CONTROL'){
  const {rows:[file]}=await adminPool().query('SELECT * FROM staffly_admin.file_cleanup_directory WHERE id=$1',[spec.targetId]);allowed=!!file&&file.control_version===spec.payload.version&&(!spec.payload.retry||file.failed&&!file.hold&&!spec.payload.hold)
  title=spec.payload.retry?'Повторить очистку файла':spec.payload.hold?'Приостановить очистку файла':'Снять приостановку очистки файла';consequences=['Файл уже недоступен пользователям. Приостановка сохраняет байты, не возвращая доступ.','После снятия приостановки обработчик сможет удалить файл без возможности отмены.']
 }else if(spec.action==='CLEANUP_CONTROL'){
  const row=await prisma.dataDeletion.findUnique({where:{id:spec.targetId}});const {rows:[control]}=await adminPool().query('SELECT control_version FROM staffly_admin.cleanup_directory WHERE id=$1',[spec.targetId])
  allowed=!!row&&!row.completedAt&&control?.control_version===spec.payload.version
  if(spec.payload.retry&&(!row?.lastErrorCode||row.hold||row.dueAt>new Date()))allowed=false
  title=spec.payload.retry?'Запросить повтор очистки':spec.payload.hold?'Приостановить очистку':'Снять приостановку очистки'
  consequences=['Изменение не удаляет данные немедленно. Выполнение остаётся у обработчика хранения.','Снятие приостановки разрешает удаление после срока, если оператор включил окончательную очистку. Обратимость удаления не гарантируется.']
 }else if(spec.action==='CONTENT_PUBLISH'){
  const {rows:[revision]}=await adminPool().query('SELECT r.title,i.version,v.reviewed_at FROM staffly_admin.content_revisions r JOIN staffly_admin.content_items i ON i.id=r.item_id LEFT JOIN staffly_admin.content_reviews v ON v.revision_id=r.id WHERE r.id=$1',[spec.targetId]);allowed=!!revision?.reviewed_at&&revision.version===spec.payload.version;title='Опубликовать «'+(revision?.title??'версию')+'»';consequences=['Будет опубликована проверенная версия. Публикация прежней версии выполняет откат и сохраняет историю.','Для будущей даты текущая публикация останется доступной до вступления новой версии.']
 }else if(spec.action==='MAINTENANCE_WINDOW'){
  if(spec.targetId){
   const {rows:[window]}=await adminPool().query('SELECT version,status,prechecks,postchecks,app_version FROM staffly_admin.maintenance_windows WHERE id=$1',[spec.targetId])
   const transitions:Record<string,string[]>={PLANNED:['PLANNED','IN_PROGRESS','CANCELLED'],IN_PROGRESS:['IN_PROGRESS','VERIFYING','CANCELLED'],VERIFYING:['VERIFYING','IN_PROGRESS','COMPLETED','CANCELLED']}
   allowed=!!window&&window.version===spec.payload.version&&!!transitions[window.status]?.includes(spec.payload.status)
   if(allowed&&['IN_PROGRESS','COMPLETED'].includes(spec.payload.status)){const checks=spec.payload.status==='COMPLETED'?window.postchecks:window.prechecks;allowed=checks.passed===true&&Date.parse(checks.checkedAt)>Date.now()-15*60000&&window.app_version===(process.env.APP_VERSION||'development');if(!allowed)details={reason:'Повторите проверки готовности: нужен успешный результат за последние 15 минут для текущего выпуска.'}}
  }else allowed=spec.payload.status==='PLANNED'
  title=spec.targetId?'Изменить окно обслуживания':'Запланировать обслуживание';consequences=[spec.payload.readOnly?'В указанный период изменения в приложении будут приостановлены. Вход, выход и админка останутся доступны.':'В приложении появится объявление; доступ останется обычным.','Начало работ требует предварительных проверок; завершение — успешных проверок после работ.']
 }else if(spec.action==='BACKUP_SCHEDULE'){
  const {rows:[schedule]}=await adminPool().query('SELECT version FROM staffly_admin.backup_schedule WHERE id=1');allowed=schedule?.version===spec.payload.version
  title='Изменить расписание резервирования';consequences=[spec.payload.enabled?'Операторский обработчик будет создавать, проверять и очищать копии по расписанию.':'Автоматические запуски отключатся. Ручные задания останутся доступны.','Для файлов и независимого реестра удалений требуются отдельные настроенные каталоги. Их готовность показывается отдельно.']
 }else if(spec.action==='RESTORE_CHECK'){
  const {rows:[backup]}=await adminPool().query("SELECT EXISTS(SELECT 1 FROM staffly_admin.backups WHERE id=$1 AND file_state='AVAILABLE' AND verified_at IS NOT NULL AND expires_at>now()) available,EXISTS(SELECT 1 FROM staffly_admin.service_jobs WHERE kind='RESTORE_CHECK' AND target_id=$1 AND status IN ('PENDING','RUNNING') AND expires_at>now()) busy",[spec.targetId]);allowed=!!backup.available&&!backup.busy
  title='Запросить пробное восстановление';consequences=['Операторский процесс создаст отдельную временную базу в настроенном контуре проверки.','Рабочая база не восстанавливается и не перезаписывается. Результат появится после проверки схемы и связности.']
 }else if(spec.action==='DELIVERY_SETTINGS'){
  const {rows:[settings]}=await adminPool().query('SELECT version FROM staffly_admin.delivery_settings WHERE id=1');allowed=settings?.version===spec.payload.version
  title='Изменить внешнюю доставку сигналов';consequences=['Секреты и адрес проверяемого сервиса задаются отдельно у независимого обработчика.','Готовность канала подтверждается контрольным сигналом и подтверждением получателя.']
 }else{const {rows:[settings]}=await adminPool().query('SELECT enabled,recipients FROM staffly_admin.delivery_settings WHERE id=1');allowed=!!settings?.enabled&&settings.recipients.length>0;title='Запросить контрольный сигнал';consequences=['Независимый обработчик отправит сигнал настроенным получателям. Подтверждение получения фиксируется отдельно от принятия провайдером.']}
 return{allowed,title,consequences,details}
}
export async function checkServiceSpec(spec:ServiceAction,actorId:string,authSessionId:string){
 const preview=await previewServiceAction(spec,actorId,authSessionId)
 if(!preview.allowed)throw new ApiError(409,'ADMIN_ACTION_CHANGED','Действие недоступно или данные изменились. Проверьте предпросмотр и обновите сведения.')
 if(spec.action==='BACKUP_SCHEDULE'){const {rows:[row]}=await adminPool().query('SELECT version FROM staffly_admin.backup_schedule WHERE id=1');if(row.version!==spec.payload.version)throw new ApiError(409,'ADMIN_ACTION_CHANGED','Расписание уже изменилось.')}
 if(spec.action==='DELIVERY_SETTINGS'){const {rows:[row]}=await adminPool().query('SELECT version FROM staffly_admin.delivery_settings WHERE id=1');if(row.version!==spec.payload.version)throw new ApiError(409,'ADMIN_ACTION_CHANGED','Настройки уже изменились.')}
 // No content, passwords, codes or arbitrary client metadata enter the challenge summary.
 void actorId
 return preview.title+' · '+('targetId'in spec?spec.targetId:'сервис')+' · '+spec.payload.reason
}
