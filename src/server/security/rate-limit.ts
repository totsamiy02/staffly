import { createHmac } from 'node:crypto'
import { rateLimit, ipKeyGenerator, type Store, type Options } from 'express-rate-limit'
import type { Request } from 'express'
import { prisma } from '../db.ts'
import type { AuthenticatedRequest } from '../auth.ts'

type Hit = { totalHits: number; resetTime: Date }
// Shared atomic counters for all API replicas. A bounded local deny cache means
// repeatedly rejected traffic does not keep issuing database writes.
export class PostgresRateLimitStore implements Store {
  localKeys = false
  prefix: string
  private windowMs = 60000
  private denied = new Map<string, Hit>()
  private limit: number
  constructor(prefix: string, limit: number) { this.prefix = prefix; this.limit = limit }
  init(options: Options) { this.windowMs = options.windowMs }
  private digest(key: string) {
    const secret = process.env.JWT_SECRET
    if (!secret) throw new Error('JWT_SECRET is missing')
    return createHmac('sha256', secret).update(`${this.prefix}:${key}`).digest('hex')
  }
  blocked(key: string): Hit | undefined {
    const hit = this.denied.get(this.digest(key))
    return hit && +hit.resetTime > Date.now() ? hit : undefined
  }
  async increment(key: string): Promise<Hit> {
    const hash = this.digest(key), blocked = this.denied.get(hash)
    if (blocked && +blocked.resetTime > Date.now()) return blocked
    if (blocked) this.denied.delete(hash)
    const [row] = await prisma.$queryRaw<Array<{ hits: number; reset_ms: bigint }>>`
      INSERT INTO api_rate_limits (key, hits, reset_at)
      VALUES (${hash}, 1, clock_timestamp() + ${this.windowMs} * interval '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN api_rate_limits.reset_at <= clock_timestamp() THEN 1 ELSE LEAST(api_rate_limits.hits + 1, 2147483647) END,
        reset_at = CASE WHEN api_rate_limits.reset_at <= clock_timestamp() THEN clock_timestamp() + ${this.windowMs} * interval '1 millisecond' ELSE api_rate_limits.reset_at END
      RETURNING hits, (extract(epoch FROM reset_at) * 1000)::bigint AS reset_ms`
    const hit = { totalHits: row.hits, resetTime: new Date(Number(row.reset_ms)) }
    if (hit.totalHits > this.limit) {
      if (this.denied.size >= 10000) this.denied.delete(this.denied.keys().next().value!)
      this.denied.set(hash, hit)
    }
    return hit
  }
  async decrement(key: string) {
    this.denied.delete(this.digest(key))
    await prisma.$executeRaw`UPDATE api_rate_limits SET hits = GREATEST(0, hits - 1) WHERE key = ${this.digest(key)}`
  }
  async resetKey(key: string) {
    this.denied.delete(this.digest(key))
    await prisma.$executeRaw`DELETE FROM api_rate_limits WHERE key = ${this.digest(key)}`
  }
}
export const accountRateKey = (request: Request) => (request as AuthenticatedRequest).auth?.userId ?? ipKeyGenerator(request.ip ?? '127.0.0.1')
export function accountRateLimit(name: string, limit = 60, windowMs = 60000) {
  const store = new PostgresRateLimitStore(name, limit)
  const middleware = rateLimit({ windowMs, limit, keyGenerator: accountRateKey,
    store, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { code: 'TOO_MANY_REQUESTS', message: 'Слишком много действий. Повторите попытку немного позже.' },
  })
  return Object.assign(middleware, { blocked: (key: string) => store.blocked(key) })
}
