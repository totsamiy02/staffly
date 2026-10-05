import assert from 'node:assert/strict'
import { it } from 'node:test'
import { postAuthJson, accessTokenNeedsRefresh, requestWithSession } from '../src/app/auth/session-transport.ts'

it('serializes cookie rotations from two tabs instead of sending the same refresh cookie twice', async () => {
  const originalFetch = globalThis.fetch
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let tail = Promise.resolve()
  const names: string[] = []
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request(name: string, execute: () => Promise<Response>) { names.push(name); const result = tail.then(execute); tail = result.then(() => undefined); return result } } })
  let cookieVersion = 1
  const sent: number[] = []
  globalThis.fetch = async (_url, options) => {
    assert.equal(options?.credentials, 'same-origin')
    const presented = cookieVersion
    sent.push(presented)
    await new Promise(resolve => setTimeout(resolve, 10))
    if (presented !== cookieVersion) return new Response(null, { status: 401 })
    cookieVersion++
    return new Response('{}', { status: 200 })
  }
  try {
    const results = await Promise.all([postAuthJson('refresh', {}), postAuthJson('refresh', {})])
    assert.deepEqual(results.map(response => response.status), [200, 200])
    assert.deepEqual(sent, [1, 2])
    assert.deepEqual(names, ['staffly-auth-cookie', 'staffly-auth-cookie'])
  } finally {
    globalThis.fetch = originalFetch
    if (descriptor) Object.defineProperty(navigator, 'locks', descriptor); else Reflect.deleteProperty(navigator, 'locks')
  }
})

const jwt = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`

it('refreshes an expiring access token before the protected request', async () => {
  let token = jwt(Math.floor(Date.now() / 1000) - 1)
  const fresh = jwt(Math.floor(Date.now() / 1000) + 900)
  const sent: Array<string | null> = []
  let rotations = 0
  const response = await requestWithSession(async value => { sent.push(value); return new Response(null, { status: 200 }) }, () => token, async () => { rotations++; token = fresh; return { accessToken: fresh } })
  assert.equal(response.status, 200)
  assert.equal(rotations, 1)
  assert.deepEqual(sent, [fresh])
})

it('reuses the token already refreshed by a concurrent request on a late 401', async () => {
  const old = jwt(Math.floor(Date.now() / 1000) + 900), fresh = jwt(Math.floor(Date.now() / 1000) + 1000)
  let token = old, rotations = 0
  const sent: Array<string | null> = []
  const response = await requestWithSession(async value => { sent.push(value); token = fresh; return new Response(null, { status: value === old ? 401 : 200 }) }, () => token, async () => { rotations++; return null })
  assert.equal(response.status, 200)
  assert.equal(rotations, 0)
  assert.deepEqual(sent, [old, fresh])
})

it('does not send a protected request after proactive refresh rejects the session', async () => {
  let calls = 0
  await assert.rejects(requestWithSession(async () => { calls++; return new Response() }, () => jwt(1), async () => null), /Сессия завершена/)
  assert.equal(calls, 0)
  assert.equal(accessTokenNeedsRefresh('malformed'), false)
  assert.equal(accessTokenNeedsRefresh(null), false)
})
