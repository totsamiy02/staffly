import ConsoleLayout from '../console-layout.tsx'
import { AdminLink as Link } from '../admin-link.tsx'
import AdminPopover from '../admin-popover.tsx'
import WorkPanel from '../management/work-panel.tsx'
import AdminTable from '../admin-table.tsx'
import type { ReactNode } from 'react'
import { useParams,useSearchParams } from 'react-router-dom'
import { SupportReference } from '../../../component/ui/request-error-message.tsx'
import { useAdminData } from '../admin-data.tsx'
import { Loading,ReadError } from '../admin-feedback.tsx'
import { AdminHelp, AdminBadge,AdminIcon,Empty,PageHead,Pagination,Panel,Stat,count,date } from '../admin-elements.tsx'
import { CopyDiagnostics,EntityLinks,KeyValues,OperationsToolbar } from './elements.tsx'
import { incidentExplanation,incidentSources } from './diagnostic-presentation.ts'
import type { RequestDiagnostic,SupportState } from './contracts.ts'

function RequestDiagnostics(){
  const [params]=useSearchParams(),{data,error,refresh,readState}=useAdminData<SupportState>('/operations/support?'+params.toString())
  if(!data)return <Loading error={error} retry={refresh}/>
  return <><ReadError error={error} retry={refresh} state={readState}/><div className="admin-stats">
    <Stat decorate label="Найдено записей" value={count(data.total)} icon="search"/>
    <Stat decorate label="За последний час" value={count(data.summary.recent)} icon="clock"/>
    <Stat decorate label="Серверные сбои" value={count(data.summary.server)} icon="server"/>
    <Stat decorate label="Ошибки обработчиков" value={count(data.summary.background)} icon="layers"/>
  </div><Panel title="Журнал диагностики" subtitle="Хранение — 30 дней">
    <OperationsToolbar support label="Поиск диагностики" placeholder="Код поддержки, имя или организация" searchHelp={<AdminHelp label="Как найти обращение?">Код поддержки копируется из сообщения об ошибке. ID пользователя — в профиле; ID организации — в её профиле. Для неполученного письма достаточно пользователя и времени. Сообщение браузера не подтверждает серверную причину сбоя.</AdminHelp>}/><AdminTable primary={[1,3]} title={1} actions={[4]}><table><thead><tr><th>Код поддержки</th><th>Что произошло</th><th>Пользователь и организация</th><th>Время · МСК</th><th><span className="admin-sr-only">Действия</span></th></tr></thead><tbody>
      {data.items.map(item=><tr key={item.id}><td><AdminPopover label="Код поддержки"><SupportReference value={item.id}/></AdminPopover><AdminBadge tone={item.kind==='client'?'gray':item.status>=500||item.kind!=='request'?'amber':'purple'}>{incidentSources[item.kind]}</AdminBadge></td>
        <td><strong>{incidentExplanation(item).title}</strong><small className="admin-ops-route">{item.eventCode??item.diagnostic.code??(item.status?'HTTP '+item.status:item.taskName)}</small>{item.jobId&&<AdminPopover label="ID задачи"><SupportReference value={item.jobId} label="ID задачи"/></AdminPopover>}</td>
        <td><EntityLinks {...item} compact/></td><td>{date(item.createdAt,true)}</td><td><Link className="admin-btn" to={'/admin/operations/support/'+item.id}>Разобрать</Link></td></tr>)}
    </tbody></table>{!data.items.length&&<Empty>По этим условиям записей нет. Проверьте код или сбросьте фильтры. Запросы появляются в течение 10 секунд, сообщение с устройства без интернета — после восстановления связи.</Empty>}</AdminTable><Pagination {...data}/>
  </Panel></>
}
export function SupportPage(){
  return <ConsoleLayout section="Операции / Поддержка" className="admin-console--support"><PageHead title="Поддержка" actions={<Link className="admin-btn" to="/admin/operations/access">Проверить доступ</Link>}/>

    <RequestDiagnostics/>


  </ConsoleLayout>
}
export function SupportDiagnosticPage(){
  const {id=''}=useParams(),{data,error,refresh,readState}=useAdminData<RequestDiagnostic>('/operations/support/'+id)
  if(!data)return <><PageHead title="Разбор сбоя" backTo="/admin/operations/support"/><Loading error={error} retry={refresh}/></>
  const explanation=incidentExplanation(data)
  const text=['Staffly · код поддержки '+data.id,'Время UTC: '+data.createdAt,'Источник: '+incidentSources[data.kind],'Событие: '+(data.eventCode??'—'),'Запрос: '+data.method+' '+data.route,'HTTP: '+(data.status||'не HTTP'),'Диагностика: '+(data.diagnostic.code??data.diagnostic.name),'Задача: '+(data.jobId??'—'),'Попытка: '+(data.attempt??'—')+'/'+(data.maxAttempts??'—'),'Организация: '+(data.organizationId??'—'),'Пользователь: '+(data.userId??'—'),'Следующий шаг: '+explanation.advice].join('\n')
  const fields:Array<[string,ReactNode]>=[
    ['Код поддержки',<SupportReference key="id" value={data.id}/>],['Время МСК',date(data.createdAt,true)],['Источник',incidentSources[data.kind]],
    ['Событие',data.eventCode??'Не классифицировано'],['Маршрут / раздел',<code key="route">{data.route}</code>],
    ...(data.status?[['Метод',data.method],['Ответ сервера',data.status]] as Array<[string,ReactNode]>:[]),
    ['Класс ошибки',data.diagnostic.name],['Код причины',data.diagnostic.code??'Не классифицирован'],
    ...(data.jobId?[['ID задачи',<SupportReference key="job" value={data.jobId} label="ID задачи"/>],['Попытка',(data.attempt??'—')+' из '+(data.maxAttempts??'—')],['Следующая попытка',data.nextAttemptAt?date(data.nextAttemptAt,true):'Автоматический повтор не запланирован']] as Array<[string,ReactNode]>:[]),
    ...(data.taskName?[['Обработчик',data.taskName]] as Array<[string,ReactNode]>:[]),
  ]
  return <ConsoleLayout section="Операции / Поддержка" className="admin-console--diagnostic"><PageHead title="Разбор сбоя" subtitle={incidentSources[data.kind]} backTo="/admin/operations/support" actions={<AdminBadge tone={data.kind==='client'?'gray':'amber'}>{data.status?'HTTP '+data.status:incidentSources[data.kind]}</AdminBadge>}/>
    <ReadError error={error} retry={refresh} state={readState}/>{data.kind==='client'&&<p className="admin-notice">Сообщение устройства. Указанный раздел и тип ошибки переданы браузером; сервер не подтверждает описанную причину.</p>}
    <section className="admin-console-incident-summary"><AdminIcon name="bell"/><div><strong>{explanation.title}</strong><p>{date(data.createdAt,true)} · МСК · {incidentSources[data.kind]}</p></div></section><div className="admin-grid admin-columns"><Panel title={explanation.title}><KeyValues items={fields}/></Panel>
      <Panel title="Контекст и следующий шаг"><EntityLinks {...data}/>{data.jobId&&data.jobKind&&<Link className="admin-btn" to={data.jobKind==='backup'?'/admin/management/backups?job='+data.jobId:`/admin/operations/jobs/${data.jobKind}/${data.jobId}`}>Открыть связанную задачу</Link>}<div className="admin-ops-explanation"><AdminIcon name="help"/><p>{explanation.advice}</p></div><p className="admin-note">Состояние задачи после этого сбоя могло измениться.</p></Panel>
    </div><Panel title="Хронология"><ol className="admin-console-timeline"><li><time dateTime={data.createdAt}>{date(data.createdAt,true)} · МСК</time><strong>{explanation.title}</strong></li>{data.nextAttemptAt&&<li><time dateTime={data.nextAttemptAt}>{date(data.nextAttemptAt,true)} · МСК</time><strong>Запланирована следующая попытка</strong></li>}</ol></Panel><WorkPanel kind="diagnostic" id={data.id}/><Panel title="Сводка для разбора"><CopyDiagnostics text={text}/></Panel></ConsoleLayout>
}
