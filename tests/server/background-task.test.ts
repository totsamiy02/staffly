import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { startBackgroundTask, backgroundTasksHealthy } from '../../src/server/background-task.ts'

it('keeps a long progressing queue healthy while detecting a stalled task', async t => {
  let clock = Date.now(), checkpoint!: () => boolean, finish!: () => void
  t.mock.method(Date, 'now', () => clock)
  const pending = new Promise<void>(resolve => { finish = resolve })
  const stop = startBackgroundTask({ name: 'long-queue', intervalMs: 1000, run: async active => { checkpoint = active; await pending } })
  try {
    await turn(); clock += 300001
    assert.equal(backgroundTasksHealthy(), false)
    assert.equal(checkpoint(), true)
    assert.equal(backgroundTasksHealthy(), true)
  } finally { finish(); await stop() }
})

it('reports persistent failures and stalled tasks as unhealthy, then recovers after a successful run', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  t.mock.method(console, 'error', () => {})
  let fail = true
  const stop = startBackgroundTask({ name: 'health-fixture', intervalMs: 100, run: async () => { if (fail) throw new Error('unavailable') } })
  try {
    await turn(); assert.equal(backgroundTasksHealthy(), true)
    t.mock.timers.tick(100); await turn()
    t.mock.timers.tick(100); await turn()
    assert.equal(backgroundTasksHealthy(), false)
    fail = false; t.mock.timers.tick(100); await turn()
    assert.equal(backgroundTasksHealthy(), true)
    assert.equal(backgroundTasksHealthy(Date.now() + 300001), false)
  } finally { await stop() }
  assert.equal(backgroundTasksHealthy(), true)
})

it('stops scheduling, signals long work to stop and waits for that work before disconnect', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let finish!: () => void, calls = 0, shouldContinue!: () => boolean
  const work = new Promise<void>(resolve => { finish = resolve })
  const stop = startBackgroundTask({ name: 'test', intervalMs: 100, run: async active => { calls++; shouldContinue = active; await work } })
  await turn()
  t.mock.timers.tick(500)
  assert.equal(calls, 1)
  let drained = false
  const stopped = stop().then(() => { drained = true })
  assert.equal(shouldContinue(), false)
  await turn()
  assert.equal(drained, false)
  finish(); await stopped
  t.mock.timers.tick(500); await turn()
  assert.equal(calls, 1)
  await stop()
})

it('retries an expired maintenance transaction once in a fresh run and recovers', async t => {
  const warning = t.mock.method(console, 'warn', () => {})
  const error = t.mock.method(console, 'error', () => {})
  let attempts = 0
  const stop = startBackgroundTask({ name: 'test', intervalMs: 60_000, retryExpiredTransaction: true, run: async () => { if (++attempts === 1) throw Object.assign(new Error('expired'), { code: 'P2028' }) } })
  await turn(); await stop()
  assert.equal(attempts, 2); assert.equal(warning.mock.callCount(), 1); assert.equal(error.mock.callCount(), 0)
})

it('reports a failed recovery and never retries an expired transaction indefinitely', async t => {
  t.mock.method(console, 'warn', () => {})
  const error = t.mock.method(console, 'error', () => {})
  let attempts = 0
  const failure = Object.assign(new Error('expired'), { code: 'P2028' })
  const stop = startBackgroundTask({ name: 'test', intervalMs: 60_000, retryExpiredTransaction: true, run: async () => { attempts++; throw failure } })
  await turn(); await stop()
  assert.equal(attempts, 2); assert.equal(error.mock.callCount(), 1)
  assert.equal(error.mock.calls[0].arguments[1], failure)
})

it('does not retry unrelated failures or begin work after an immediate stop', async t => {
  const error = t.mock.method(console, 'error', () => {})
  let attempts = 0
  const stop = startBackgroundTask({ name: 'test', intervalMs: 60_000, retryExpiredTransaction: true, run: async () => { attempts++; throw new Error('unexpected') } })
  await turn(); await stop()
  assert.equal(attempts, 1); assert.equal(error.mock.callCount(), 1)
  const immediate = startBackgroundTask({ name: 'test', intervalMs: 60_000, run: async () => { attempts++ } })
  await immediate()
  assert.equal(attempts, 1)
})
