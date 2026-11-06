import assert from 'node:assert/strict'
import { it } from 'node:test'
import { authGet, authPost, readJson } from '../../src/app/auth/session-transport.ts'
import { connectionError, guardRequest, requestErrorDetails, requestSignal, type RequestFailure } from '../../src/app/auth/request-errors.ts'
import { safeApiError } from '../../src/server/security/safe-error.ts'

const errorId = 'feae8fd0-a215-487c-a5f4-37a9780c1a7a'

it('keeps a searchable support reference but hides unknown server internals and proxy HTML', async () => {
  for (const response of [Response.json({ errorId, code: 'INTERNAL_ERROR', message: 'Prisma query failed: private@example.test password=private-value' }, { status: 500 }), new Response('<html>nginx: upstream failed</html>', { status: 502 })]) {
    await assert.rejects(readJson(response), (error: RequestFailure) => {
      assert.match(error.message, /Сервис временно недоступен/)
      assert.doesNotMatch(error.message, /Prisma|private|nginx|<html>/)
      if (error.status === 500) assert.deepEqual(requestErrorDetails(error), { message: 'Сервис временно недоступен. Попробуйте немного позже.', errorId })
      return true
    })
  }
  await assert.rejects(readJson(Response.json({ code: 'DATABASE_BUSY', message: 'untrusted' }, { status: 503, headers: { 'Retry-After': '2' } })), (error: RequestFailure) => error.retryAfterMs === 2000 && error.message === 'Сервис занят. Повторите попытку немного позже.')
})

it('rejects broken successful responses instead of navigating away or treating them as a save', async () => {
  for (const body of ['', '<html>fallback app</html>', '{"partial":', 'null', 'true', '"text"']) {
    await assert.rejects(readJson(new Response(body)), (error: RequestFailure) => error.code === 'INVALID_RESPONSE' && !error.message.includes(body || 'unexpected'))
  }
  assert.deepEqual(await readJson(Response.json({ items: [] })), { items: [] })
  assert.deepEqual(await readJson(Response.json([])), [])
  assert.equal(await readJson(new Response(null, { status: 204 })), undefined)
})

it('retains public validation errors and retry hints without accepting arbitrary support identifiers', async () => {
  await assert.rejects(readJson(Response.json({ code: 'VALIDATION_ERROR', message: 'Укажите название.', errors: { title: 'Укажите название.' }, errorId: 'private@example.test' }, { status: 400 })), (error: RequestFailure) => {
    assert.equal(error.message, 'Укажите название.'); assert.equal(error.errorId, undefined)
    assert.deepEqual(error.errors, { title: 'Укажите название.' }); return true
  })
  await assert.rejects(readJson(Response.json({ message: { stack: 'internal' } }, { status: 429, headers: { 'Retry-After': '9999' } })), (error: RequestFailure) => error.retryAfterMs === 30000 && error.message.includes('Подождите'))
  assert.deepEqual(requestErrorDetails('Ошибка. Код для поддержки: ' + errorId), { message: 'Ошибка.', errorId })
  assert.equal(requestErrorDetails('Ошибка. Код для поддержки: ' + '-'.repeat(36)).errorId, undefined)
})

it('normalizes auth failures in each browser and never replays login, registration or reset writes', async () => {
  const original = globalThis.fetch
  try {
    for (const failure of [new TypeError('Failed to fetch'), new TypeError('Load failed'), new DOMException('NetworkError when attempting to fetch resource.', 'NetworkError'), new DOMException('operation timed out', 'TimeoutError')]) {
      for (const path of ['login', 'register', 'verify-email', 'forgot-password', 'reset-password', 'resend-verification', 'logout', 'yandex/start']) {
        let calls = 0
        globalThis.fetch = async (_url, options) => { calls++; assert.ok(options?.signal); throw failure }
        await assert.rejects(authPost(path, {}), (error: RequestFailure) => {
          assert.equal(error.status, 0); assert.match(error.message, /подтверждение/); assert.doesNotMatch(error.message, /Failed to fetch|Load failed|NetworkError|timed out/); return true
        })
        assert.equal(calls, 1, 'A lost response must not replay a write')
      }
    }
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    await assert.rejects(authGet('yandex/status'), (error: RequestFailure) => error.code === 'NETWORK_ERROR' && error.message.includes('соединение'))
    globalThis.fetch = async () => Response.json({ enabled: false })
    assert.deepEqual(await authGet('yandex/status'), { enabled: false })
  } finally { globalThis.fetch = original }
})

it('handles a connection lost while reading a response body, including files and auth', async () => {
  const brokenBody = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated: private-url')) } }))
  for (const read of [(response: Response) => response.blob(), (response: Response) => readJson(response)]) {
    await assert.rejects(guardRequest(() => read(brokenBody())), (error: RequestFailure) => error.code === 'NETWORK_ERROR' && !error.message.includes('private-url'))
  }
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => brokenBody()
    await assert.rejects(authPost('register', {}), (error: RequestFailure) => error.code === 'NETWORK_ERROR' && error.message.includes('подтверждение'))
  } finally { globalThis.fetch = original }
})

it('distinguishes intentional cancellation from a deadline and preserves server metadata', async () => {
  const controller = new AbortController(), cancelled = new DOMException('cancelled preview', 'AbortError')
  controller.abort()
  await assert.rejects(guardRequest(async () => { throw cancelled }, { signal: controller.signal }), error => error === cancelled)
  const combined = requestSignal(controller.signal, 5000)
  assert.equal(combined.aborted, true)
  const timeout = connectionError(new DOMException('deadline', 'TimeoutError'))
  assert.equal(timeout.code, 'REQUEST_TIMEOUT'); assert.match(timeout.message, /вовремя/)
  const server = Object.assign(new Error('Закрытый документ.'), { status: 403, errorId })
  await assert.rejects(guardRequest(async () => { throw server }), error => error === server)
})

it('logs a timestamp and declared route without request values, credentials, SQL or stack traces', () => {
  const request = { method: 'POST', route: { path: '/organizations/:organizationId/documents/:documentId/content' }, originalUrl: '/api/private@example.test?token=private-token', body: { password: 'private-password' }, headers: { authorization: 'private-bearer' } }
  const error = Object.assign(new Error('SELECT private-email, private-password FROM secret'), { name: 'PrismaClientKnownRequestError', code: 'P2022', cause: new Error('private-cause') })
  const log = safeApiError(error, request, errorId)
  assert.equal(log.errorId, errorId); assert.equal(log.route, request.route.path); assert.equal(log.code, 'P2022'); assert.equal(log.method, 'POST')
  assert.ok(Number.isFinite(Date.parse(log.at)))
  assert.doesNotMatch(JSON.stringify(log), /private-|SELECT|stack|originalUrl|headers|body/)
  assert.equal(safeApiError(error, { method: 'POST' }, errorId).route, 'unmatched')
})
