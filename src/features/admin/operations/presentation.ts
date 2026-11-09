import type { JobStatus,OperationalJob } from './contracts.ts'
export { word } from '../admin-format.ts'
export const jobProblem=(job:OperationalJob)=>job.status==='CANCELLED'?null:job.error??(job.attention?job.status==='RUNNING'?'Срок захвата истёк — ожидаем восстановления обработки':'Задача ожидает обработки дольше обычного':null)
export const jobLabels:Record<JobStatus,string>={PENDING:'В очереди',RUNNING:'Выполняется',SCHEDULED:'Запланирована',RETRY:'Ожидает повтора',DONE:'Готово',FAILED:'Ошибка',SKIPPED:'Пропущена',CANCELLED:'Отменена'}
export const nodeLabels={healthy:'На связи',warning:'Требует внимания',offline:'Нет связи',stopped:'Завершён',unknown:'Нет данных'}
export const duration=(seconds:number)=>seconds<60?`${Math.round(seconds)} с`:seconds<3600?`${Math.floor(seconds/60)} мин`:`${Math.floor(seconds/3600)} ч ${Math.floor(seconds%3600/60)} мин`
