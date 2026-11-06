import { useEffect, useId, useRef, useState } from 'react'

type Row=Record<string,string|number>
type Series={key:string;label:string}
const colors=['var(--admin-chart-purple)','var(--admin-chart-teal)','var(--theme-rose,#bd8caa)']
const format=(n:number)=>new Intl.NumberFormat('ru-RU').format(n)
function label(row:Row,_long=false){return new Date(String(row.at??row.day)).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',...(row.at?{hour:'2-digit',minute:'2-digit'}:{})})}
export default function AdminChart({data,series=[{key:'users',label:'Пользователи'},{key:'organizations',label:'Организации'}]}:{data:Row[];series?:Series[]}){
 const ref=useRef<HTMLDivElement>(null),id=useId().replace(/:/g,''),[entered,setEntered]=useState(false),[width,setWidth]=useState(760),[selected,setSelected]=useState<number|null>(null),[hidden,setHidden]=useState<string[]>([])
 useEffect(()=>{const observer=new ResizeObserver(items=>{if(items[0])setWidth(Math.max(220,Math.round(items[0].contentRect.width)))});if(ref.current)observer.observe(ref.current);return()=>observer.disconnect()},[])
 useEffect(()=>{const observer=new IntersectionObserver(items=>{if(items.some(item=>item.isIntersecting)){setEntered(true);observer.disconnect()}},{threshold:.18});if(ref.current)observer.observe(ref.current);return()=>observer.disconnect()},[])
 const visible=series.filter(s=>!hidden.includes(s.key)),last=data.length-1,max=Math.max(3,Math.ceil(Math.max(0,...data.flatMap(row=>visible.map(s=>Number(row[s.key]??0))))/3)*3)
 const x=(i:number)=>last?44+i/last*(width-72):width/2,y=(n:number)=>190-n/max*158
 const index=selected===null?null:Math.min(last,selected),row=index===null?null:data[index]
 const curve=(s:Series)=>{const points=data.map((r,i)=>[x(i),y(Number(r[s.key]??0))]);return points.map((p,i)=>i===0?`M${p[0]},${p[1]}`:`C${(points[i-1][0]+p[0])/2},${points[i-1][1]} ${(points[i-1][0]+p[0])/2},${p[1]} ${p[0]},${p[1]}`).join(' ')}
 return <div ref={ref} className={`admin-chart ${entered?'is-entered':''}`}>
  {!data.length?<div className="admin-chart-empty"><svg viewBox="0 0 100 34" aria-hidden="true"><path d="M0 28Q15 28 25 18T50 20T75 9T100 2"/></svg><strong>Пока нет наблюдений за этот период</strong><span>Новые замеры появятся автоматически. Выберите более длинный период.</span></div>:<div className="admin-chart-frame" tabIndex={0} role="slider" aria-label="Значения графика по датам" aria-valuemin={0} aria-valuemax={last} aria-valuenow={index??last} aria-valuetext={row?`${label(row,true)}: ${visible.map(s=>`${s.label} ${row[s.key]??0}`).join(', ')}`:undefined} onFocus={()=>setSelected(last)} onBlur={()=>setSelected(null)} onPointerMove={event=>{const rect=event.currentTarget.getBoundingClientRect(),point=(event.clientX-rect.left)/rect.width*width;setSelected(Math.max(0,Math.min(last,Math.round((point-44)/(width-72)*last))))}} onPointerLeave={()=>{if(document.activeElement!==ref.current?.querySelector('.admin-chart-frame'))setSelected(null)}} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();setSelected(event.key==='Home'?0:event.key==='End'?last:Math.max(0,Math.min(last,(index??last)+(event.key==='ArrowLeft'?-1:1))))}}}>
   <svg viewBox={`0 0 ${width} 240`} role="img" aria-label={`График: ${visible.map(s=>s.label).join(', ')}`} preserveAspectRatio="none">
    <defs>{series.map((s,i)=><linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colors[i%3]} stopOpacity=".19"/><stop offset="100%" stopColor={colors[i%3]} stopOpacity="0"/></linearGradient>)}</defs>
    {[0,1,2,3].map(i=><g key={i}><line x1="44" x2={width-28} y1={32+i*158/3} y2={32+i*158/3} stroke="var(--admin-line)" strokeDasharray="2 6"/><text x="2" y={36+i*158/3}>{new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(Math.round(max*(1-i/3)))}</text></g>)}
    {series.map((s,i)=>!hidden.includes(s.key)&&<g key={s.key} className="admin-chart-series"><path className="admin-chart-area" d={`${curve(s)} L${x(last)},190 L${x(0)},190Z`} fill={`url(#${id}-${s.key})`}/><path className="admin-chart-line" pathLength="1" d={curve(s)} fill="none" stroke={colors[i%3]} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>{last===0&&<circle cx={x(0)} cy={y(Number(data[0][s.key]??0))} r="4" fill={colors[i%3]}/>}</g>)}
    {index!==null&&<g className="admin-chart-cursor"><line x1={x(index)} x2={x(index)} y1="24" y2="190" stroke="var(--admin-muted)" strokeDasharray="3 4"/>{series.map((s,i)=>!hidden.includes(s.key)&&<circle key={s.key} cx={x(index)} cy={y(Number(data[index][s.key]??0))} r="4.5" fill={colors[i%3]} stroke="var(--admin-surface)" strokeWidth="2"/>)}</g>}
    {[...new Set((width<420?[0,last]:[0,Math.floor(last/2),last]))].map(i=><text key={i} x={x(i)} y="222" textAnchor={i===last?'end':i===0?'start':'middle'}>{label(data[i])}</text>)}
   </svg>
   {row&&index!==null&&<div className="admin-chart-tooltip" style={{left:`${Math.max(width<420?34:22,Math.min(width<420?66:78,x(index)/width*100))}%`}}><strong>{label(row,true)}</strong>{series.map((s,i)=>!hidden.includes(s.key)&&<span key={s.key}><i style={{background:colors[i%3]}}/>{s.label}<b>{format(Number(row[s.key]??0))}</b></span>)}</div>}
  </div>}
  <div className="admin-legend">{series.map((s,i)=><button type="button" key={s.key} aria-pressed={!hidden.includes(s.key)} onClick={()=>setHidden(current=>current.includes(s.key)?current.filter(key=>key!==s.key):visible.length>1?[...current,s.key]:current)}><i style={{background:colors[i%3]}}/>{s.label}</button>)}<small>Наведите или используйте ← →</small></div>
 </div>
}
