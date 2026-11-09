import { useSearchParams } from 'react-router-dom'
import { useAdminData } from '../admin-data.tsx'
import { PageHead,Panel,AdminBadge,date } from '../admin-elements.tsx'
import { Loading,ReadError } from '../admin-feedback.tsx'
import AdminTabs from '../admin-tabs.tsx'
import BackupOperations from './backups.tsx'
import CleanupPanel from './cleanup.tsx'
import ReleasePanel from './release.tsx'
import SignalsPanel from './signals.tsx'
import ContentPanel from './content.tsx'
import ServiceReports from './reports.tsx'
import { serviceStates } from './elements.tsx'
import type { maintenanceState } from '../../../server/admin/service/read-model.ts'
import './service.scss'
export default function MaintenancePage(){
 const [params,setParams]=useSearchParams(),tabs:Array<[string,string]>=[['backups','Резервирование'],['cleanup','Хранение и удаление'],['release','Обслуживание и выпуск'],['content','Публичный контент'],['signals','Внешние сигналы'],['reports','Отчёт команды']],tab=tabs.some(([key])=>key===params.get('tab'))?params.get('tab')!:'backups'
 const {data,error,refresh,readState}=useAdminData<Awaited<ReturnType<typeof maintenanceState>>>('/service/maintenance')
 if(!data)return <Loading error={error} retry={refresh}/>
 return <><PageHead title="Обслуживание сервиса"/><ReadError error={error} retry={refresh} state={readState}/><AdminTabs value={tab} items={tabs} label="Раздел обслуживания" onChange={value=>{const next=new URLSearchParams(params);next.set('tab',value);setParams(next)}}/><section key={tab} role="tabpanel" aria-label={tabs.find(([key])=>key===tab)![1]}>{tab==='backups'?<BackupOperations data={data} refresh={refresh}/>:tab==='cleanup'?<CleanupPanel/>:tab==='release'?<ReleasePanel data={data} refresh={refresh}/>:tab==='signals'?<SignalsPanel data={data} refresh={refresh}/>:tab==='content'?<ContentPanel/>:<ServiceReports/>}</section>{['backups','signals'].includes(tab)&&!!data.jobs.length&&<Panel title="Последние служебные запросы"><div className="admin-simple-list">{data.jobs.slice(0,8).map(job=><div key={job.id}><strong>{{USER_RECOVERY:'Направление восстановления',RESTORE_CHECK:'Пробное восстановление',DELIVERY_TEST:'Проверка доставки',BACKUP_CLEANUP:'Очистка старых копий',LEDGER_BACKUP:'Экспорт реестра удалений'}[job.kind as string]??'Служебная операция'}</strong><AdminBadge tone={job.status==='FAILED'?'amber':'gray'}>{serviceStates[job.status]??job.status}</AdminBadge><small>{date(job.created_at,true)}{job.error_code?' · '+job.error_code:''}</small></div>)}</div></Panel>}</>
}
