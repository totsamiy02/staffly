import { writeFile } from 'node:fs/promises'
import { prisma } from '../src/server/db.ts'
import { retentionPlan, runDataRetention, holdDeletion } from '../src/server/privacy/maintenance.ts'
import { purgeEnabled } from '../src/server/privacy/policy.ts'

// No public HTTP endpoint can run purge or change holds.
try {
  const args = process.argv.slice(2), hold = args.find(x => x.startsWith('--hold='))?.slice(7), release = args.find(x => x.startsWith('--release='))?.slice(10), ledger = args.find(x => x.startsWith('--export-ledger='))?.slice(16)
  if (hold || release) {
    const id = hold ?? release!
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Expected a deletion job UUID')
    console.log(JSON.stringify(await holdDeletion(id, Boolean(hold))))
  } else if (ledger) {
    // Keep an up-to-date copy outside DB backups. A restore must reconcile this
    // ledger before opening traffic; the DB backup's own ledger can be stale.
    const jobs = await prisma.dataDeletion.findMany({ select: { kind: true, subjectId: true, requestedAt: true, dueAt: true, completedAt: true, hold: true } })
    await writeFile(ledger, JSON.stringify({ format: 'staffly-deletion-ledger-v1', exportedAt: new Date(), jobs }) + '\n', { flag: 'wx', mode: 0o600 })
    console.log('Deletion ledger exported')
  } else if (args.includes('--apply=true')) {
    if (!purgeEnabled()) throw new Error('Final cleanup is disabled. Review plan, archive obligations, holds and backup lifecycle before enabling DATA_PURGE_ENABLED.')
    console.log(JSON.stringify(await runDataRetention()))
  } else console.log(JSON.stringify(await retentionPlan(), null, 2))
} finally { await prisma.$disconnect() }
