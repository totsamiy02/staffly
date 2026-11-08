import AdminPopover from './admin-popover.tsx'
import DatePicker from '../../component/ui/date-picker/date-picker.tsx'
import CopyReference from '../../component/ui/copy-reference.tsx'
import { AdminLink as Link } from './admin-link.tsx'
import AdminTable from './admin-table.tsx'
import Select from '../../component/ui/select/select.tsx'
import { useCallback,useEffect,type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAdminData } from './admin-data.tsx'
import { AdminBadge,Empty, Panel, date } from './admin-elements.tsx'
import { eventModules, outcomeLabels } from './event-labels.ts'
import { ReadError } from './admin-feedback.tsx'
import { useSearchDraft } from './use-search-draft.ts'
type Entry={id:string;userId:string|null;resourceId:string|null;action:string;label:string;module:string;actor:string;source:string;outcome:string;createdAt:string}
type Result={items:Entry[];total:number;page:number;pageSize:number}
export default function EventFeed({organizationId,userId}:{organizationId?:string;userId?:string}){
 const [params,setParams]=useSearchParams(),[search,setSearch,applied]=useSearchDraft(params.get('eventSearch')??'','eventSearch')
 const query=new URLSearchParams();if(organizationId)query.set('organizationId',organizationId);if(userId)query.set('userId',userId)
 for(const [url,key] of [['eventSearch','search'],['eventOutcome','outcome'],['eventModule','module'],['eventPage','page'],['eventFrom','from'],['eventTo','to']]){const value=params.get(url);if(value)query.set(key,value)}
 const {data,error,refresh,readState}=useAdminData<Result>('/monitoring/events?'+query)
 const patch=useCallback((key:string,value:string,replace?:boolean)=>{if(key==='eventSearch')applied(value);const next=new URLSearchParams(params);if(value)next.set(key,value);else next.delete(key);if(key!=='eventPage')next.delete('eventPage');setParams(next,{replace:replace??(key!=='eventSearch'&&key!=='eventPage')})},[params,applied,setParams])
 useEffect(()=>{if(search.trim()===(params.get('eventSearch')??''))return;const timer=setTimeout(()=>patch('eventSearch',search.trim(),true),350);return()=>clearTimeout(timer)},[search,params,patch])
 const submit=(event:FormEvent)=>{event.preventDefault();patch('eventSearch',search.trim())}
 return <Panel title="Журнал событий" subtitle="Хранение — 180 дней">
  <form className="admin-toolbar" onSubmit={submit}><label className="admin-search"><span className="admin-sr-only">Поиск событий</span><input type="search" maxLength={120} placeholder="Действие, имя, ID записи или пользователя" value={search} onChange={event=>setSearch(event.target.value)}/></label><button className="admin-btn">Найти события</button></form>
  <div className="admin-event-filters"><label>Раздел<Select aria-label="Раздел" value={params.get('eventModule')??'all'} onChange={event=>patch('eventModule',event.target.value)}><option value="all">Все разделы</option>{Object.entries(eventModules).map(([key,label])=><option key={key} value={key}>{label}</option>)}</Select></label><label>Результат<Select aria-label="Результат" value={params.get('eventOutcome')??'all'} onChange={event=>patch('eventOutcome',event.target.value)}><option value="all">Все результаты</option>{Object.entries(outcomeLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</Select></label><label><span>С даты</span><DatePicker aria-label="С даты" value={params.get('eventFrom')??''} onChange={event=>patch('eventFrom',event.target.value)}/></label><label><span>По дату</span><DatePicker aria-label="По дату" value={params.get('eventTo')??''} onChange={event=>patch('eventTo',event.target.value)}/></label></div>
  {['eventSearch','eventModule','eventOutcome','eventFrom','eventTo'].some(key=>params.has(key)&&params.get(key)!=='all')&&<div className="admin-active-filters" aria-label="Активные фильтры событий">{[['eventSearch','Поиск'],['eventModule','Раздел'],['eventOutcome','Результат'],['eventFrom','С даты'],['eventTo','По дату']].filter(([key])=>params.has(key)&&params.get(key)!=='all').map(([key,title])=><button type="button" key={key} onClick={()=>{if(key==='eventSearch')setSearch('');patch(key,'')}}>{title}: {key==='eventModule'?eventModules[params.get(key)!]:key==='eventOutcome'?outcomeLabels[params.get(key)!]:params.get(key)} ×</button>)}<button type="button" className="admin-text-button" onClick={()=>{const next=new URLSearchParams(params);for(const key of ['eventSearch','eventModule','eventOutcome','eventFrom','eventTo','eventPage'])next.delete(key);setSearch('');applied('');setParams(next)}}>Сбросить всё</button></div>}

  <ReadError error={error} retry={refresh} state={readState}/>
  {!data?<p role="status">Загружаем журнал…</p>:<><AdminTable primary={[1,3,0]} title={1} actions={[4]}><table><thead><tr><th>Время МСК</th><th>Действие</th><th>Источник / пользователь</th><th>Результат</th><th>Идентификаторы</th></tr></thead><tbody>{data.items.map(event=><tr key={event.id}><td>{date(event.createdAt,true)}</td><td><strong>{event.label}</strong><small style={{display:'block'}}>{eventModules[event.module]??'Безопасность'}</small></td><td>{event.userId?<Link to={'/admin/users/'+event.userId}>{event.actor}</Link>:<span title="Изменение зафиксировано триггером. Точный исполнитель не передан в БД.">{event.actor}</span>}</td><td><AdminBadge tone={event.outcome==='SUCCEEDED'?'green':'amber'}>{outcomeLabels[event.outcome]}</AdminBadge></td><td><AdminPopover label="Детали"><div className="admin-event-identifiers"><CopyReference value={event.id} label="ID события"/>{event.resourceId&&<><CopyReference value={event.resourceId} label="ID записи"/></>}{event.userId&&<><CopyReference value={event.userId} label="ID пользователя"/></>}</div></AdminPopover></td></tr>)}</tbody></table>{!data.items.length&&<Empty>По этим условиям событий не найдено. Измените поиск или период.</Empty>}</AdminTable><div className="admin-pagination"><span>Найдено: {data.total}</span><div><button className="admin-btn" disabled={data.page<=1} onClick={()=>patch('eventPage',String(data.page-1))}>Назад</button><span>{data.page} / {Math.max(1,Math.ceil(data.total/20))}</span><button className="admin-btn" disabled={data.page*20>=data.total} onClick={()=>patch('eventPage',String(data.page+1))}>Далее</button></div></div></>}

 </Panel>
}
