import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool, PoolClient } from 'pg'

export const stages = ['pool', 'sql', 'auth', 'membership', 'permissions', 'json'] as const
type Stage = typeof stages[number]
type Totals = Partial<Record<Stage, number>>
type Histogram = { count: number; sumMs: number; maxMs: number; buckets: number[] }
export const timingBucketsMs = [1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000, 15000]
const context = new AsyncLocalStorage<Totals>()
const measurements = new Map<Stage, Histogram>()
const slow: Array<{ route: string; status: number; totalMs: number; stages: Totals }> = []
export function recordTiming(stage: Stage, ms: number, totals = context.getStore()) {
  if (totals) totals[stage] = (totals[stage] ?? 0) + ms
  let row = measurements.get(stage)
  if (!row) { row = { count: 0, sumMs: 0, maxMs: 0, buckets: timingBucketsMs.map(() => 0) }; measurements.set(stage, row) }
  row.count++; row.sumMs += ms; row.maxMs = Math.max(row.maxMs, ms)
  for (let i = 0; i < timingBucketsMs.length; i++) if (ms <= timingBucketsMs[i]) row.buckets[i]++
}
export async function measure<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try { return await work() } finally { recordTiming(stage, performance.now() - start) }
}
export function runRequestTiming(work: (totals: Totals) => void) { context.run({}, () => work(context.getStore()!)) }
export function recordSlow(route: string, status: number, totalMs: number, totals: Totals) {
  if (totalMs < 300) return
  if (slow.length === 100) slow.shift()
  slow.push({ route, status, totalMs, stages: { ...totals } })
}
export function performanceSnapshot() {
  return { bucketsMs: timingBucketsMs, measurements: Object.fromEntries(measurements), slow }
}

// Observe the pg public API without changing queries, transaction ordering, or
// callbacks. SQL timings include network/driver/event-loop time; pg_stat_statements
// measures server execution separately. Nested stages must not be added together.
export function observePool(pool: Pool) {
  const observed = new WeakSet<PoolClient>()
  function observe(client: PoolClient) {
    if (observed.has(client)) return
    observed.add(client)
    const query = client.query
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const start = performance.now(), callback = args.at(-1), totals = context.getStore()
      if (typeof callback === 'function') args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
        recordTiming('sql', performance.now() - start, totals)
        return Reflect.apply(callback, this, values)
      }
      try {
        const result = Reflect.apply(query, this, args)
        if (result && typeof result.then === 'function') return result.finally(() => recordTiming('sql', performance.now() - start, totals))
        return result
      } catch (error) { recordTiming('sql', performance.now() - start, totals); throw error }
    } as typeof client.query
  }
  const connect = pool.connect.bind(pool)
  pool.connect = ((callback?: (error: Error | undefined, client: PoolClient | undefined, release: (error?: Error | boolean) => void) => void) => {
    const start = performance.now(), resume = AsyncLocalStorage.snapshot()
    if (callback) return connect((error, client, release) => resume(() => {
      recordTiming('pool', performance.now() - start)
      if (client) observe(client)
      callback(error, client, release)
    }))
    return connect().then(client => { recordTiming('pool', performance.now() - start); observe(client); return client }, error => { recordTiming('pool', performance.now() - start); throw error })
  }) as typeof pool.connect
  return pool
}
