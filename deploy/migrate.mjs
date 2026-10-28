import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const url = process.env.MIGRATION_DATABASE_URL
if (!url) throw new Error('MIGRATION_DATABASE_URL is required')
// The elevated URL exists only in this one-shot service, never in API/worker env.
const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'prisma7.config.ts'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: url },
})
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
if (code !== 0) process.exit(1)
const client = new pg.Client({ connectionString: url })
try { await client.connect(); await client.query(await readFile(new URL('./runtime-grants.sql', import.meta.url), 'utf8')) }
finally { await client.end() }
