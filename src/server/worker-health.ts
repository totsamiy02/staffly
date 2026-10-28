import { rename, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { backgroundTasksHealthy } from './background-task.ts'
import { startBackgroundTask } from './background-task.ts'

export function startWorkerHealth(query: () => Promise<unknown>, file = path.join(tmpdir(), 'staffly-worker-health')) {
  const stop = startBackgroundTask({ name: 'Worker health', intervalMs: 10000, run: async () => {
    await query()
    if (!backgroundTasksHealthy()) { await unlink(file).catch(() => {}); return }
    await writeFile(file + '.tmp', 'ok\n', { mode: 0o600 })
    await rename(file + '.tmp', file)
  } })
  return async () => { await stop(); await unlink(file).catch(() => {}); await unlink(file + '.tmp').catch(() => {}) }
}
