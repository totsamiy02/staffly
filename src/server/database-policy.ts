import type { Pool } from 'pg'

export async function checkDatabasePolicy(pool: Pick<Pool, 'query'>, expectedTimezone = process.env.DB_TIMEZONE) {
  const { rows: [role] } = await pool.query<{ unsafe: boolean; ddl: boolean; owns: boolean; migrations: boolean; timezone: string }>(`
    SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS unsafe,
      has_schema_privilege(current_user, 'public', 'CREATE') OR has_database_privilege(current_user, current_database(), 'CREATE') AS ddl,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owns,
      CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN false
        ELSE has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE') END AS migrations,
      current_setting('TimeZone') AS timezone
    FROM pg_roles r WHERE r.rolname = current_user`)
  if (!role || role.unsafe || role.ddl || role.owns || role.migrations) throw new Error('Production database role must have data access only, without elevated, ownership, CREATE or migration-table privileges')
  if (!expectedTimezone || role.timezone !== expectedTimezone) throw new Error('Database timezone must match the explicitly configured DB_TIMEZONE; review existing data before changing it')
}
