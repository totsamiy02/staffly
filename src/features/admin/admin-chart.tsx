import { useEffect, useId, useRef, useState } from 'react'
import HelpTip from '../../component/ui/help-tip/help-tip.tsx'
import { chartKnown as known,chartSeries,chartGaps } from './admin-chart-model.ts'
import { historyPosition, historyTime, type HistoryPoint, type HistoryRange } from '../../shared/monitoring-history.ts'

type Series = { key: string; label: string }
const colors = ['var(--admin-chart-purple)', 'var(--admin-chart-teal)', 'var(--theme-rose,#bd8caa)']
const format = (n: number) => new Intl.NumberFormat('ru-RU').format(n)
const label = (time: number, full = false) => new Date(time).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', ...(full ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit',
})
export default function AdminChart({ data, series = [{ key: 'users', label: 'Пользователи' }, { key: 'organizations', label: 'Организации' }], range,observedSince,historyStartedAt }: {
  data: HistoryPoint[]; series?: Series[]; range?: HistoryRange;observedSince?:string;historyStartedAt?:string
}) {
  const ref = useRef<HTMLDivElement>(null), id = useId().replace(/:/g, '')
  const [entered, setEntered] = useState(false), [width, setWidth] = useState(760), [selected, setSelected] = useState<number | null>(null), [hidden, setHidden] = useState<string[]>([])
  useEffect(() => { const observer = new ResizeObserver(items => { if (items[0]) setWidth(Math.max(220, Math.round(items[0].contentRect.width))) }); if (ref.current) observer.observe(ref.current); return () => observer.disconnect() }, [])
  useEffect(() => { const observer = new IntersectionObserver(items => { if (items.some(item => item.isIntersecting)) { setEntered(true); observer.disconnect() } }, { threshold: .18 }); if (ref.current) observer.observe(ref.current); return () => observer.disconnect() }, [])
  const visible = series.filter(s => !hidden.includes(s.key)), last = data.length - 1
  const times = data.map(historyTime), firstTime = times[0] ?? Date.now(), lastTime = times[last] ?? firstTime
  const requested = range ?? { from: new Date(firstTime === lastTime ? firstTime - 150000 : firstTime).toISOString(), to: new Date(firstTime === lastTime ? lastTime + 150000 : lastTime).toISOString(), stepMs: Infinity }
  const since=observedSince?Date.parse(observedSince):NaN,firstKnown=times.find((_,i)=>visible.some(series=>known(data[i],series.key))),available=Number.isFinite(since)?Math.min(since,firstKnown??since):Date.parse(requested.from)
  const domain={...requested,from:new Date(Math.max(Date.parse(requested.from),available)).toISOString()}
  const bands=chartGaps(data,visible.map(series=>series.key),domain),models=new Map(series.map(series=>[series.key,chartSeries(data,series.key,domain.stepMs)]))
  const max = Math.max(3, Math.ceil(Math.max(0, ...data.flatMap(row => visible.map(s => known(row, s.key) ? Number(row[s.key]) : 0))) / 3) * 3)
  const x = (i: number) => 44 + historyPosition(times[i], domain) * (width - 72), y = (n: number) => 190 - n / max * 158
  const index = selected === null || last < 0 ? null : Math.min(last, selected), row = index === null ? null : data[index]
  const curve = (s: Series, indices: number[]) => {
    const points = indices.map(i => [x(i), y(Number(data[i][s.key]))])
    return points.map((p, i) => i === 0 ? `M${p[0]},${p[1]}` : `C${(points[i - 1][0] + p[0]) / 2},${points[i - 1][1]} ${(points[i - 1][0] + p[0]) / 2},${p[1]} ${p[0]},${p[1]}`).join(' ')
  }
  const hasData = data.some(item => visible.some(s => known(item, s.key)))
  const needsExplanation = Boolean(historyStartedAt)||bands.length>0||[...models.values()].some(model=>model.parts.some(part=>part.partial))
  return <div ref={ref} className={`admin-chart ${entered ? 'is-entered' : ''}`}>
    {!hasData ? <div className="admin-chart-empty"><strong>За этот период наблюдений пока нет</strong></div> : <div className="admin-chart-frame" tabIndex={0} role="slider" aria-label="Значения графика по датам" aria-valuemin={0} aria-valuemax={last} aria-valuenow={index ?? last}
      aria-valuetext={row ? `${label(historyTime(row), true)}: ${visible.map(s => `${s.label} ${known(row, s.key) ? row[s.key] : 'нет данных'}`).join(', ')}${row.incomplete ? ', неполные наблюдения' : ''}` : undefined}
      onFocus={() => setSelected(last)} onBlur={() => setSelected(null)}
      onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(), position = ((event.clientX - rect.left) / rect.width * width - 44) / (width - 72); const time = Date.parse(domain.from) + position * (Date.parse(domain.to) - Date.parse(domain.from)); let closest = 0; times.forEach((t, i) => { if (Math.abs(t - time) < Math.abs(times[closest] - time)) closest = i }); setSelected(closest) }}
      onPointerLeave={() => { if (document.activeElement !== ref.current?.querySelector('.admin-chart-frame')) setSelected(null) }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, (index ?? last) + (event.key === 'ArrowLeft' ? -1 : 1)))) } }}>
      <svg viewBox={`0 0 ${width} 240`} role="img" aria-label={`График: ${visible.map(s => s.label).join(', ')}`} preserveAspectRatio="none">
        <defs><clipPath id={`${id}-clip`}><rect x="40" y="24" width={width - 64} height="174" /></clipPath>{series.map((s, i) => <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colors[i % 3]} stopOpacity=".19" /><stop offset="100%" stopColor={colors[i % 3]} stopOpacity="0" /></linearGradient>)}</defs>
        {[0, 1, 2, 3].map(i => <g key={i}><line x1="44" x2={width - 28} y1={32 + i * 158 / 3} y2={32 + i * 158 / 3} stroke="var(--admin-line)" strokeDasharray="2 6" /><text x="2" y={36 + i * 158 / 3}>{new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.round(max * (1 - i / 3)))}</text></g>)}
        <g clipPath={`url(#${id}-clip)`}>{bands.map((band,i)=>{const left=44+historyPosition(band.from,domain)*(width-72),right=44+historyPosition(band.to,domain)*(width-72);return <g key={i} className="admin-chart-gap-band"><rect x={left} y="24" width={right-left} height="174" fill="var(--admin-line)" fillOpacity=".35"/>{right-left>62&&<text x={(left+right)/2} y="110" textAnchor="middle">{right-left>105?'Нет наблюдений':'Нет данных'}</text>}</g>})}
        {series.map((s,i)=>!hidden.includes(s.key)&&<g key={s.key} className="admin-chart-series">{models.get(s.key)!.bridges.map((indices,part)=><path key={'gap'+part} className="admin-chart-bridge" d={curve(s,indices)} fill="none" stroke={colors[i%3]} strokeWidth="1.5" strokeDasharray="4 5" strokeOpacity=".65"/>)}{models.get(s.key)!.parts.map(({indices,partial},part)=><g key={part}>
          {indices.length>1?<><path className="admin-chart-area" d={`${curve(s,indices)} L${x(indices.at(-1)!)},190 L${x(indices[0])},190Z`} fill={`url(#${id}-${s.key})`}/><path className={`admin-chart-line ${partial?'is-provisional':''}`} pathLength={partial?undefined:1} d={curve(s,indices)} fill="none" stroke={colors[i%3]} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/></>:<circle cx={x(indices[0])} cy={y(Number(data[indices[0]][s.key]))} r="4" fill={colors[i%3]}/>}
        </g>)}</g>)}
          {index !== null && <g className="admin-chart-cursor"><line x1={x(index)} x2={x(index)} y1="24" y2="190" stroke="var(--admin-muted)" strokeDasharray="3 4" />{series.map((s, i) => !hidden.includes(s.key) && known(data[index], s.key) && <circle key={s.key} cx={x(index)} cy={y(Number(data[index][s.key]))} r="4.5" fill={colors[i % 3]} stroke="var(--admin-surface)" strokeWidth="2" />)}</g>}</g>
        {(width < 420 ? [0, 1] : [0, .5, 1]).map(position => <text key={position} x={44 + position * (width - 72)} y="222" textAnchor={position === 1 ? 'end' : position === 0 ? 'start' : 'middle'}>{label(Date.parse(domain.from) + position * (Date.parse(domain.to) - Date.parse(domain.from)))}</text>)}
      </svg>
      {row && index !== null && <div className="admin-chart-tooltip" style={{ left: `${Math.max(width < 420 ? 34 : 22, Math.min(width < 420 ? 66 : 78, x(index) / width * 100))}%` }}><strong>{label(historyTime(row), true)}</strong>{series.map((s, i) => !hidden.includes(s.key) && <span key={s.key}><i style={{ background: colors[i % 3] }} />{s.label}<b>{known(row, s.key) ? format(Number(row[s.key])) : 'Нет данных'}</b></span>)}{row.incomplete && <small>Неполные наблюдения за интервал</small>}</div>}
    </div>}
    <div className="admin-legend">{series.map((s, i) => <button type="button" key={s.key} aria-pressed={!hidden.includes(s.key)} onClick={() => setHidden(current => current.includes(s.key) ? current.filter(key => key !== s.key) : visible.length > 1 ? [...current, s.key] : current)}><i style={{ background: colors[i % 3] }} />{s.label}</button>)}{needsExplanation&&<HelpTip label="Как читать график">Сплошная линия показывает замеры, пунктир — неполный интервал или связь между раздельными замерами. Область «Нет наблюдений» не считается нулём.{historyStartedAt&&<> История собирается с {label(Date.parse(historyStartedAt),true)} · МСК; хранение — 180 дней. До начала сбора данных нет.</>}</HelpTip>}</div>

    {bands.length>0&&<div className="admin-chart-coverage"><i aria-hidden="true"/>Есть периоды без замеров</div>}
  </div>
}
