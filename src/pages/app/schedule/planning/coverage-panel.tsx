import { formatTime, zonedDateAndTime } from '../../../../app/schedule/date-utils.ts'
import { coverageLabel } from '../../../../app/schedule/planning/planning-presentation.ts'
import type { CoverageDay } from '../../../../app/schedule/planning/team-planning-types.ts'
import './team-planning.scss'
export function CoverageIndicator({day}:{day?:CoverageDay}) {
  if(!day||day.source==='unconfigured'&&!day.segments.some(s=>s.needed>0)||day.noDemand&&!day.shortageIntervals&&!day.surplusIntervals)return null
  const label=coverageLabel(day)
  const details=day.segments.filter(s=>s.needed>0).slice(0,3).map(s=>`${s.positionName}: ${s.assigned} из ${s.needed}`).join('; ')
  return <span className={`demand-dot ${day.shortageIntervals?'is-short':day.surplusIntervals?'is-extra':'is-covered'}`} title={`${label}${details?`. ${details}`:''}. Нажмите дату для подробностей.`} aria-label={label}/>
}
export default function CoveragePanel({day,timezone,loading,error}:{day?:CoverageDay;timezone:string;loading?:boolean;error?:string}) {
  const required=day?.segments.filter(s=>s.needed>0)??[],extra=day?.segments.filter(s=>s.needed===0&&s.assigned>0)??[]
  const positions=[...new Set(required.map(s=>s.positionId))]
  const range=(s:CoverageDay['segments'][number])=>`${formatTime(s.startAt,timezone)}–${formatTime(s.endAt,timezone)}${zonedDateAndTime(s.endAt,timezone).date!==day?.date?' следующего дня':''}`
  return <section className="coverage-panel" aria-label="Потребность выбранного дня"><header><strong>Сколько людей нужно</strong>{day&&<small>{day.source==='template'?'Повторяющийся шаблон':day.source==='exception'?'Потребность на эту дату':'На дату потребность не задана'}</small>}</header>
    {loading?<p className="planning-empty">Загружаем потребность…</p>:error?<p className="form-inline-error" role="alert">{error}</p>:!day?<p className="planning-empty">Нет данных.</p>:<>
      {day.source==='unconfigured'&&<p className="planning-footnote">Потребность на этот день не настроена.{required.length?' Ниже показано продолжение предыдущей ночи.':' Назначенные смены не считаются лишними.'}</p>}
      {day.noDemand&&!required.length&&<p className="planning-footnote">На этот день сотрудники по плану не требуются.</p>}
      {positions.map(positionId=><article className="coverage-position" key={positionId}><strong>{required.find(s=>s.positionId===positionId)?.positionName}</strong><div className="coverage-position__legend"><span>Время</span><span>На смене / нужно</span></div>{required.filter(s=>s.positionId===positionId).map((s,index)=><div className={`coverage-slot ${s.shortage?'is-short':s.surplus?'is-extra':'is-covered'}`} key={index}><span>{range(s)}</span><strong>{s.assigned} из {s.needed}</strong><small>{s.shortage?`Нужны ещё: ${s.shortage}`:s.surplus?`На ${s.surplus} больше, чем нужно`:'Хватает сотрудников'}</small></div>)}</article>)}
      {extra.length>0&&<details className="coverage-additional"><summary>Работа вне заданной потребности</summary><p>Эти часы не закрывают нехватку в другое время. Можно оставить их, если такая работа нужна.</p>{extra.map((s,index)=><div key={index}><strong>{s.positionName}</strong><span>{range(s)} · работают: {s.assigned}, требуется: 0</span></div>)}</details>}
    </>}
    <details className="coverage-explanation"><summary>Как считается</summary><p>Сравниваем должность и плановое время каждой смены с потребностью. Перерыв хранится только длительностью, поэтому из покрытия не вычитается.</p></details>
  </section>
}
