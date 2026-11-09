import ConsoleLayout from '../console-layout.tsx'
import AdminDisclosure from '../admin-disclosure.tsx'
import { useState } from 'react'
import { useParams,useSearchParams } from 'react-router-dom'
import CopyReference from '../../../component/ui/copy-reference.tsx'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import { useAdmin,useAdminData } from '../admin-data.tsx'
import { AdminLink as Link } from '../admin-link.tsx'
import { AdminBadge,Empty,PageHead,Pagination,Panel,Stat,count,date } from '../admin-elements.tsx'
import { Loading,ReadError } from '../admin-feedback.tsx'
import AdminTabs from '../admin-tabs.tsx'
import { OperationsToolbar,KeyValues } from '../operations/elements.tsx'
import { metricValue } from '../admin-format.ts'
import { alertCatalog,type AlertKey } from './catalog.ts'
import { Frame,useAction } from './shared.tsx'
import RuleCard from './rule-card.tsx'
import WorkPanel from './work-panel.tsx'
import type { AlertsState } from './contracts.ts'
import type { alertDetails } from '../../../server/admin/management/work.ts'
type AlertDetails=Awaited<ReturnType<typeof alertDetails>>
export default function AlertsPage(){
 const [params,setParams]=useSearchParams(),view=['history','rules'].includes(params.get('view')??'')?params.get('view')!:'active',query=new URLSearchParams(params)
 if(!query.has('status'))query.set('status',view==='history'?'resolved':'open')
 const {request}=useAdmin(),{data,error,refresh,readState}=useAdminData<AlertsState>('/management/alerts?'+query),action=useAction(refresh),[ackError,setAckError]=useState<Error|null>(null),[pending,setPending]=useState(false)
 if(!data)return <Loading error={error} retry={refresh}/>
 return <Frame title="Оповещения" className={'admin-console--alerts-'+view} actions={view!=='rules'&&<button type="button" className="admin-btn admin-btn--primary" onClick={()=>{const next=new URLSearchParams(params);next.set('view','rules');next.delete('page');setParams(next)}}>Настроить правила</button>} error={error} refresh={refresh} readState={readState}>{action.feedback}
  <div className="admin-stats"><Stat decorate label="Активные оповещения" value={count(data.summary.open)} icon="bell"/><Stat decorate label="Новые" value={count(data.summary.unread)} icon="help"/><Stat decorate label="Критические" value={count(data.summary.critical)} icon="shield"/><Stat decorate label="Устранены" value={count(data.summary.resolved)} icon="check"/></div>
  <AdminTabs label="Раздел оповещений" value={view} items={[["active","Активные"],["history","История"],["rules","Правила"]]} onChange={next=>{const q=new URLSearchParams(params);q.set('view',next);q.delete('status');q.delete('page');setParams(q)}}/>
  {view==='rules'?<section role="tabpanel" aria-label="Правила"><Panel title="Правила обнаружения" subtitle="Внешняя доставка оповещений не настроена"><div className="admin-management-rules">{data.rules.map(rule=><RuleCard key={rule.id} rule={rule} open={action.open}/>)}</div></Panel></section>:<section role="tabpanel" aria-label={view==='history'?'История':'Активные'}>
  <OperationsToolbar label="Поиск оповещений" placeholder="Название правила или ID оповещения" filters={[{key:'status',label:'Состояние',defaultValue:view==='history'?'resolved':'open',options:view==='history'?{resolved:'Устранены',all:'Вся история'}:{open:'Все активные',new:'Новые',acknowledged:'Приняты к рассмотрению'}},{key:'severity',label:'Важность',options:{all:'Любая важность',critical:'Критические',warning:'Предупреждения'}}]}/>
  {ackError&&<p role="alert"><RequestErrorMessage error={ackError}/></p>}<Panel title={view==='history'?'История оповещений':'Активные оповещения'} subtitle={data.checkedAt?'Условия проверены '+date(data.checkedAt,true)+' · МСК':'Ожидаем первую проверку'}><div className="admin-management-alerts">{data.items.map(alert=>{const info=alertCatalog[alert.key as AlertKey];return <article className="admin-management-alert" data-severity={alert.severity} data-resolved={Boolean(alert.resolvedAt)} key={alert.id}>
   <div className="admin-management-alert-icon" aria-hidden="true">!</div><div><div className="admin-actions"><AdminBadge tone={alert.severity==='critical'?'amber':'purple'}>{alert.severity==='critical'?'Критическое':'Предупреждение'}</AdminBadge><AdminBadge tone={alert.resolvedAt?'green':'gray'}>{alert.resolvedAt?'Устранено':alert.acknowledgedAt?'Принято':'Новое'}</AdminBadge></div><h3>{info?.title??alert.key}</h3><p>{metricValue(alert.key,alert.measured)} · порог {metricValue(alert.key,alert.threshold)} · {info?.window}</p><small>{date(alert.firstSeenAt,true)} · МСК</small><p>Принял: {alert.acknowledgedName??'Ещё не принято'}{alert.acknowledgedAt?' · '+date(alert.acknowledgedAt,true):''}</p><p><strong>Ответственный: {alert.assigneeName??'Не назначен'}</strong>{alert.assigneeName&&!alert.assigneeAvailable?' · доступ отозван':''}</p><AdminDisclosure label={<>Идентификатор</>}><CopyReference value={alert.id} label="ID оповещения"/></AdminDisclosure></div>
   <div className="admin-alert-actions"><Link className="admin-btn admin-btn--primary" to={'/admin/management/alerts/'+alert.id}>Разобрать</Link>{!alert.resolvedAt&&!alert.acknowledgedAt&&<button type="button" className="admin-btn" disabled={pending} onClick={()=>{setPending(true);setAckError(null);void request('/management/alerts/'+alert.id+'/acknowledge',{method:'POST',body:{confirm:true}}).then(refresh).catch(setAckError).finally(()=>setPending(false))}}>Принять к рассмотрению</button>}</div>
  </article>})}{!data.items.length&&<Empty>Оповещений по выбранным условиям нет.</Empty>}</div><Pagination {...data}/></Panel></section>}
 </Frame>
}
export function AlertDetailsPage(){
 const {id=''}=useParams(),{request}=useAdmin(),{data,error,refresh,readState}=useAdminData<AlertDetails>('/management/alerts/'+id),[busy,setBusy]=useState(false),[ackError,setAckError]=useState<Error|null>(null)
 if(!data)return <><PageHead title="Разбор оповещения" backTo="/admin/management/alerts"/><Loading error={error} retry={refresh}/></>
 const info=alertCatalog[data.key as AlertKey],source=data.key==='API_ERRORS'?'/admin/operations/support?source=request&level=actionable&days=1':data.key.startsWith('EMAIL')?'/admin/operations/jobs?kind=email&attention=yes':data.key.startsWith('REPORT')?'/admin/operations/jobs?kind=report&attention=yes':data.key.startsWith('BACKUP')?'/admin/management/backups':data.key==='ADMIN_DENIALS'?'/admin/management/security?view=journal&outcome=DENIED&days=1':'/admin/operations/service'
 return <ConsoleLayout className="admin-console--alert-detail" section="Управление / Оповещения"><PageHead title="Разбор оповещения" subtitle={info?.title??data.key} backTo="/admin/management/alerts" actions={<AdminBadge tone={data.severity==='critical'?'amber':'purple'}>{data.severity==='critical'?'Критическое':'Предупреждение'}</AdminBadge>}/><ReadError state={readState}/><Panel title={info?.title??data.key} subtitle={info?.description}><KeyValues items={[["Состояние",data.resolvedAt?'Устранено':data.acknowledgedAt?'Принято к просмотру':'Новое'],['Появилось',date(data.firstSeenAt,true)],['Последняя проверка',date(data.lastSeenAt,true)],['Принял',data.acknowledgedName??'Ещё не принято'],['Принято',date(data.acknowledgedAt,true)],['Устранено',date(data.resolvedAt,true)],['Последний замер',metricValue(data.key,data.measured)],['ID оповещения',<CopyReference key="id" value={id} label="ID оповещения"/>]]}/>{ackError&&<p role="alert"><RequestErrorMessage error={ackError}/></p>}<div className="admin-actions"><Link className="admin-btn" to={source}>Открыть источник сигнала</Link><Link className="admin-btn" to="/admin/management/alerts?view=rules">Правила обнаружения</Link>{!data.resolvedAt&&!data.acknowledgedAt&&<button type="button" className="admin-btn" disabled={busy} onClick={()=>{setBusy(true);void request('/management/alerts/'+id+'/acknowledge',{method:'POST',body:{confirm:true}}).then(refresh).catch(setAckError).finally(()=>setBusy(false))}}>Принять к рассмотрению</button>}</div></Panel><WorkPanel kind="alert" id={id}/></ConsoleLayout>
}
