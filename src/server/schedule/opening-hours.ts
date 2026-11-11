import {createHash} from 'node:crypto'
import type {Prisma} from '../../generated/prisma/client.ts'
import {openingHoursSchema,hoursLabel,weekDayNames,type OpeningHours} from '../../shared/organization-profile.ts'
import {stableJson} from '../../shared/stable-json.ts'
import {zonedDateAndTime,displayDate} from '../../app/schedule/date-utils.ts'
import {addCalendarDays,startOfZonedDate,zonedDateTimeToUtc} from './timezone.ts'
import {ApiError} from '../api-error.ts'
type Interval={start:Date;end:Date}
export function outsideOpeningHours(hours:OpeningHours,timezone:string,period:Interval){
 if(hours.every(d=>d.status==='UNSET'||d.status==='ALL_DAY'))return false
 const from=zonedDateAndTime(period.start.toISOString(),timezone).date,to=zonedDateAndTime(period.end.toISOString(),timezone).date
 const windows:Interval[]=[]
 // The policy repeats weekly. Any restricted weekly schedule has a gap within
 // a complete week; bound even deliberately enormous shift ranges.
 for(let date=addCalendarDays(from,-1),count=0;date<=to&&count<10;date=addCalendarDays(date,1),count++){
  const weekday=(new Date(date+'T12:00:00Z').getUTCDay()+6)%7,item=hours.find(d=>d.day===weekday)!
  if(item.status==='CLOSED')continue
  const next=addCalendarDays(date,1)
  if(item.status==='UNSET'||item.status==='ALL_DAY'){windows.push({start:startOfZonedDate(date,timezone),end:startOfZonedDate(next,timezone)});continue}
  const start=zonedDateTimeToUtc(date,item.start,timezone),end=zonedDateTimeToUtc(item.end<item.start?next:date,item.end,timezone)
  if(item.breakStart&&item.breakEnd){
   const pauseStart=zonedDateTimeToUtc(item.breakStart<item.start?next:date,item.breakStart,timezone),pauseEnd=zonedDateTimeToUtc(item.breakEnd<item.start?next:date,item.breakEnd,timezone)
   windows.push({start,end:pauseStart},{start:pauseEnd,end})
  }else windows.push({start,end})
 }
 let cursor=+period.start
 for(const window of windows.sort((a,b)=>+a.start-+b.start)){
  if(+window.end<=cursor)continue
  if(+window.start>cursor)return true
  cursor=Math.max(cursor,+window.end)
  if(cursor>=+period.end)return false
 }
 return cursor<+period.end
}
export async function checkOpeningHours(tx:Prisma.TransactionClient,organizationId:string,locationId:string,periods:Interval[],confirmation?:string){
 if(!periods.length)return
 await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
 const point=await tx.organizationLocation.findFirst({where:{id:locationId,organizationId,archivedAt:null}})
 if(!point)throw new ApiError(404,'LOCATION_NOT_FOUND','Точка не найдена.')
 if(point.openingHours==null)return
 const parsed=openingHoursSchema.safeParse(point.openingHours)
 if(!parsed.success)throw new ApiError(409,'OPENING_HOURS_INVALID','Проверьте часы работы точки в настройках организации.')
 const outside=periods.filter(period=>outsideOpeningHours(parsed.data,point.timezone,period))
 if(!outside.length)return
 const token=createHash('sha256').update(stableJson({organizationId,locationId,revision:point.revision,timezone:point.timezone,hours:parsed.data,periods:periods.map(p=>({start:p.start.toISOString(),end:p.end.toISOString()})).sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end))})).digest('hex')
 if(confirmation===token)return
 const days=[...new Set(outside.map(p=>zonedDateAndTime(p.start.toISOString(),point.timezone).date))]
 const description=days.slice(0,5).map(date=>{const day=(new Date(date+'T12:00:00Z').getUTCDay()+6)%7;return `${displayDate(date)}, ${weekDayNames[day]}: ${hoursLabel(parsed.data.find(d=>d.day===day)!)}`}).join('; ')
 throw new ApiError(409,'OPENING_HOURS_WARNING',`Смена выходит за часы работы точки «${point.name}» (${point.timezone}). ${description}.${days.length>5?' Есть и другие даты.':''} Измените время или подтвердите назначение за пределами часов работы.`,{openingHoursConfirmation:token,dates:days,count:outside.length})
}
