import assert from 'node:assert/strict'
import { it } from 'node:test'
import { postAuthJson } from '../src/app/auth/session-transport.ts'

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
