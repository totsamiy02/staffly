import type { RequestDatabase } from './request-model.ts'
export async function lockRequest(db: RequestDatabase,id:string){await db.$queryRaw`SELECT id FROM requests WHERE id=${id}::uuid FOR UPDATE`}
