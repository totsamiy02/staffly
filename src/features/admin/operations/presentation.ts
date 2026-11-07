import type { JobStatus,OperationalJob } from './contracts.ts'
const plural=new Intl.PluralRules('ru-RU')
export const word=(value:number,one:string,few:string,many:string)=>plural.select(value)==='one'?one:plural.select(value)==='few'?few:many
export const jobProblem=(job:OperationalJob)=>job.error??(job.attention?job.status==='RUNNING'?'Срок захвата истёк — ожидаем восстановления обработки':'Задача ожидает обработки дольше обычного':null)
export const jobLabels:Record<JobStatus,string>={PENDING:'В очереди',RUNNING:'Выполняется',SCHEDULED:'Запланирована',RETRY:'Ожидает повтора',DONE:'Готово',FAILED:'Ошибка',SKIPPED:'Пропущена'}
export const nodeLabels={healthy:'На связи',warning:'Требует внимания',offline:'Нет связи',stopped:'Завершён',unknown:'Нет данных'}
export const duration=(seconds:number)=>seconds<60?`${Math.round(seconds)} с`:seconds<3600?`${Math.floor(seconds/60)} мин`:`${Math.floor(seconds/3600)} ч ${Math.floor(seconds%3600/60)} мин`
