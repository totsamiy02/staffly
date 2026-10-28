import { createHash, timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'
import { performanceSnapshot, recordSlow, recordTiming, runRequestTiming } from './performance.ts'
import { databasePool } from './db.ts'

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]
type Series = { count: number; sum: number; buckets: number[] }
export function createHttpMetrics() {
  const series = new Map<string, Series>()
  let active = 0
  const middleware: RequestHandler = (request, response, next) => {
    runRequestTiming(totals => {
      const started = performance.now()
      const json = response.json
      response.json = function (...args: Parameters<typeof json>) {
        const start = performance.now()
        try { return json.apply(this, args) } finally { recordTiming('json', performance.now() - start) }
      }
      active++
      let released = false
      const release = () => { if (!released) { released = true; active-- } }
      response.locals.releaseHttpMetrics = release
      response.once('close', release)
      response.once('finish', () => {
        release()
        if (request.path === '/api/live' || request.path.startsWith('/health/') || request.path === '/internal/metrics') return
        const path = typeof request.route?.path === 'string' ? request.route.path : 'unmatched'
        recordSlow(path, response.statusCode, performance.now() - started, totals)
        const label = `method=${JSON.stringify(request.method)},route=${JSON.stringify(path)},status=${JSON.stringify(String(response.statusCode))}`
        const key = series.has(label) || series.size < 200 ? label : 'method="OTHER",route="other",status="other"'
        let row = series.get(key)
        if (!row) { row = { count: 0, sum: 0, buckets: buckets.map(() => 0) }; series.set(key, row) }
        const seconds = (performance.now() - started) / 1000
        row.count++; row.sum += seconds
        buckets.forEach((bucket, index) => { if (seconds <= bucket) row.buckets[index]++ })
      })
      next()
    })
  }
  const handler = (liveConnections: () => number): RequestHandler => (request, response) => {
    const secret = process.env.METRICS_TOKEN
    const presented = request.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const digest = (value: string) => createHash('sha256').update(value).digest()
    if (!secret || secret.length < 32 || !timingSafeEqual(digest(secret), digest(presented))) { response.sendStatus(404); return }
    if (request.get('accept') === 'application/json') {
      response.set('Cache-Control', 'no-store').json({ ...performanceSnapshot(), pool: { total: databasePool.totalCount, idle: databasePool.idleCount, waiting: databasePool.waitingCount } }); return
    }
    const lines = ['# TYPE staffly_http_duration_seconds histogram']
    for (const [labels, row] of series) {
      buckets.forEach((bucket, index) => lines.push(`staffly_http_duration_seconds_bucket{${labels},le="${bucket}"} ${row.buckets[index]}`))
      lines.push(`staffly_http_duration_seconds_bucket{${labels},le="+Inf"} ${row.count}`, `staffly_http_duration_seconds_count{${labels}} ${row.count}`, `staffly_http_duration_seconds_sum{${labels}} ${row.sum}`)
    }
    lines.push(`staffly_http_inflight ${active}`, `staffly_live_connections ${liveConnections()}`, `staffly_process_rss_bytes ${process.memoryUsage().rss}`, `staffly_process_uptime_seconds ${process.uptime()}`)
    const snapshot = performanceSnapshot()
    for (const [stage, row] of Object.entries(snapshot.measurements)) {
      snapshot.bucketsMs.forEach((bucket, index) => lines.push(`staffly_stage_duration_seconds_bucket{stage="${stage}",le="${bucket / 1000}"} ${row.buckets[index]}`))
      lines.push(`staffly_stage_duration_seconds_bucket{stage="${stage}",le="+Inf"} ${row.count}`, `staffly_stage_duration_seconds_count{stage="${stage}"} ${row.count}`, `staffly_stage_duration_seconds_sum{stage="${stage}"} ${row.sumMs / 1000}`)
    }
    lines.push(`staffly_db_pool_total ${databasePool.totalCount}`, `staffly_db_pool_idle ${databasePool.idleCount}`, `staffly_db_pool_waiting ${databasePool.waitingCount}`)
    response.set({ 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' }).send(lines.join('\n') + '\n')
  }
  return { middleware, handler }
}
