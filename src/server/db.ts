import { SequentialPrismaPg } from './prisma-pg.ts'
import { PrismaClient } from '../generated/prisma/client.ts'
import { positiveInteger } from './runtime.ts'
import { Pool } from 'pg'
import { observePool } from './performance.ts'
import { validateProductionConfig } from './production-config.ts'

validateProductionConfig()

const rawUrl = process.env.DATABASE_URL
if (!rawUrl) throw new Error('DATABASE_URL is missing')

const url = new URL(rawUrl)
if (process.env.NODE_ENV === 'test' && url.pathname !== '/staffly_test') throw new Error('Tests require the dedicated staffly_test database')
url.searchParams.delete('schema')
if (url.hostname === 'localhost') url.hostname = '127.0.0.1'

export const databaseUrl = url.toString()
export const databasePool = observePool(new Pool({ connectionString: databaseUrl,
  max: positiveInteger('DB_POOL_MAX', 10, 100),
  connectionTimeoutMillis: positiveInteger('DB_CONNECT_TIMEOUT_MS', 3000, 60000),
  statement_timeout: positiveInteger('DB_STATEMENT_TIMEOUT_MS', 15000, 300000),
  idleTimeoutMillis: 30000,
}))
export const prisma = new PrismaClient({
  adapter: new SequentialPrismaPg(databasePool, { disposeExternalPool: true }),
})
