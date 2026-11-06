import { Pool, type PoolClient } from 'pg'
import { databaseUrl } from '../db.ts'
import { utcDatabaseUrl } from '../database-time.ts'
import { ApiError } from '../api-error.ts'
import { safeError } from '../security/safe-error.ts'

let pool: Pool | undefined
let policy: Promise<void> | undefined
export function adminConfigured() { return process.env.NODE_ENV !== 'production' || Boolean(process.env.ADMIN_DATABASE_URL && process.env.ADMIN_AUTH_SECRET) }
export function adminPool() {
  if (!adminConfigured()) throw new ApiError(503, 'ADMIN_UNAVAILABLE', 'Административный доступ не настроен.')
  if(!pool){pool=new Pool({ connectionString: utcDatabaseUrl(process.env.ADMIN_DATABASE_URL || databaseUrl), max: 3, connectionTimeoutMillis: 3000, statement_timeout: 10000, idleTimeoutMillis: 30000 });pool.on('error',error=>console.warn('Admin database unavailable:',safeError(error)))}
  return pool
}
export async function checkAdminDatabase() {
  if (process.env.NODE_ENV !== 'production') return
  policy ??= (async () => {
    const { rows: [role] } = await adminPool().query(`SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
      has_table_privilege(current_user,'staffly_admin.accounts','INSERT,UPDATE,DELETE,TRUNCATE') AS can_grant,
      has_table_privilege(current_user,'staffly_admin.audit_events','UPDATE,DELETE,TRUNCATE') AS can_erase,
      has_database_privilege(current_user,current_database(),'CREATE') OR has_schema_privilege(current_user,'staffly_admin','CREATE') OR has_schema_privilege(current_user,'public','CREATE') AS ddl
      FROM pg_roles WHERE rolname=current_user`)
    if (!role || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolbypassrls || role.can_grant || role.can_erase || role.ddl || role.name === decodeURIComponent(new URL(databaseUrl).username)) throw new ApiError(503, 'ADMIN_UNAVAILABLE', 'Административный доступ не настроен.')
  })().catch(error => { policy = undefined; throw error })
  await policy
}
export async function adminTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  await checkAdminDatabase()
  const db = await adminPool().connect()
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result }
  catch (error) { await db.query('ROLLBACK'); throw error }
  finally { db.release() }
}
export async function closeAdminDatabase() { if (pool) { await pool.end(); pool = undefined; policy = undefined } }
