import { writeFile } from 'node:fs/promises'
import pg from 'pg'

const source = new URL(process.env.DATABASE_URL)
if (source.hostname === 'localhost') source.hostname = '127.0.0.1'
const admin = new pg.Client({ connectionString: source.toString() })
await admin.connect()
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'staffly_test'")
if (!exists.rowCount) {
  try {
    await admin.query('CREATE DATABASE staffly_test')
  } catch (error) {
    if (error.code !== '42501') throw error
    const localAdmin = new pg.Client({ host: '127.0.0.1', port: Number(source.port || 5432), database: 'postgres', user: process.env.USER })
    await localAdmin.connect()
    try { await localAdmin.query('CREATE DATABASE staffly_test') } finally { await localAdmin.end() }
  }
}
await admin.end()

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`
const localAdmin = new pg.Client({ host: '127.0.0.1', port: Number(source.port || 5432), database: 'postgres', user: process.env.USER })
await localAdmin.connect()
try { await localAdmin.query(`ALTER DATABASE staffly_test OWNER TO ${quoteIdentifier(decodeURIComponent(source.username))}`) } finally { await localAdmin.end() }
const schemaAdmin = new pg.Client({ host: '127.0.0.1', port: Number(source.port || 5432), database: 'staffly_test', user: process.env.USER })
await schemaAdmin.connect()
try { await schemaAdmin.query(`ALTER SCHEMA public OWNER TO ${quoteIdentifier(decodeURIComponent(source.username))}`) } finally { await schemaAdmin.end() }

source.pathname = '/staffly_test'
source.searchParams.set('schema', 'public')
await writeFile('src/server/.env.test', [
  `DATABASE_URL="${source.toString()}"`,
  'JWT_SECRET="staffly-test-secret-only-for-local-tests-2026"',
  'APP_ORIGIN="http://localhost:5173"',
  'NODE_ENV="test"',
  '',
].join('\n'), { mode: 0o600 })
console.log('staffly_test is ready; src/server/.env.test created')
