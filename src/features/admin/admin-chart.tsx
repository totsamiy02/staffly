import { useEffect, useId, useRef, useState } from 'react'
import HelpTip from '../../component/ui/help-tip/help-tip.tsx'
import { chartKnown as known, chartSeries, chartScale } from './admin-chart-model.ts'
import { historyPosition, historyTime, type HistoryPoint, type HistoryRange } from '../../shared/monitoring-history.ts'

type Series = { key: string; label: string }
const colors = ['var(--admin-chart-purple)', 'var(--admin-chart-teal)', 'var(--theme-rose,#bd8caa)']
const format = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)
const label = (time: number) => new Date(time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function AdminChart({ data, series = [{ key: 'users', label: 'Пользователи' }, { key: 'organizations', label: 'Организации' }], range, observedSince, historyStartedAt, variant = 'line' }: {
  data: HistoryPoint[]; series?: Series[]; range?: HistoryRange; observedSince?: string; historyStartedAt?: string; variant?: 'line' | 'bar'
}) {
  const ref = useRef<HTMLDivElement>(null), id = useId().replace(/:/g, '')
  const [width, setWidth] = useState(760), [selected, setSelected] = useState<number | null>(null), [hidden, setHidden] = useState<string[]>([])
  useEffect(() => {
    const observer = new ResizeObserver(items => { if (items[0]) setWidth(Math.max(180, Math.round(items[0].contentRect.width))) })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const visible = series.filter(s => !hidden.includes(s.key)), last = data.length - 1
  const times = data.map(historyTime), firstTime = times[0] ?? Date.now(), lastTime = times[last] ?? firstTime
  const requested = range ?? { from: new Date(firstTime === lastTime ? firstTime - 150000 : firstTime).toISOString(), to: new Date(firstTime === lastTime ? lastTime + 150000 : lastTime).toISOString(), stepMs: Infinity }
  const since = observedSince || historyStartedAt ? Date.parse((observedSince || historyStartedAt)!) : NaN
  const firstKnown = times.find((_, i) => visible.some(s => known(data[i], s.key)))
  const available = Number.isFinite(since) ? Math.min(since, firstKnown ?? since) : Date.parse(requested.from)
  const domain = { ...requested, from: new Date(Math.max(Date.parse(requested.from), Math.min(available, Date.parse(requested.to)))).toISOString() }
  const models = new Map(series.map(s => [s.key, chartSeries(data, s.key, domain.stepMs)]))
  const values = data.flatMap(row => visible.filter(s => known(row, s.key)).map(s => Number(row[s.key])))
  const scale = chartScale(values, width < 420 ? 3 : 4)
  const tickFormat = (n: number) => new Intl.NumberFormat('ru-RU', { ...(scale.max >= 10000 ? { notation: 'compact' as const } : {}), maximumFractionDigits: 2 }).format(n)
  const left = Math.max(30, Math.min(68, Math.max(...scale.ticks.map(n => tickFormat(n).length)) * 7 + 12)), right = width - 12
  const top = 18, bottom = 198, x = (i: number) => left + historyPosition(times[i], domain) * (right - left), y = (n: number) => bottom - n / scale.max * (bottom - top)
  const index = selected === null || last < 0 ? null : Math.min(last, selected), row = index === null ? null : data[index]
  const duration = Date.parse(domain.to) - Date.parse(domain.from)
  const axisLabel = (time: number) => new Date(time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...(duration <= 2 * 86400000 ? { ...(duration >= 20 * 3600000 ? { day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit' } : duration > 365 * 86400000 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' }) })
  const curve = (s: Series, indices: number[]) => indices.map((i, n) => {
    if (!n) return `M${x(i)},${y(Number(data[i][s.key]))}`
    const previous = indices[n - 1], middle = (x(previous) + x(i)) / 2
    return `C${middle},${y(Number(data[previous][s.key]))} ${middle},${y(Number(data[i][s.key]))} ${x(i)},${y(Number(data[i][s.key]))}`
  }).join(' ')
  const missing = variant === 'line' && (data.some(item => visible.some(s => !known(item, s.key))) || [...models.values()].some(model => model.bridges.length || model.parts.some(part => part.partial)))
  const hasData = values.length > 0
  return <div ref={ref} className="admin-chart is-entered" data-scale-max={scale.max} data-chart-kind={variant}>
    {!hasData ? <div className="admin-chart-empty"><span className="admin-chart-empty-symbol" aria-hidden="true">—</span><strong>Пока нет наблюдений</strong><span>Выберите другой период или дождитесь первого замера.</span></div> : <div className="admin-chart-frame" tabIndex={0} role="slider" aria-label="Значения графика по датам" aria-valuemin={0} aria-valuemax={last} aria-valuenow={index ?? last}
      aria-valuetext={row ? `${label(historyTime(row))}: ${visible.map(s => `${s.label} ${known(row, s.key) ? format(Number(row[s.key])) : 'нет замера'}`).join(', ')}${row.incomplete ? ', неполный интервал' : ''}` : undefined}
      onFocus={() => setSelected(last)} onBlur={() => setSelected(null)}
      onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect(), position = (event.clientX - rect.left) / rect.width * width
        const time = Date.parse(domain.from) + (position - left) / (right - left) * duration
        let closest = 0
        times.forEach((t, i) => { if (Math.abs(t - time) < Math.abs(times[closest] - time)) closest = i })
        setSelected(closest)
      }}
      onPointerLeave={() => { if (document.activeElement !== ref.current?.querySelector('.admin-chart-frame')) setSelected(null) }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, (index ?? last) + (event.key === 'ArrowLeft' ? -1 : 1)))) } }}>
      <svg viewBox={`0 0 ${width} 240`} role="img" aria-label={`График: ${visible.map(s => s.label).join(', ')}`} preserveAspectRatio="none">
        <defs><clipPath id={`${id}-clip`}><rect x={left - 2} y={top - 3} width={right - left + 5} height={bottom - top + 6}/></clipPath>{series.map((s, i) => <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colors[i % 3]} stopOpacity=".10"/><stop offset="100%" stopColor={colors[i % 3]} stopOpacity="0"/></linearGradient>)}</defs>
        {scale.ticks.map(value => <g key={value} className="admin-chart-tick"><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="var(--admin-line)" strokeOpacity={value === 0 ? 1 : .65}/><text x={left - 10} y={y(value) + 4} textAnchor="end">{tickFormat(value)}</text></g>)}
        <g clipPath={`url(#${id}-clip)`}>
          {series.map((s, i) => {
            if (hidden.includes(s.key)) return null
            if (variant === 'bar') {
              const groupWidth = Math.min(48, Math.max(8, (right - left) * Math.min(domain.stepMs, duration) / Math.max(1, duration) * .7))
              const barWidth = Math.max(2, groupWidth / visible.length - 3), seriesIndex = visible.findIndex(item => item.key === s.key)
              return <g key={s.key} className="admin-chart-series">{data.map((item, n) => known(item, s.key) && <rect key={n} className="admin-chart-bar" x={Math.max(left, Math.min(right - groupWidth, x(n) - groupWidth / 2)) + seriesIndex * (barWidth + 3)} y={y(Number(item[s.key]))} width={barWidth} height={Math.max(0, bottom - y(Number(item[s.key])))} rx="2" fill={colors[i % 3]} fillOpacity={index === null || index === n ? .85 : .35}/>)}</g>
            }
            const model = models.get(s.key)!
            // Only short interruptions get a subdued connection. Long gaps stay
            // empty; no interpolated values are ever added to data or tooltips.
            const bridgeLimit = Number.isFinite(domain.stepMs) ? domain.stepMs * 3 : duration / 20
            const bridges = model.bridges.filter(([a, b]) => times[b] - times[a] <= bridgeLimit)
            return <g key={s.key} className="admin-chart-series">
              {bridges.map(([a, b], n) => <path key={'gap' + n} className="admin-chart-bridge" d={`M${x(a)},${y(Number(data[a][s.key]))} L${x(b)},${y(Number(data[b][s.key]))}`} fill="none" stroke={colors[i % 3]} strokeWidth="1.5" strokeOpacity=".35" vectorEffect="non-scaling-stroke"/>)}
              {model.parts.map(({ indices, partial }, n) => indices.length > 1 ? <g key={n}>
                <path className="admin-chart-area" d={`${curve(s, indices)} L${x(indices.at(-1)!)},${bottom} L${x(indices[0])},${bottom}Z`} fill={`url(#${id}-${s.key})`}/>
                <path className={`admin-chart-line ${partial ? 'is-provisional' : ''}`} d={curve(s, indices)} fill="none" stroke={colors[i % 3]} strokeWidth="2.25" strokeOpacity={partial ? .65 : 1} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
              </g> : !bridges.some(pair => pair.includes(indices[0])) && <path key={n} className="admin-chart-sample" d={`M${x(indices[0]) - 3},${y(Number(data[indices[0]][s.key]))} h6`} stroke={colors[i % 3]} strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>)}
            </g>
          })}
          {index !== null && <g className="admin-chart-cursor"><line x1={x(index)} x2={x(index)} y1={top} y2={bottom} stroke="var(--admin-accent)" strokeOpacity=".25"/>{series.map((s, i) => !hidden.includes(s.key) && known(data[index], s.key) && <circle key={s.key} cx={x(index)} cy={y(Number(data[index][s.key]))} r="3.5" fill={colors[i % 3]} stroke="var(--admin-surface)" strokeWidth="2"/>)}</g>}
        </g>
        {(width < 420 ? [0, 1] : width > 900 ? [0, .25, .5, .75, 1] : [0, .5, 1]).map(position => <text key={position} x={left + position * (right - left)} y="228" textAnchor={position === 1 ? 'end' : position === 0 ? 'start' : 'middle'}>{axisLabel(Date.parse(domain.from) + position * duration)}</text>)}
      </svg>
      {row && index !== null && <div className="admin-chart-tooltip" style={{ left: `${Math.max(width < 420 ? 36 : 22, Math.min(width < 420 ? 64 : 78, x(index) / width * 100))}%` }}><strong>{label(historyTime(row))}</strong>{series.map((s, i) => !hidden.includes(s.key) && <span key={s.key}><i style={{ background: colors[i % 3] }}/>{s.label}<b>{known(row, s.key) ? format(Number(row[s.key])) : 'Нет замера'}</b></span>)}{row.incomplete && <small>Неполный интервал наблюдений</small>}</div>}
    </div>}
    <div className="admin-legend">{series.map((s, i) => <button type="button" key={s.key} aria-pressed={!hidden.includes(s.key)} onClick={() => { setSelected(null); setHidden(current => current.includes(s.key) ? current.filter(key => key !== s.key) : visible.length > 1 ? [...current, s.key] : current) }}><i style={{ background: colors[i % 3] }}/>{s.label}</button>)}
      {(historyStartedAt || missing) && <HelpTip label="Как читать график">График показывает сохранённые замеры. При неполных наблюдениях линия приглушена; длинные пропуски остаются пустыми. Значения в подсказке не интерполируются.{historyStartedAt && <> История собирается с {label(Date.parse(historyStartedAt))} · МСК.</>}</HelpTip>}
      {hasData && missing && <span className="admin-chart-history-note">Неполная история</span>}
    </div>
  </div>
}
