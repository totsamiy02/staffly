import { z } from 'zod'
import { ApiError } from '../api-error.ts'
export const periodFields={from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional()}
export function validatePeriod(q:{from?:string;to?:string}){
 if(q.from&&q.to&&Date.parse(q.from)>Date.parse(q.to))throw new ApiError(400,'ADMIN_PERIOD_INVALID','Начало интервала должно быть не позже окончания.')
}
/** Identifiers and parameter positions are fixed server code. End is inclusive. */
export const periodSql=(column:string,days:number,from:number,to:number)=>`(CASE WHEN $${from}::timestamptz IS NOT NULL OR $${to}::timestamptz IS NOT NULL THEN ($${from}::timestamptz IS NULL OR ${column}>=$${from}) AND ($${to}::timestamptz IS NULL OR ${column}<=$${to}) ELSE ($${days}::int=0 OR ${column}>now()-$${days}::int*interval '1 day') END)`
