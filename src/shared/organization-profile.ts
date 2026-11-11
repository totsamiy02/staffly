import { z } from 'zod'

export const weekDayNames = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'] as const
export const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Укажите время в формате ЧЧ:ММ.')
const daySchema = z.discriminatedUnion('status', [
  z.object({ day:z.number().int().min(0).max(6), status:z.literal('UNSET') }).strict(),
  z.object({ day:z.number().int().min(0).max(6), status:z.literal('CLOSED') }).strict(),
  z.object({ day:z.number().int().min(0).max(6), status:z.literal('ALL_DAY') }).strict(),
  z.object({ day:z.number().int().min(0).max(6), status:z.literal('OPEN'), start:clock, end:clock, breakStart:clock.optional(), breakEnd:clock.optional() }).strict(),
])
export const minuteOfDay = (time:string) => Number(time.slice(0,2))*60+Number(time.slice(3))
export const openingHoursSchema = z.array(daySchema).length(7).superRefine((days,ctx)=>{
  if(new Set(days.map(d=>d.day)).size!==7) ctx.addIssue({code:'custom',message:'Каждый день недели должен быть указан один раз.'})
  for(const item of days){
    if(item.status!=='OPEN')continue
    const start=minuteOfDay(item.start), duration=(minuteOfDay(item.end)-start+1440)%1440
    if(!duration)ctx.addIssue({code:'custom',message:'Начало и конец работы не должны совпадать. Для полных суток выберите «Круглосуточно».'})
    if(!!item.breakStart!==!!item.breakEnd)ctx.addIssue({code:'custom',message:'Укажите начало и конец перерыва.'})
    if(item.breakStart&&item.breakEnd){const from=(minuteOfDay(item.breakStart)-start+1440)%1440,to=(minuteOfDay(item.breakEnd)-start+1440)%1440;if(!(from>0&&to>from&&to<duration))ctx.addIssue({code:'custom',message:'Перерыв должен находиться внутри часов работы.'})}
  }
}).transform(days=>days.sort((a,b)=>a.day-b.day))
export type OpeningHours = z.infer<typeof openingHoursSchema>
export type LocationProfile = {kind?:'PHYSICAL'|'REMOTE';phone?:string|null;description?:string|null;openingHours?:OpeningHours|null;inheritsTimezone?:boolean;revision?:number}
export function emptyOpeningHours():OpeningHours{return weekDays.map((_,day)=>({day,status:'UNSET'}))}
export function hoursLabel(day:OpeningHours[number]){
  if(day.status==='UNSET')return 'Не заданы'
  if(day.status==='CLOSED')return 'Выходной'
  if(day.status==='ALL_DAY')return 'Круглосуточно'
  return `${day.start} — ${day.end}${day.end<day.start?' (+1 день)':''}${day.breakStart&&day.breakEnd?`, перерыв ${day.breakStart} — ${day.breakEnd}`:''}`
}

export function openingHoursConfirmationFrom(error:unknown):string|undefined{
 const failure=error as {code?:string;errors?:{openingHoursConfirmation?:unknown}}|null
 if(failure?.code!=='OPENING_HOURS_WARNING')return
 const token=failure.errors?.openingHoursConfirmation
 return typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)?token:undefined
}
