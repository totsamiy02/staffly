import { historySegments,historyTime,type HistoryPoint,type HistoryRange } from '../../shared/monitoring-history.ts'
export const chartKnown=(row:HistoryPoint,key:string)=>row[key]!==null&&row[key]!==undefined&&Number.isFinite(Number(row[key]))
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
