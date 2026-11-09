import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

// Run without a network, database URL, channel secrets or application .env.
const mode = process.argv[2]
assert(['maintenance', 'observer'].includes(mode), 'Choose the operator image to verify')
if (mode === 'maintenance') {
  assert.equal(typeof (await import('../../src/server/admin/service/runner.ts')).runServiceMaintenance, 'function')
  assert.equal(typeof (await import('../../src/server/admin/management/backup-runner.ts')).runBackupMaintenance, 'function')
  const version = execFileSync(path.join(process.env.PG_BIN ?? '', 'pg_dump'), ['--version'], { encoding: 'utf8' })
  assert.match(version, /^pg_dump \(PostgreSQL\) 18\./)
} else {
  assert.equal(typeof (await import('../../src/server/admin/service/external-probe.ts')).runExternalProbe, 'function')
}
console.log('Operator image imports are ready: ' + mode)
