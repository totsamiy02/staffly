import { historySegments,historyTime,type HistoryPoint,type HistoryRange } from '../../shared/monitoring-history.ts'
export const chartKnown=(row:HistoryPoint,key:string)=>row[key]!==null&&row[key]!==undefined&&Number.isFinite(Number(row[key]))
/** Integer counters never acquire fractional ticks; zero-only series use 0–1. */
export function chartScale(values:number[],intervals=4){
 const valid=values.filter(Number.isFinite),peak=Math.max(0,...valid),integer=valid.every(Number.isInteger)
 if(peak===0)return{max:1,ticks:[0,1]}
 const raw=peak/Math.max(2,intervals),power=10**Math.floor(Math.log10(raw))
 const step=Math.max(integer?1:0,[1,2,5,10].map(n=>n*power).find(n=>n>=raw)??power*10)
 const max=Number((Math.ceil(peak/step)*step).toPrecision(12))
 return{max,ticks:Array.from({length:Math.round(max/step)+1},(_,i)=>Number((i*step).toPrecision(12)))}
}
/** Partial observations remain connected; missing observations remain distinct. */
export function chartSeries(data:HistoryPoint[],key:string,stepMs:number){
 const runs=historySegments(data.map(row=>({...row,incomplete:false})),key,stepMs)
 const parts:Array<{indices:number[];partial:boolean}>=[]
 for(const indices of runs){
  let current=[indices[0]],partial=Boolean(data[indices[0]].incomplete)
  for(let n=1;n<indices.length;n++){
   const nextPartial=Boolean(data[indices[n-1]].incomplete||data[indices[n]].incomplete)
   if(n>1&&nextPartial!==partial){parts.push({indices:current,partial});current=[indices[n-1]]}
   partial=nextPartial;current.push(indices[n])
  }
  parts.push({indices:current,partial})
 }
 return{parts,bridges:runs.slice(1).map((run,index)=>[runs[index].at(-1)!,run[0]])}
}
export function chartGaps(data:HistoryPoint[],keys:string[],range:HistoryRange){
 const from=Date.parse(range.from),to=Date.parse(range.to),times=data.map(historyTime),bands:Array<{from:number;to:number}>=[]
 for(let i=0;i<data.length;i++){
  if(keys.some(key=>chartKnown(data[i],key)))continue
  const start=Math.max(from,i===0?from:(times[i-1]+times[i])/2),end=Math.min(to,i===data.length-1?to:(times[i]+times[i+1])/2)
  if(end<=start)continue
  const previous=bands.at(-1)
  if(previous&&Math.abs(previous.to-start)<1)previous.to=end
  else bands.push({from:start,to:end})
 }
 return bands
}
