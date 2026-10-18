import AsyncPanel from '../../../component/ui/async-panel.tsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { canAccess } from '../../../app/access/catalog.ts'
import { useDemand, useTeamSettings } from '../../../app/schedule/team-planning.ts'
import { useSchedulePlanning } from '../../../app/schedule/planning.ts'
import { displayDate, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { buildDemandCycle, demandOnDate, monthDates, weekDates } from '../../../app/schedule/planning-presentation.ts'
import { invalidateOrganizationWork } from '../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import type { DemandData, DemandInterval } from '../../../app/schedule/team-planning-types.ts'
import { TimeInput } from '../../../component/ui/date-picker/date-picker.tsx'
import Select from '../../../component/ui/select/select.tsx'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import PlanningMonthCalendar from './planning-month-calendar.tsx'
import ScheduleSectionHeader from './schedule-section-header.tsx'
import AnimatedOverlay from './animated-overlay.tsx'
import DocumentDialog from '../documents/document-dialog.tsx'
import './team-planning.scss'
const weekdays=['Пн','Вт','Ср','Чт','Пт','Сб','Вс']
type Plan = DemandInterval[] | null
export default function DemandPage({organization}:{organization:OrganizationSummary}) {
  const settings=useTeamSettings(organization.id),allowed=canAccess(organization,'coverage.view'),query=useDemand(organization.id,allowed)
  return <section className="team-planning demand-page"><ScheduleSectionHeader organization={organization} title="Потребность в сотрудниках" description={`Количество сотрудников по должностям и времени · ${organization.location?.name}`}/>
    <AsyncPanel pending={allowed && (query.isLoading || settings.isLoading)} minHeight={400}>{!allowed?<p className="planning-empty">Нет доступа к потребности.</p>:query.isLoading||settings.isLoading?<p className="planning-empty">Загружаем потребность…</p>:query.isError||settings.isError?<p className="form-inline-error" role="alert">Не удалось загрузить потребность. <button onClick={()=>{void query.refetch();void settings.refetch()}}>Повторить</button></p>:!settings.data?.coverageEnabled?<div className="planning-card"><p>Потребность выключена для этой точки.</p>{canAccess(organization,'schedule.settings')&&<Link className="app-secondary" to={`/app/organizations/${organization.id}/settings?section=schedule&location=${organization.locationId}`}>Включить в настройках</Link>}</div>:<DemandEditor key={organization.locationId} organization={organization} data={query.data!}/>}</AsyncPanel>
  </section>
}
function DemandEditor({organization,data}:{organization:OrganizationSummary;data:DemandData}) {
  const {apiRequest}=useAuth(),client=useQueryClient(),toast=useToast(),planning=useSchedulePlanning(organization.id)
  const today=zonedDateAndTime(new Date().toISOString(),organization.timezone).date
  const [month,setMonth]=useState(today.slice(0,7)),[dates,setDates]=useState<string[]>([today]),[focus,setFocus]=useState(today)
  const [edits,setEdits]=useState<Record<string,Plan>>({}),[cycle,setCycle]=useState<string[]|null>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[review,setReview]=useState<'save'|'reset'|'stop'|null>(null)
  const [history,setHistory]=useState(false),[versionId,setVersionId]=useState('')
  const manage=canAccess(organization,'coverage.manage'),positions=planning.data?.positions.filter(p=>p.isActive)??[]
  const readPlan=(date:string):Plan=>Object.hasOwn(edits,date)?edits[date]:demandOnDate(data,date).intervals
  const plan=readPlan(focus),intervals=plan??[],source=demandOnDate(data,focus)
  const currentVersion=[...data.versions].reverse().find(version=>version.effectiveFrom<=focus)
  const repeating=!!currentVersion?.days.some(day=>day!==null)
  const effective=cycle?buildDemandCycle(data,cycle[0],today,edits).effectiveFrom:focus<today?today:focus
  const nextVersion=data.versions.find(version=>version.effectiveFrom>effective)
  const historical=data.versions.find(version=>version.id===versionId)??data.versions.at(-1)
  const mixed=dates.some(date=>JSON.stringify(readPlan(date))!==JSON.stringify(plan))
  const changed=Object.keys(edits).filter(date=>dates.includes(date)).length
  const invalid=dates.some(date=>readPlan(date)?.some(row=>!row.positionId||row.needed<1||row.needed>500))
  function editRows(next:Plan) {
    setReview(null);setError('')
    const targets=[focus]
    setEdits(current=>({...current,...Object.fromEntries(targets.map(date=>[date,structuredClone(next)]))}))
  }
  function update(index:number,patch:Partial<DemandInterval>) {editRows(intervals.map((row,i)=>i===index?{...row,...patch}:row))}
  function selectDate(date:string) {
    setReview(null);setError('')
    if(cycle){setFocus(date);if(!cycle.includes(date)){const week=weekDates(date);setCycle(week);setDates(week)}return}
    if(!dates.includes(date)&&dates.length>=62){setError('Можно выбрать до 62 дат за один раз.');return}
    const next=dates.includes(date)?dates.filter(day=>day!==date):[...dates,date].sort()
    setDates(next);setFocus(next.includes(date)?date:next[0]??date)
  }
  function selectDates(next:string[]) {setCycle(null);setDates(next);setFocus(next.includes(focus)?focus:next[0]??focus);setReview(null);setError('')}
  function enableCycle(enabled:boolean) {
    setReview(null)
    if(!enabled){setCycle(null);return}
    const week=buildDemandCycle(data,focus,today,edits).dates;setCycle(week);setDates(week);setMonth(focus.slice(0,7));setError('')
  }
  async function save() {
    setBusy(true);setError('')
    try {
      const repeat=review==='stop'?{effectiveFrom:effective,days:Array(7).fill(null)}:cycle&&review==='save'?{effectiveFrom:effective,days:buildDemandCycle(data,cycle[0],today,edits).days}:undefined
      const savedDates=review==='stop'?[]:dates.filter(date=>date>=today).map(date=>({date,intervals:review==='reset'||repeat?null:readPlan(date)}))
      await apiRequest(`/organizations/${organization.id}/schedule/demand/dates`,{method:'PUT',body:{dates:savedDates,...repeat?{repeat}:{}}})
      await invalidateOrganizationWork(client,organization.id)
      toast(review==='stop'?'Повторение остановлено':repeat?'Неделя сохранена и будет повторяться':review==='reset'?'Отдельные планы дат убраны':'Потребность выбранных дат сохранена','success')
      setEdits({});setReview(null);if(review==='stop')setCycle(null)
    }catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить потребность.')}
    finally{setBusy(false)}
  }
  return <>
    <div className="demand-workspace demand-workspace--unified">
      <div className="planning-card demand-calendar-card">
        <div className="demand-calendar-intro"><strong>{cycle?'Неделя для повторения':'Выберите нужные даты'}</strong><span>{cycle?'Нажмите день недели, чтобы изменить его план.':'Нажимайте дни для выбора. Повторное нажатие снимает выделение.'}</span></div>
        <PlanningMonthCalendar month={month} onMonth={setMonth} selected={dates} onDay={selectDate} label="Даты потребности" content={date=>{
          const value=readPlan(date)
          return <span className={`demand-day-plan${(value===null?' is-unset':value.length?' is-planned':' is-off')+(date===focus?' is-focused':'')}`}><span className="demand-day-plan__full">{value===null?'—':value.length?`${value.length} ${value.length===1?'интервал':'инт.'}`:'Выходной'}</span><span className="demand-day-plan__compact">{value===null?'—':value.length?`${value.length} инт.`:'Вых.'}</span>{value!==null&&demandOnDate(data,date).source==='template'&&<span aria-label="Повторяется каждую неделю"> ↻</span>}</span>
        }}/>
        <div className="demand-date-shortcuts"><button className="app-secondary" disabled={busy} onClick={()=>selectDates(weekDates(focus))}>Неделя</button><button className="app-secondary" disabled={busy} onClick={()=>selectDates(monthDates(month))}>Весь месяц</button><button className="app-secondary" disabled={busy||!dates.length} onClick={()=>selectDates([])}>Сбросить выбор</button></div>
        <div className="demand-selection-info"><span>Выбрано дат: <strong>{dates.length}</strong></span>{changed>0&&<small>С несохранёнными правками: {changed}</small>}</div>
        {manage&&<div className="demand-repeat-control"><label className="planning-checkbox"><input type="checkbox" checked={!!cycle} disabled={busy} onChange={e=>enableCycle(e.target.checked)}/><span>Повторять эту неделю</span></label><p>{cycle?`План ${displayDate(cycle[0])} — ${displayDate(cycle[6])} будет повторяться по дням недели с ${displayDate(effective)}. Каждый день редактируется отдельно.`:'Сохраните одну неделю и используйте её план в следующих неделях. Выходные тоже повторяются.'}</p></div>}
        {repeating&&!cycle&&<div className="demand-active-cycle"><strong>↻ Действует повторение недели</strong><p>С {displayDate(currentVersion!.effectiveFrom)}. Отдельные планы дат имеют приоритет.</p>{manage&&<div><button className="planning-text-button" onClick={()=>enableCycle(true)}>Изменить эту неделю и повторение</button><button className="planning-text-button" onClick={()=>{setCycle(null);setReview('stop')}}>Остановить с {displayDate(effective)}</button></div>}</div>}
        {!!data.versions.length&&<button className="app-secondary demand-history-button" onClick={()=>setHistory(true)}>История повторений · {data.versions.length}</button>}
      </div>
      <div className="planning-card demand-editor-card">
        <header><div><span className="demand-editor-eyebrow">{cycle?'План дня в повторяющейся неделе':dates.length>1?'План выбранного дня':'План выбранной даты'}</span><h3>{displayDate(focus)}</h3></div><p>{!dates.length?'Выберите даты в календаре.':cycle?'Меняйте этот день; затем нажмите другой день в календаре.':dates.length>1?'Нажимайте даты ниже и задавайте план каждого дня отдельно. Для одинаковых дней есть явное копирование.':source.source==='exception'?'На эту дату сохранён отдельный план.':source.source==='template'?'План повторяется каждую неделю. Здесь можно изменить только эту дату или включить редактирование повторения.':'Потребность на дату пока не задана.'}</p></header>
        {dates.length>1&&!cycle&&<div className="demand-selected-dates" aria-label="Выбранные даты">{dates.map(date=><button key={date} aria-pressed={focus===date} onClick={()=>{setFocus(date);setReview(null)}}>{Number(date.slice(-2))} {new Intl.DateTimeFormat('ru-RU',{month:'short',timeZone:'UTC'}).format(new Date(date+'T12:00Z'))}<small>{readPlan(date)===null?'Не задано':readPlan(date)!.length?`${readPlan(date)!.length} инт.`:'Выходной'}</small></button>)}</div>}
        {mixed&&!cycle&&<p className="demand-editor-note">На выбранных датах разные планы. Меняется только {displayDate(focus)}. Остальные дни сохранят свой план, включая выходные.</p>}
        {!cycle&&dates.some(date=>date<today)&&<p className="demand-editor-note">Прошедшие даты доступны для просмотра. Чтобы повторять полную неделю с её прежними планами, включите «Повторять эту неделю». Рабочая история останется без изменений.</p>}
        <fieldset className="demand-editor-fields" disabled={!manage||busy||!dates.length||focus<today&&!cycle}>
          <div className="demand-day-kind" aria-label="План выбранного дня"><button type="button" aria-pressed={!!intervals.length} onClick={()=>{if(!intervals.length)editRows([{positionId:'',startTime:'09:00',endTime:'18:00',endDayOffset:0,needed:1}])}}>Рабочий день</button><button type="button" aria-pressed={plan!==null&&!intervals.length} onClick={()=>editRows([])}>Выходной · сотрудники не нужны</button></div>
          <div className="demand-intervals">{intervals.map((row,index)=><article className="demand-interval" key={index}>
            <header><strong>Должность и время · {index+1}</strong>{manage&&<button type="button" className="demand-remove" aria-label={`Удалить интервал ${index+1}`} onClick={()=>editRows(intervals.filter((_,i)=>i!==index))}>×</button>}</header>
            <label><span>Должность</span><Select value={row.positionId} required disabled={!manage||busy||!dates.length||focus<today&&!cycle} onChange={e=>update(index,{positionId:e.target.value})}><option value="">Выберите должность</option>{!positions.some(p=>p.id===row.positionId)&&row.positionId&&<option value={row.positionId}>Неактивная должность</option>}{positions.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
            <div className="planning-fields"><label><span>Начало</span><TimeInput value={row.startTime} required onChange={e=>update(index,{startTime:e.target.value})}/></label><label><span>Окончание</span><TimeInput value={row.endTime} required onChange={e=>update(index,{endTime:e.target.value})}/></label></div>
            <label className="planning-checkbox"><input type="checkbox" checked={!!row.endDayOffset} onChange={e=>update(index,{endDayOffset:e.target.checked?1:0})}/><span>Окончание на следующий день</span></label>
            <label><span>Сотрудников одновременно</span><div className="demand-stepper"><button type="button" aria-label="Уменьшить количество" disabled={row.needed<=1} onClick={()=>update(index,{needed:row.needed-1})}>−</button><input aria-label="Количество сотрудников" type="number" min={1} max={500} value={row.needed} onChange={e=>update(index,{needed:Number(e.target.value)})}/><button type="button" aria-label="Увеличить количество" disabled={row.needed>=500} onClick={()=>update(index,{needed:row.needed+1})}>+</button></div></label>
          </article>)}</div>
          {!intervals.length&&<div className={`demand-empty-plan${plan!==null?' is-off':''}`}><strong>{plan===null?'Потребность не задана':'Сотрудники не нужны'}</strong><p>{plan===null?'Добавьте должность и время или отметьте день выходным.':'На этот день сотрудники по плану не требуются. Добавьте интервал, если планы изменились.'}</p></div>}
          {manage&&<div className="demand-date-shortcuts"><button className="app-secondary" disabled={!positions.length||intervals.length>=100} onClick={()=>editRows([...intervals,{positionId:'',startTime:'09:00',endTime:'18:00',endDayOffset:0,needed:1}])}>＋ Добавить должность и время</button></div>}
        </fieldset>
        {manage&&dates.length>1&&!cycle&&<button className="app-secondary demand-copy-plan" disabled={busy||dates.some(date=>date<today)||intervals.some(row=>!row.positionId)} onClick={()=>{setEdits(current=>({...current,...Object.fromEntries(dates.map(date=>[date,structuredClone(plan)]))}));setReview(null)}}>Применить план этого дня ко всем выбранным датам</button>}
        {planning.isError&&<p className="form-inline-error">Не удалось загрузить должности. <button onClick={()=>void planning.refetch()}>Повторить</button></p>}
        {error&&<p className="form-inline-error" role="alert">{error}</p>}
        {review?<div className="demand-save-review" role="status"><strong>{review==='stop'?'Остановить повторение':review==='reset'?'Убрать отдельные планы дат':cycle?'Сохранить и повторять неделю':`Сохранить ${dates.length} дат`}</strong><p>{review==='stop'?`С ${displayDate(effective)} недельный план будет не задан. Отдельные планы дат сохранятся.`:review==='reset'?'На выбранных датах снова будет действовать повторение. Если его нет, потребность будет не задана.':cycle?`План каждого дня недели будет повторяться с ${displayDate(effective)}. Отдельные планы выбранной недели станут частью повторения. Другие отдельные даты сохранятся.`:`${dates.map(displayDate).join('; ')}. Остальные даты не изменятся.`}</p>{(cycle||review==='stop')&&nextVersion&&<p>С {displayDate(nextVersion.effectiveFrom)} уже запланирована следующая редакция. Она сохранится.</p>}<footer><button className="app-secondary" disabled={busy} onClick={()=>setReview(null)}>Назад</button><button className="app-primary" disabled={busy} onClick={()=>void save()}>{busy?'Сохраняем…':'Подтвердить'}</button></footer></div>:manage&&<footer>{!cycle&&dates.some(date=>data.exceptions.some(value=>value.date===date))&&<button className="app-secondary" disabled={busy||dates.some(date=>date<today)} onClick={()=>setReview('reset')}>Убрать отдельный план дат</button>}<button className="app-primary" disabled={busy||!dates.length||invalid||!cycle&&dates.some(date=>date<today)} onClick={()=>setReview('save')}>{cycle?'Сохранить и повторять неделю':'Сохранить выбранные даты'}</button></footer>}
      </div>
    </div>
    {history&&<AnimatedOverlay variant="modal" onClose={()=>setHistory(false)}>{close=><DocumentDialog className="planning-dialog demand-history-dialog" eyebrow="Потребность" title="История повторений" onClose={close}><div className="team-planning planning-dialog-form"><p>Просмотр сохранённых редакций. Текущий план и несохранённые правки не меняются.</p><label><span>Редакция</span><Select value={historical?.id??''} onChange={e=>setVersionId(e.target.value)}>{[...data.versions].reverse().map((v,index)=><option key={v.id} value={v.id}>Редакция {data.versions.length-index} · с {displayDate(v.effectiveFrom)}</option>)}</Select></label><div className="demand-history-days">{historical?.days.map((day,index)=><section key={index}><strong>{weekdays[index]}</strong>{day===null?<span>Не задано</span>:!day.length?<span>Сотрудники не нужны</span>:day.map((row,i)=><p key={i}>{positions.find(p=>p.id===row.positionId)?.name??'Неактивная должность'} · {row.startTime}–{row.endTime}{row.endDayOffset?' (+1 день)':''} · нужно {row.needed}</p>)}</section>)}</div><footer><button className="app-primary" onClick={close}>Вернуться к текущему плану</button></footer></div></DocumentDialog>}</AnimatedOverlay>}
  </>
}
