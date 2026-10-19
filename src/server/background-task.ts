type Options = {
  name: string
  intervalMs: number
  run: (shouldContinue: () => boolean) => Promise<unknown>
  retryExpiredTransaction?: boolean
}

export function startBackgroundTask({ name, intervalMs, run, retryExpiredTransaction = false }: Options) {
  let stopped = false
  let current: Promise<void> | undefined
  const tick = () => {
    if (stopped || current) return
    current = Promise.resolve().then(async () => {
      if (stopped) return
      try { await run(() => !stopped) }
      catch (error) {
        if (!stopped && retryExpiredTransaction && typeof error === 'object' && error && 'code' in error && error.code === 'P2028') {
          console.warn(`${name}: transaction expired; retrying with a fresh transaction.`)
          await run(() => !stopped)
        } else throw error
      }
    }).catch(error => { console.error(`${name} failed:`, error) }).finally(() => { current = undefined })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return () => {
    stopped = true
    clearInterval(timer)
    return current ?? Promise.resolve()
  }
}
