type Options = {
  name: string
  intervalMs: number
  run: (shouldContinue: () => boolean) => Promise<unknown>
  retryExpiredTransaction?: boolean
}

const states = new Set<{ intervalMs: number; startedAt: number; finishedAt: number; failures: number; running: boolean }>()
export function backgroundTasksHealthy(now = Date.now()) {
  return [...states].every(state => state.failures < 3 && now - (state.running ? state.startedAt : state.finishedAt) < Math.max(300000, state.intervalMs * 3))
}

export function startBackgroundTask({ name, intervalMs, run, retryExpiredTransaction = false }: Options) {
  let stopped = false
  const state = { intervalMs, startedAt: Date.now(), finishedAt: Date.now(), failures: 0, running: false }
  states.add(state)
  let current: Promise<void> | undefined
  const tick = () => {
    if (stopped || current) return
    state.running = true; state.startedAt = Date.now()
    current = Promise.resolve().then(async () => {
      if (stopped) return
      const shouldContinue = () => { state.startedAt = Date.now(); return !stopped }
      try { await run(shouldContinue) }
      catch (error) {
        if (!stopped && retryExpiredTransaction && typeof error === 'object' && error && 'code' in error && error.code === 'P2028') {
          console.warn(`${name}: transaction expired; retrying with a fresh transaction.`)
          await run(shouldContinue)
        } else throw error
      }
    }).then(() => { state.failures = 0 }).catch(error => { state.failures++; console.error(`${name} failed:`, error) }).finally(() => { state.running = false; state.finishedAt = Date.now(); current = undefined })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return () => {
    stopped = true
    states.delete(state)
    clearInterval(timer)
    return current ?? Promise.resolve()
  }
}
