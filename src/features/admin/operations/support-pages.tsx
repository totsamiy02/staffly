import type { ReactNode } from 'react'
import { Link,useParams,useSearchParams } from 'react-router-dom'
import { SupportReference } from '../../../component/ui/request-error-message.tsx'
import { useAdminData } from '../admin-data.tsx'
import { Loading,ReadError } from '../admin-feedback.tsx'
import { AdminBadge,AdminIcon,Empty,PageHead,Pagination,Panel,Stat,count,date } from '../admin-elements.tsx'
import { CopyDiagnostics,EntityLinks,KeyValues,OperationsToolbar } from './elements.tsx'
import { incidentExplanation,incidentSources } from './diagnostic-presentation.ts'
import type { RequestDiagnostic,SupportState } from './contracts.ts'

function RequestDiagnostics(){
  const [params]=useSearchParams(),{data,error,refresh}=useAdminData<SupportState>('/operations/support?'+params.toString())
  if(!data)return <Loading error={error} retry={refresh}/>
  return <><ReadError error={error} retry={refresh}/><div className="admin-stats">
    <Stat label="Найдено записей" value={count(data.total)} note="по выбранным условиям" icon="search"/>
    <Stat label="За последний час" value={count(data.summary.recent)} note="среди найденных записей" icon="clock"/>
    <Stat label="Серверные сбои" value={count(data.summary.server)} note="ответы 5xx в результатах" icon="server"/>
    <Stat label="Ошибки обработчиков" value={count(data.summary.background)} note="письма, отчёты и служебные циклы" icon="layers"/>
  </div><Panel title="Журнал диагностики" subtitle="Код из сообщения об ошибке ведёт к контексту и безопасной причине">
    <div className="admin-table-wrap"><table><thead><tr><th>Код поддержки</th><th>Что произошло</th><th>Пользователь и организация</th><th>Время · МСК</th><th><span className="admin-sr-only">Действия</span></th></tr></thead><tbody>
      {data.items.map(item=><tr key={item.id}><td><SupportReference value={item.id}/><AdminBadge tone={item.kind==='client'?'gray':item.status>=500||item.kind!=='request'?'amber':'purple'}>{incidentSources[item.kind]}</AdminBadge></td>
        <td><strong>{incidentExplanation(item).title}</strong><small className="admin-ops-route">{item.eventCode??item.diagnostic.code??(item.status?'HTTP '+item.status:item.taskName)}</small>{item.jobId&&<SupportReference value={item.jobId} label="ID задачи"/>}</td>
        <td><EntityLinks {...item}/></td><td>{date(item.createdAt,true)}</td><td><Link className="admin-btn" to={'/admin/operations/support/'+item.id}>Разобрать</Link></td></tr>)}
    </tbody></table>{!data.items.length&&<Empty>По этим условиям записей нет. Проверьте код или сбросьте фильтры. Запросы появляются в течение 10 секунд, сообщение с устройства без интернета — после восстановления связи.</Empty>}</div><Pagination {...data}/>
  </Panel></>
}
export function SupportPage(){
  return <><PageHead title="Поддержка" subtitle="Разбор обращений по коду ошибки и данным пользователя"/>
    <p className="admin-ops-intro">Пользователь копирует код из сообщения об ошибке и передаёт его вместе с описанием действия. Здесь доступны запросы сайта, сбои писем и отчётов, служебных циклов и сообщения браузера. Если кода нет, ищите по имени, организации или их ID и времени.</p>
    <OperationsToolbar support label="Поиск диагностики" placeholder="Код поддержки, имя или организация"/><RequestDiagnostics/>
    <details className="admin-ops-help"><summary>Что передать пользователю и где найти код?</summary><p>В сообщении об ошибке есть «Код для поддержки» и копирование. Свой числовой ID пользователь найдёт в меню профиля. ID организации владелец видит в профиле организации. У выгрузки также есть ID задачи. Для обращения о неполученном письме достаточно ID пользователя и времени. Сообщения браузера помечены отдельно: их содержание не является подтверждением серверного сбоя.</p></details>
    <p className="admin-history-note">Хранение — 30 дней с момента включения соответствующего сбора. Полные тексты исключений, введённые данные, письма, пароли и токены не собираются. Код помогает найти запись; точная причина иногда требует воспроизведения и серверного журнала.</p>
  </>
}
export function SupportDiagnosticPage(){
  const {id=''}=useParams(),{data,error,refresh}=useAdminData<RequestDiagnostic>('/operations/support/'+id)
  if(!data)return <><PageHead title="Разбор сбоя" subtitle="Диагностика по коду поддержки" backTo="/admin/operations/support"/><Loading error={error} retry={refresh}/></>
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
  return <><PageHead title="Разбор сбоя" subtitle={incidentSources[data.kind]} backTo="/admin/operations/support" actions={<AdminBadge tone={data.kind==='client'?'gray':'amber'}>{data.status?'HTTP '+data.status:incidentSources[data.kind]}</AdminBadge>}/>
    <ReadError error={error} retry={refresh}/>{data.kind==='client'&&<p className="admin-notice">Сообщение устройства. Указанный раздел и тип ошибки переданы браузером; сервер не подтверждает описанную причину.</p>}
    <div className="admin-grid admin-columns"><Panel title="Что произошло" subtitle={explanation.title}><KeyValues items={fields}/></Panel>
      <Panel title="Контекст и следующий шаг"><EntityLinks {...data}/><div className="admin-ops-explanation"><AdminIcon name="help"/><p>{explanation.advice}</p></div><p className="admin-note">Для обращения достаточно кода поддержки, времени и описания действия. Сохранённая ошибка — история конкретной попытки: состояние задачи после неё могло измениться.</p></Panel>
    </div><Panel title="Сводка для разбора"><CopyDiagnostics text={text}/></Panel></>
}
