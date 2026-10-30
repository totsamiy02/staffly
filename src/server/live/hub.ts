import { Client } from 'pg'
import type { RequestHandler, Response } from 'express'
import { databaseUrl, prisma } from '../db.ts'
import type { AuthenticatedRequest } from '../auth.ts'
import { positiveInteger } from '../runtime.ts'
import { readCache, setReadCacheLive } from '../read-cache.ts'
import { checkDatabasePolicy } from '../database-policy.ts'
import { utcDatabaseUrl, checkTimeModel } from '../database-time.ts'

export type LiveHint = { topic: string; organizationId?: string; userId?: string }
type Peer = { response: Response; userId: string; sessionId: string; organizations: Set<string>; expires: number; dirty: Map<string, LiveHint> }
const topics = new Set(['schedule', 'requests', 'requests-mine', 'requests-review', 'documents', 'events', 'organization', 'access', 'notifications', 'profile', 'exports'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function parseHint(payload: string): LiveHint | null {
  try {
    const item = JSON.parse(payload)
    if (!topics.has(item.topic) || ![item.userId, item.organizationId].some(id => typeof id === 'string' && uuid.test(id))) return null
    return { topic: item.topic, ...(typeof item.userId === 'string' && uuid.test(item.userId) ? { userId: item.userId } : {}),
      ...(typeof item.organizationId === 'string' && uuid.test(item.organizationId) ? { organizationId: item.organizationId } : {}) }
  } catch { return null }
}

export function createLiveHub(options: { validationIntervalMs?: number } = {}) {
  const peers = new Set<Peer>(), perUser = new Map<string, number>()
  const maximum = positiveInteger('LIVE_MAX_CONNECTIONS', 10000, 100000)
  let listener: Client | undefined, retry: ReturnType<typeof setTimeout> | undefined, stopped = false, connected = false, checking = false
  const write = (peer: Peer, event: string, data: unknown) => {
    if (peer.response.destroyed || peer.response.writableLength > 65536) { peer.response.destroy(); return }
    peer.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const disconnectAll = () => { for (const peer of peers) peer.response.end() }
  async function listen() {
    if (stopped) return
    const client = new Client({ connectionString: utcDatabaseUrl(process.env.LIVE_DATABASE_URL || databaseUrl), application_name: 'staffly-live', connectionTimeoutMillis: 3000, keepAlive: true })
    listener = client
    let failed = false
    const fail = () => {
      if (failed) return
      failed = true; connected = false; setReadCacheLive(false)
      if (!stopped) console.warn('Live database listener unavailable; retrying.')
      disconnectAll() // Reconnection causes clients to resync; NOTIFY is not a durable event log.
      void client.end().catch(() => undefined)
      if (!stopped) retry = setTimeout(() => { void listen() }, 1000 + Math.random() * 2000)
    }
    client.on('error', fail); client.on('end', fail)
    client.on('notification', notification => {
      const hint = parseHint(notification.payload ?? '')
      if (!hint) return
      readCache.invalidateForHint(hint)
      for (const peer of peers) {
        if (hint.userId ? hint.userId !== peer.userId : !hint.organizationId || !peer.organizations.has(hint.organizationId)) continue
        // A role/membership/session change forces a fresh authorization and resync.
        if (hint.topic === 'access') { write(peer, 'reset', {}); peer.response.end(); continue }
        // Only identifiers and a topic are sent, never business data or credentials.
        peer.dirty.set(`${hint.topic}:${hint.organizationId ?? ''}`, hint)
      }
    })
    try {
      await client.connect()
      await checkTimeModel(client)
      if (process.env.NODE_ENV === 'production') await checkDatabasePolicy(client)
      await client.query('LISTEN staffly_live')
      if (!failed && !stopped) { connected = true; setReadCacheLive(true) }
    }
    catch { fail() }
  }
  void listen()
  const flush = setInterval(() => {
    for (const peer of peers) if (peer.dirty.size) {
      write(peer, 'change', [...peer.dirty.values()].map(({ topic, organizationId }) => ({ topic, organizationId })))
      peer.dirty.clear()
    }
  }, 250)
  flush.unref()
  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (peer.expires <= Date.now()) peer.response.end()
      else write(peer, 'ping', {})
    }
  }, 15000)
  heartbeat.unref()
  // One batched session validation per process, rather than one DB query per stream.
  const validation = setInterval(async () => {
    if (checking || !peers.size || stopped) return
    checking = true
    try {
      const ids = [...new Set([...peers].map(peer => peer.sessionId))], now = new Date()
      const valid = new Set<string>()
      for (let offset = 0; offset < ids.length; offset += 500) {
        const sessions = await prisma.authSession.findMany({ where: { id: { in: ids.slice(offset, offset + 500) }, revokedAt: null,
          idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, user: { deletedAt: null, emailVerifiedAt: { not: null } } }, select: { id: true } })
        sessions.forEach(session => valid.add(session.id))
      }
      for (const peer of peers) if (!valid.has(peer.sessionId)) peer.response.end()
      // Visible streams replace thousands of per-tab HTTP presence heartbeats.
      // Update only freshly validated sessions, in bounded batches.
      const active = [...peers].filter(peer => valid.has(peer.sessionId))
      const sessionIds = [...new Set(active.map(peer => peer.sessionId))]
      const userIds = [...new Set(active.map(peer => peer.userId))]
      for (let offset = 0; offset < sessionIds.length; offset += 500) await prisma.authSession.updateMany({
        where: { id: { in: sessionIds.slice(offset, offset + 500) }, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } }, data: { lastActiveAt: now, lastUsedAt: now } })
      for (let offset = 0; offset < userIds.length; offset += 500) await prisma.user.updateMany({ where: { id: { in: userIds.slice(offset, offset + 500) }, deletedAt: null }, data: { lastSeenAt: now } })
    } catch { disconnectAll() }
    finally { checking = false }
  }, options.validationIntervalMs ?? 30000)
  validation.unref()
  const handler: RequestHandler = async (request, response) => {
    const auth = (request as AuthenticatedRequest).auth!
    const organizationId = typeof request.query.organizationId === 'string' ? request.query.organizationId : undefined
    if (organizationId && !uuid.test(organizationId)) { response.status(400).json({ code: 'VALIDATION_ERROR' }); return }
    if (!connected || peers.size >= maximum || (perUser.get(auth.userId) ?? 0) >= 4) {
      response.set('Retry-After', '5').status(503).json({ code: 'LIVE_BUSY', message: 'Обновления временно недоступны.' }); return
    }
    const memberships = await prisma.organizationMember.findMany({ where: { userId: auth.userId, leftAt: null, organization: { deletedAt: null } }, select: { organizationId: true } })
    const organizations = new Set(memberships.map(member => member.organizationId))
    if (organizationId && !organizations.has(organizationId)) {
      response.status(404).json({ code: 'ORGANIZATION_NOT_FOUND' }); return
    }
    if (request.destroyed) return
    if (!connected || peers.size >= maximum || (perUser.get(auth.userId) ?? 0) >= 4) {
      response.set('Retry-After', '5').status(503).json({ code: 'LIVE_BUSY' }); return
    }
    response.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    response.locals.releaseAdmission?.()
    response.locals.releaseHttpMetrics?.()
    // Avoid synchronized full-query resyncs at a common JWT expiry after mass login.
    const peer: Peer = { response, ...auth, organizations, expires: Math.min((auth.accessExpiresAt ?? Infinity) - 30000 - Math.random() * 120000, Date.now() + 8 * 60000 + Math.random() * 4 * 60000), dirty: new Map() }
    peers.add(peer); perUser.set(auth.userId, (perUser.get(auth.userId) ?? 0) + 1)
    write(peer, 'ready', {})
    response.once('close', () => {
      peers.delete(peer)
      const count = (perUser.get(auth.userId) ?? 1) - 1
      if (count) perUser.set(auth.userId, count); else perUser.delete(auth.userId)
    })
  }
  return { handler, connected: () => connected, size: () => peers.size, stop: async () => {
    stopped = true; connected = false; setReadCacheLive(false)
    clearInterval(flush); clearInterval(heartbeat); clearInterval(validation); clearTimeout(retry)
    disconnectAll(); await listener?.end().catch(() => undefined)
    while (checking) await new Promise(resolve => setTimeout(resolve, 10))
  } }
}
