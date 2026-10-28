import { ipKeyGenerator } from 'express-rate-limit'
import type { RequestHandler } from 'express'
import { positiveInteger } from '../runtime.ts'

export class TokenBuckets {
  private entries = new Map<string, { tokens: number; time: number }>()
  private rate: number
  private burst: number
  private maximum: number
  private lastSweep = 0
  constructor(rate: number, burst: number, maximum = 20000) { this.rate = rate; this.burst = burst; this.maximum = maximum }
  take(key: string, now = Date.now()) {
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= this.maximum) {
        if (now - this.lastSweep >= 1000) {
          this.lastSweep = now
          for (const [id, old] of this.entries) if (now - old.time > 60000) this.entries.delete(id)
        }
        // Refuse to allocate unbounded memory under a distributed flood.
        if (this.entries.size >= this.maximum) return false
      }
      entry = { tokens: this.burst, time: now }; this.entries.set(key, entry)
    }
    entry.tokens = Math.min(this.burst, entry.tokens + Math.max(0, now - entry.time) * this.rate / 1000)
    entry.time = now
    if (entry.tokens < 1) return false
    entry.tokens--
    return true
  }
  get size() { return this.entries.size }
}

// Runs before JSON parsing and authentication: malformed/anonymous floods don't
// allocate body buffers or exhaust the database pool. External edge limits still matter.
export function admissionControl(): RequestHandler {
  const buckets = new TokenBuckets(positiveInteger('HTTP_IP_RATE', 100), positiveInteger('HTTP_IP_BURST', 500))
  const maximum = positiveInteger('HTTP_MAX_INFLIGHT', 256, 10000)
  const maximumUploads = positiveInteger('HTTP_MAX_UPLOADS', 2, 32)
  const maximumHeavy = positiveInteger('HTTP_MAX_HEAVY', 2, 32)
  let active = 0, uploads = 0, heavy = 0
  return (request, response, next) => {
    const health = request.path === '/health/live' || request.path === '/health/ready'
    const ip = ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? '127.0.0.1')
    if (!health && !buckets.take(ip)) {
      response.set('Retry-After', '2').status(429).json({ code: 'IP_RATE_LIMIT', message: 'Слишком много запросов. Повторите попытку немного позже.' }); return
    }
    if (!health && active >= maximum) {
      response.set('Retry-After', '2').status(503).json({ code: 'SERVER_BUSY', message: 'Сервис занят. Повторите попытку немного позже.' }); return
    }
    const upload = request.method === 'PUT' && /\/(?:avatar|logo|documents|attachments)$/.test(request.path)
    const expensive = /\/statistics\/reports\/(?:preview|members)$/.test(request.path)
      || request.method === 'POST' && /\/documents\/[0-9a-f-]+\/content$/.test(request.path) && request.query.action === 'preview'
    if (upload && uploads >= maximumUploads || expensive && heavy >= maximumHeavy) {
      response.set('Retry-After', '2').status(503).json({ code: 'OPERATION_BUSY', message: 'Сервис обработки файлов занят. Повторите попытку немного позже.' }); return
    }
    const encoding = request.get('content-encoding')
    if (encoding && encoding.toLowerCase() !== 'identity') {
      response.status(415).json({ code: 'UNSUPPORTED_ENCODING', message: 'Сжатые тела запросов не поддерживаются.' }); return
    }
    active++
    if (upload) uploads++
    if (expensive) heavy++
    let released = false
    const release = () => { if (!released) { released = true; active--; if (upload) uploads--; if (expensive) heavy-- } }
    response.once('finish', release); response.once('close', release)
    // A validated SSE stream has its own connection budget and no pending DB work.
    response.locals.releaseAdmission = release
    next()
  }
}
