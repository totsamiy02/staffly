import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { serializePgTransaction } from '../../src/server/prisma-pg.ts'

const query = (sql: string) => ({ sql, args: [], argTypes: [] })
const empty = { columnNames: [], columnTypes: [], rows: [] }

it('serializes reads, writes and transaction release without changing their results', async () => {
  const calls: string[] = []
  let active = 0, maximum = 0
  const operation = async (name: string) => { active++; maximum = Math.max(maximum, active); await turn(); calls.push(name); active-- }
  const tx = serializePgTransaction({
    queryRaw: async (q: ReturnType<typeof query>) => { await operation(q.sql); return empty },
    executeRaw: async (q: ReturnType<typeof query>) => { await operation(q.sql); return 7 },
    commit: async () => { await operation('release') }, rollback: async () => {},
  })
  const [rows, count] = await Promise.all([tx.queryRaw(query('read')), tx.executeRaw(query('write')), tx.commit()])
  assert.equal(rows, empty); assert.equal(count, 7); assert.equal(maximum, 1)
  assert.deepEqual(calls, ['read', 'write', 'release'])
})

it('preserves the original database error and allows rollback after a failed query', async () => {
  const failure = Object.assign(new Error('database constraint'), { originalCode: '23505', originalMessage: 'duplicate' })
  let released = 0
  const tx = serializePgTransaction({ queryRaw: async () => { throw failure }, executeRaw: async () => 0, commit: async () => {}, rollback: async () => { released++ } })
  await assert.rejects(tx.queryRaw(), error => error === failure)
  await tx.rollback()
  assert.equal(released, 1)
})

it('keeps different transaction connections independent', async () => {
  let active = 0, maximum = 0
  const make = () => serializePgTransaction({ queryRaw: async () => { active++; maximum = Math.max(maximum, active); await turn(); active--; return empty }, executeRaw: async () => 0, commit: async () => {}, rollback: async () => {} })
  const a = make(), b = make()
  await Promise.all([a.queryRaw(), b.queryRaw()])
  assert.equal(maximum, 2)
})
