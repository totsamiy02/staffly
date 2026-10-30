import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { createDatabaseBackup } from './database-backup.ts'

type Column = { name: string; mode: 'legacy-wall' | 'instant' }
type Table = { name: string; keys: string[]; columns: Column[]; rows: number; before: string; after: string }
export type TimeMigrationPlan = { formatVersion: 1; database: string; sourceTimezone: string; policy: 'preserve-legacy-application-values'; tables: Table[] }
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const qualified = (value: string) => `public.${identifier(value)}`

// SQL-clock infrastructure retains physical instants. Business values retain what
// the old Prisma client returned, including history; do not guess the original
// writer from a +/-N hour heuristic. Opaque JSON/date columns are never rewritten.
function mode(table: string): Column['mode'] {
  return ['api_rate_limits', 'email_deliveries', 'organization_resource_budgets'].includes(table) ? 'instant' : 'legacy-wall'
}

async function catalog(db: PoolClient) {
  const { rows } = await db.query<{ name: string; keys: string[]; columns: string[] }>(`
    SELECT c.relname AS name,
      ARRAY(SELECT a.attname::text FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid=c.oid AND i.indisprimary ORDER BY k.ord) AS keys,
      ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        AND a.atttypid='timestamptz'::regtype ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('_prisma_migrations','app_time_model')
    ORDER BY c.relname`)
  if (rows.some(row => !row.keys.length)) throw new Error('Every application table must have a primary key for a verified time migration')
  return rows.map(row => ({ ...row, columns: row.columns.map(name => ({ name, mode: mode(row.name) })) }))
}

function converted(column: string) { return `(t.${identifier(column)} AT TIME ZONE $1) AT TIME ZONE 'UTC'` }
async function fingerprint(db: PoolClient, table: Pick<Table, 'name' | 'keys' | 'columns'>, sourceTimezone?: string) {
  const changes = table.columns.filter(column => column.mode === 'legacy-wall')
  const projection = sourceTimezone && changes.length
    ? `to_jsonb(t) || jsonb_build_object(${changes.map(column => `'${column.name.replaceAll("'", "''")}', ${converted(column.name)}`).join(',')})`
    : 'to_jsonb(t)'
  await db.query(`DECLARE time_rows NO SCROLL CURSOR FOR SELECT (${projection})::text AS record FROM ${qualified(table.name)} t ORDER BY ${table.keys.map(key => 't.' + identifier(key)).join(',')}`,
    sourceTimezone && changes.length ? [sourceTimezone] : [])
  const hash = createHash('sha256'); let rows = 0
  try {
    for (;;) {
      const batch = await db.query<{ record: string }>('FETCH FORWARD 500 FROM time_rows')
      for (const row of batch.rows) { hash.update(row.record).update('\n'); rows++ }
      if (batch.rows.length < 500) break
    }
  } finally { await db.query('CLOSE time_rows') }
  return { rows, hash: hash.digest('hex') }
}

async function state(db: PoolClient) {
  const { rows: [row] } = await db.query<{ database: string; version: string; sourceTimezone: string | null }>(`
    SELECT current_database() AS database, version, source_timezone AS "sourceTimezone" FROM public.app_time_model WHERE id=1`)
  if (!row) throw new Error('Apply the UTC time-model schema migration first')
  return row
}

export async function planTimeMigration(pool: Pool, originalTimezone?: string): Promise<TimeMigrationPlan> {
  const db = await pool.connect()
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await db.query("SET LOCAL TIME ZONE 'UTC'")
    const current = await state(db)
    if (current.version !== 'legacy-v0') throw new Error('Database already uses utc-v1; conversion must not be repeated')
    const sourceTimezone = originalTimezone ?? current.sourceTimezone
    if (!sourceTimezone) throw new Error('The source timezone is unknown: supply --source-timezone=ORIGINAL_IANA_ZONE from the backup source, not the target server setting')
    if (current.sourceTimezone && current.sourceTimezone !== sourceTimezone) throw new Error('Source timezone differs from recorded legacy provenance')
    new Intl.DateTimeFormat('en', { timeZone: sourceTimezone }).format()
    await db.query('SELECT now() AT TIME ZONE $1', [sourceTimezone]) // Validate the source IANA zone in PostgreSQL.
    const tables: Table[] = []
    for (const table of await catalog(db)) {
      const before = await fingerprint(db, table), after = await fingerprint(db, table, sourceTimezone)
      tables.push({ ...table, rows: before.rows, before: before.hash, after: after.hash })
    }
    await db.query('COMMIT')
    return { formatVersion: 1, database: current.database, sourceTimezone,
      policy: 'preserve-legacy-application-values', tables }
  } catch (error) { await db.query('ROLLBACK'); throw error }
  finally { db.release() }
}

async function verifyBackup(file: string) {
  const info = await stat(file)
  if (!info.isFile() || info.size < 5 || (info.mode & 0o077) !== 0) throw new Error('A private, nonempty PostgreSQL custom-format backup is required')
  const handle = await open(file, 'r')
  try { const header = Buffer.alloc(5); await handle.read(header, 0, 5, 0); if (header.toString() !== 'PGDMP') throw new Error('Invalid PostgreSQL backup format') }
  finally { await handle.close() }
  const hash = createHash('sha256')
  for await (const part of createReadStream(file)) hash.update(part)
  return { bytes: info.size, sha256: hash.digest('hex') }
}

