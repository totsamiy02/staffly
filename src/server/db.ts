import { SequentialPrismaPg } from './prisma-pg.ts'
import { PrismaClient } from '../generated/prisma/client.ts'
import { positiveInteger } from './runtime.ts'
import { Pool } from 'pg'
import { observePool } from './performance.ts'
import { validateProductionConfig } from './production-config.ts'
import { utcDatabaseUrl, checkTimeModel } from './database-time.ts'

validateProductionConfig()

const rawUrl = process.env.DATABASE_URL
if (!rawUrl) throw new Error('DATABASE_URL is missing')

if (process.env.NODE_ENV === 'test' && new URL(rawUrl).pathname !== '/staffly_test') throw new Error('Tests require the dedicated staffly_test database')

export const databaseUrl = utcDatabaseUrl(rawUrl)
export const databasePool = observePool(new Pool({ connectionString: databaseUrl,
  max: positiveInteger('DB_POOL_MAX', 10, 100),
  connectionTimeoutMillis: positiveInteger('DB_CONNECT_TIMEOUT_MS', 3000, 60000),
  statement_timeout: positiveInteger('DB_STATEMENT_TIMEOUT_MS', 15000, 300000),
  idleTimeoutMillis: 30000,
}))
export const prisma = new PrismaClient({
  adapter: new SequentialPrismaPg(databasePool, { disposeExternalPool: true }),
})
// Initialize adapter ownership/error hooks before the native startup check opens
// a connection. Even scripts that never issue a Prisma query must close the pool
// through $disconnect(), and an idle disconnect must not become an uncaught event.
try { await prisma.$connect(); await checkTimeModel(databasePool) }
catch (error) {
  await prisma.$disconnect().catch(() => {})
  if (!databasePool.ended) await databasePool.end().catch(() => {})
  throw error
}
