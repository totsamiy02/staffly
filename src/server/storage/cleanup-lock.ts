import { databasePool } from '../db.ts'
export async function withFileCleanupLock<T>(id:string,work:()=>Promise<T>):Promise<T|false>{
 const db=await databasePool.connect();let acquired=false
 try{
  acquired=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,92)) AS acquired',[id])).rows[0].acquired
  if(!acquired)return false
  if(!(await db.query('SELECT public.platform_file_cleanup_allowed($1) AS allowed',[id])).rows[0].allowed)return false
  return await work()
 }finally{if(acquired)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,92))',[id]).catch(()=>{});db.release()}
}