export async function applyTimeMigration(pool: Pool, plan: TimeMigrationPlan, backupFile: string) {
  const backup = await verifyBackup(backupFile), db = await pool.connect()
  try {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await db.query("SET LOCAL TIME ZONE 'UTC'")
    await db.query("SET LOCAL lock_timeout='5s'")
    await db.query("SET LOCAL statement_timeout='120s'")
    await db.query('SELECT pg_advisory_xact_lock(729041, 1)')
    const current = await state(db)
    if (current.version !== 'legacy-v0') throw new Error('Database already uses utc-v1; conversion must not be repeated')
    if (plan.formatVersion !== 1 || plan.policy !== 'preserve-legacy-application-values' || plan.database !== current.database || !plan.sourceTimezone || (current.sourceTimezone !== null && plan.sourceTimezone !== current.sourceTimezone)) throw new Error('Time migration plan does not match this database')
    const definitions = await catalog(db)
    if (JSON.stringify(definitions) !== JSON.stringify(plan.tables.map(({ name, keys, columns }) => ({ name, keys, columns })))) throw new Error('Schema or conversion policy changed since the plan was created')
    const { rows: [connections] } = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")
    if (connections.count) throw new Error('Stop database clients/API/worker before conversion; existing sessions may still use the legacy timezone')
    await db.query('LOCK TABLE public.app_time_model, ' + definitions.map(table => qualified(table.name)).join(', ') + ' IN ACCESS EXCLUSIVE MODE')
    await db.query('SET CONSTRAINTS ALL DEFERRED')
    for (const table of plan.tables) {
      const before = await fingerprint(db, table)
      if (before.rows !== table.rows || before.hash !== table.before) throw new Error(`Data changed since the time plan was created: ${table.name}`)
    }
    // Side effects (mail/live/business triggers) must not run during a historical
    // conversion. Foreign keys and deferred exclusion constraints stay enabled.
    const triggers = (await db.query<{ table: string; name: string }>(`SELECT c.relname AS table, t.tgname AS name FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled='O' ORDER BY c.relname,t.tgname`)).rows
    for (const trigger of triggers) await db.query(`ALTER TABLE ${qualified(trigger.table)} DISABLE TRIGGER ${identifier(trigger.name)}`)
    for (const table of plan.tables) {
      const columns = table.columns.filter(column => column.mode === 'legacy-wall')
      if (columns.length && table.rows) await db.query(`UPDATE ${qualified(table.name)} t SET ${columns.map(column => `${identifier(column.name)}=${converted(column.name)}`).join(', ')}`, [plan.sourceTimezone])
      const after = await fingerprint(db, table)
      if (after.rows !== table.rows || after.hash !== table.after) throw new Error(`Post-conversion verification failed: ${table.name}`)
    }
    await db.query('SET CONSTRAINTS ALL IMMEDIATE')
    for (const trigger of triggers) await db.query(`ALTER TABLE ${qualified(trigger.table)} ENABLE TRIGGER ${identifier(trigger.name)}`)
    await db.query("UPDATE public.app_time_model SET version='utc-v1',source_timezone=$1,converted_at=clock_timestamp() WHERE id=1", [plan.sourceTimezone])
    await db.query(`ALTER DATABASE ${identifier(current.database)} SET timezone TO 'UTC'`)
    await db.query('COMMIT')
    return { status: 'converted-and-verified', database: current.database, sourceTimezone: plan.sourceTimezone, targetTimezone: 'UTC',
      policy: plan.policy, tables: plan.tables.length, rows: plan.tables.reduce((sum, table) => sum + table.rows, 0), backup }
  } catch (error) { await db.query('ROLLBACK'); throw error }
  finally { db.release() }
}

async function writePrivate(file: string, value: unknown) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 })
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
  const rawUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
  if (!rawUrl || !options.plan) throw new Error('Supply MIGRATION_DATABASE_URL (or DATABASE_URL) and an explicit --plan=artifacts/.../plan.json')
  const url = new URL(rawUrl); url.searchParams.delete('schema')
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  const pool = new Pool({ connectionString: url.toString(), max: 1 })
  try {
    if (options.apply === 'true') {
      if (!options.backup || !options.report) throw new Error('Apply requires explicit --backup=...dump and --report=...json paths')
      const plan = JSON.parse(await readFile(options.plan, 'utf8')) as TimeMigrationPlan
      await createDatabaseBackup({ databaseUrl: url.toString(), file: options.backup, pgBin: process.env.PG_BIN })
      const result = await applyTimeMigration(pool, plan, options.backup)
      await writePrivate(options.report, result)
      console.log(JSON.stringify(result))
    } else {
      const plan = await planTimeMigration(pool, options['source-timezone'])
      await writePrivate(options.plan, plan)
      console.log(JSON.stringify({ status: 'planned', tables: plan.tables.length, rows: plan.tables.reduce((sum, table) => sum + table.rows, 0), sourceTimezone: plan.sourceTimezone }))
    }
  } finally { await pool.end() }
}
