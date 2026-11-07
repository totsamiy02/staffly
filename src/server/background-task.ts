import { captureWorkerFailure } from './support/diagnostics.ts'
import { safeError } from './security/safe-error.ts'
type Options = {
  name: string
  intervalMs: number
  run: (shouldContinue: () => boolean) => Promise<unknown>
  retryExpiredTransaction?: boolean
}

type TaskState = { name:string; intervalMs:number; startedAt:number; runStartedAt:number; finishedAt:number; lastSuccessAt:number|null; failures:number; runs:number; running:boolean; error:ReturnType<typeof safeError>|null }
const states = new Set<TaskState>()
export function backgroundTaskSnapshot() {
  return [...states].map(({name,intervalMs,runStartedAt,finishedAt,lastSuccessAt,failures,runs,running,error})=>({name,intervalMs,startedAt:new Date(runStartedAt).toISOString(),finishedAt:runs?new Date(finishedAt).toISOString():null,lastSuccessAt:lastSuccessAt?new Date(lastSuccessAt).toISOString():null,failures,runs,running,durationMs:Math.max(0,(running?Date.now():finishedAt)-runStartedAt),error}))
}
export function backgroundTasksHealthy(now = Date.now()) {
  return [...states].every(state => state.failures < 3 && now - (state.running ? state.startedAt : state.finishedAt) < Math.max(300000, state.intervalMs * 3))
}

export function startBackgroundTask({ name, intervalMs, run, retryExpiredTransaction = false }: Options) {
  let stopped = false
  const state:TaskState = { name,intervalMs,startedAt:Date.now(),runStartedAt:Date.now(),finishedAt:Date.now(),lastSuccessAt:null,failures:0,runs:0,running:false,error:null }
  states.add(state)
  let current: Promise<void> | undefined
  const tick = () => {
    if (stopped || current) return
    state.running = true; state.startedAt = state.runStartedAt = Date.now()
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
    }).then(() => { state.failures = 0; state.error=null; state.lastSuccessAt=Date.now() }).catch(error => { state.failures++;state.error=safeError(error);if(name!=='Operations telemetry')captureWorkerFailure(name,error);console.error(`${name} failed:`, state.error) }).finally(() => { state.running = false; state.finishedAt = Date.now();state.runs++;current = undefined })
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
