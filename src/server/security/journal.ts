import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'express'
import { prisma } from '../db.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import type { SecurityAction } from '../../app/security/events.ts'

const context = new AsyncLocalStorage<{ correlationId: string; sessionId?: string }>()
export const securityContext: RequestHandler = (_req, _res, next) => {
  if (context.getStore()) next()
  else context.run({ correlationId: randomUUID() }, next)
}
export function bindSecuritySession(sessionId: string) { const value = context.getStore(); if (value) value.sessionId = sessionId }
export function securityCorrelationId() { return context.getStore()?.correlationId }
type Event = { action: SecurityAction; userId?: string | null; organizationId?: string | null; sessionId?: string; resourceType?: 'SESSION' | 'ACCOUNT' | 'ORGANIZATION' | 'LOCATION' | 'MEMBER' | 'DOCUMENT' | 'ATTACHMENT' | 'EXPORT' | 'ACCESS' | 'JOURNAL'; resourceId?: string; outcome?: 'SUCCEEDED' | 'DENIED' | 'FAILED'; reasonCode?: 'ACCOUNT_RATE_LIMIT' | 'ACCOUNT_DELETING' | 'PASSWORD_UNAVAILABLE' | 'EMAIL_UNVERIFIED' | 'INVALID_CREDENTIALS' | 'TOKEN_REUSE' | 'INVALID_CONFIRMATION' | 'ACCESS_DENIED' | 'RESOURCE_UNAVAILABLE' | 'OPERATION_FAILED'; count?: number }
export async function recordSecurityEvent(db: Prisma.TransactionClient = prisma, event: Event) {
  const request = context.getStore(), now = new Date()
  // Deliberate field allowlist: never persist request bodies/headers, filenames,
  // email addresses, passwords, verification codes, tokens, or arbitrary JSON.
  await db.securityEvent.create({ data: { createdAt: now, expiresAt: new Date(+now + 180 * 86400_000), action: event.action, outcome: event.outcome ?? 'SUCCEEDED', userId: event.userId,
    organizationId: event.organizationId, sessionId: event.sessionId ?? request?.sessionId, correlationId: request?.correlationId ?? randomUUID(),
    resourceType: event.resourceType, resourceId: event.resourceId, reasonCode: event.reasonCode,
    count: Number.isSafeInteger(event.count) && event.count! >= 0 && event.count! <= 1_000_000 ? event.count : undefined } })
}

export async function auditSensitiveAccess<T>(event: Event, work: () => Promise<T>): Promise<T> {
  let result: T
  try { result = await work() }
  catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
    await recordSecurityEvent(prisma, { ...event, outcome: status < 500 ? 'DENIED' : 'FAILED', reasonCode: status === 403 || status === 401 ? 'ACCESS_DENIED' : status === 404 ? 'RESOURCE_UNAVAILABLE' : 'OPERATION_FAILED' })
    throw error
  }
  try { await recordSecurityEvent(prisma, event) }
  catch (error) {
    if (result && typeof result === 'object' && 'stream' in result && result.stream && typeof result.stream === 'object' && 'destroy' in result.stream && typeof result.stream.destroy === 'function') result.stream.destroy()
    throw error
  }
  return result
}
