import type { Pool } from 'pg'

export const timeModelVersion = 'utc-v1'

// The installed pg adapter formats bind dates without an offset and normalizes
// decoded timestamps as UTC. Pin EVERY session to UTC, including raw SQL, workers
// and LISTEN. Server/OS/browser zones must never determine persisted instants.
export function utcDatabaseUrl(raw: string) {
  const url = new URL(raw)
  url.searchParams.delete('schema')
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  const options = url.searchParams.get('options') ?? ''
  url.searchParams.set('options', `${options} -c timezone=UTC -c datestyle=ISO,YMD`.trim())
  return url.toString()
}

export async function checkTimeModel(pool: Pick<Pool, 'query'>) {
  const { rows: [connection] } = await pool.query<{ timezone: string; model: string | null }>(
    "SELECT current_setting('TimeZone') AS timezone, to_regclass('public.app_time_model')::text AS model")
  if (connection?.timezone !== 'UTC') throw new Error('Application database sessions must use UTC')
  if (!connection.model) throw new Error('Database time model is missing; apply migrations before starting the application')
  const { rows: [state] } = await pool.query<{ version: string }>('SELECT version FROM public.app_time_model WHERE id=1')
  if (state?.version !== timeModelVersion) throw new Error('Legacy database dates require conversion: run db:time:plan, verify the copy, then db:time:apply before starting the application')
}
