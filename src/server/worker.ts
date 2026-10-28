import { startWorkers } from './workers.ts'
import { prisma, databasePool } from './db.ts'
import { checkDatabasePolicy } from './database-policy.ts'
import { startWorkerHealth } from './worker-health.ts'

if (process.env.NODE_ENV === 'production') await checkDatabasePolicy(databasePool)

const stop = startWorkers()
const stopHealth = startWorkerHealth(() => prisma.$queryRaw`SELECT 1`)
const keepAlive = setInterval(() => {}, 60000)
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => process.exit(1), 75000)
  try { await Promise.all([stop(), stopHealth()]); await prisma.$disconnect(); clearInterval(keepAlive); clearTimeout(deadline) }
  catch (error) { console.error('Worker shutdown failed:', error); process.exitCode = 1; clearInterval(keepAlive); clearTimeout(deadline) }
}
process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })
console.log('Staffly background worker started')
