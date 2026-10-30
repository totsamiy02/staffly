import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { createServer as createViteServer } from 'vite'
import { devApiProxy } from '../../scripts/dev-api-proxy.ts'

it('returns a quiet retryable error during a restart and never queues or replays writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'staffly-proxy-'))
  let writes = 0
  const api = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    if (request.method === 'POST') writes++
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ method: request.method, url: request.url, body }))
  })
  api.listen(0, '127.0.0.1'); await once(api, 'listening')
  const apiPort = (api.address() as { port: number }).port
  const errors: string[] = []
  await writeFile(path.join(directory, 'index.html'), '<main>Local proxy fixture</main>')
  const vite = await createViteServer({ configFile: false, root: directory, logLevel: 'silent', plugins: [devApiProxy(apiPort)], server: { host: '127.0.0.1', port: 0 }, customLogger: { hasWarned: false, info() {}, warn() {}, warnOnce() {}, error(message) { errors.push(message) }, clearScreen() {}, hasErrorLogged: () => false } })
  try {
    await vite.listen()
    const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`
    const first = await fetch(base + '/api/probe?q=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":1}' })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { method: 'POST', url: '/api/probe?q=1', body: '{"value":1}' })
    await new Promise<void>(resolve => { api.close(() => resolve()); api.closeAllConnections() })
    const unavailable = await fetch(base + '/api/probe', { method: 'POST', body: 'must never be replayed' })
    assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.get('retry-after'), '1')
    assert.equal((await unavailable.json()).code, 'API_UNAVAILABLE')
    api.listen(apiPort, '127.0.0.1'); await once(api, 'listening')
    assert.equal((await fetch(base + '/api/probe')).status, 200)
    assert.equal(writes, 1); assert.deepEqual(errors, [])
  } finally {
    api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()))
    await vite.close(); await rm(directory, { recursive: true, force: true })
  }
})
