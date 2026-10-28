import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, link, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function libpqEnvironment(databaseUrl: string) {
  const url = new URL(databaseUrl)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL connection URL')
  const options: Record<string, string> = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', channel_binding: 'PGCHANNELBINDING', connect_timeout: 'PGCONNECT_TIMEOUT', options: 'PGOPTIONS', application_name: 'PGAPPNAME' }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C',
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10',
    PGSSLMODE: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'disable' : 'verify-full',
  }
  for (const [key, value] of url.searchParams) {
    if (key === 'schema') continue // Prisma-specific parameter, not a libpq option.
    if (!options[key]) throw new Error(`Unsupported backup connection parameter: ${key}`)
    env[options[key]] = value
  }
  return env
}

/** Database only: object-storage files require a separate versioned backup. */
export async function createDatabaseBackup({ databaseUrl, file, pgBin = '' }: { databaseUrl?: string; file?: string; pgBin?: string }) {
  if (!databaseUrl || !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('BACKUP_DATABASE_URL must be a PostgreSQL connection URL')
  if (!file || !file.endsWith('.dump')) throw new Error('Choose an explicit output path ending in .dump')
  const destination = path.resolve(file), temporary = destination + '.' + randomUUID() + '.tmp'
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const handle = await open(temporary, 'wx', 0o600); await handle.close()
  try {
    const child = spawn(pgBin ? path.join(pgBin, 'pg_dump') : 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--lock-wait-timeout=10s', '--file', temporary], {
      // Individual libpq variables keep credentials out of argv/logs.
      env: libpqEnvironment(databaseUrl), stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', part => { stderr = (stderr + part).slice(-2000) })
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
    if (code !== 0) throw new Error(`pg_dump failed (${code}): ${stderr.replaceAll(databaseUrl, '[redacted]').replaceAll(new URL(databaseUrl).password || 'unused-secret', '[redacted]')}`)
    const completed = await open(temporary, 'r+')
    try { await completed.sync() } finally { await completed.close() }
    await link(temporary, destination) // Fail rather than overwrite an existing backup.
    return destination
  } finally { await unlink(temporary).catch(() => {}) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = process.argv.slice(2).find(arg => arg.startsWith('--output='))?.slice(9)
  console.log(await createDatabaseBackup({ databaseUrl: process.env.BACKUP_DATABASE_URL, pgBin: process.env.PG_BIN, file }))
}
