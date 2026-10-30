import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { it } from 'node:test'
import { waitForApi } from '../../scripts/wait-for-api.ts'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

async function endpoint(server: Server) {
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}/api/database-status`
}
async function close(server: Server) {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
}

it('waits for a connected database instead of proceeding on an early HTTP response', async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(requests === 1 ? 503 : 200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ connected: requests > 1 }))
  })
  try { await waitForApi({ url: await endpoint(server), timeoutMs: 2000, intervalMs: 10 }); assert.equal(requests, 2) }
  finally { await close(server) }
})

it('reports an unavailable database instead of starting the frontend', async () => {
  const server = createServer((_request, response) => { response.writeHead(503); response.end('{"connected":false}') })
  try { await assert.rejects(waitForApi({ url: await endpoint(server), timeoutMs: 150, intervalMs: 10 }), /Postgres\.app/) }
  finally { await close(server) }
})

it('bounds a hung readiness request and rejects unrelated HTML on the API port', async () => {
  for (const hung of [true, false]) {
    const server = createServer((_request, response) => { if (!hung) response.end('<html>Another server</html>') })
    try { await assert.rejects(waitForApi({ url: await endpoint(server), timeoutMs: 100, intervalMs: 10 }), /API не готов/) }
    finally { await close(server) }
  }
})

it('keeps the API available on generated Prisma changes and still reloads server code', { timeout: 20_000 }, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const { scripts } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  // Run the actual npm command against a disposable module graph, with no DB or mail worker.
  const fixture = await mkdtemp(join(tmpdir(), 'staffly watch '))
  let child: ReturnType<typeof spawn> | undefined
  let exited = false, log = ''
  const starts: Array<{ pid: number; port: number; service: string }> = []
  try {
    await mkdir(join(fixture, 'src/server'), { recursive: true })
    await mkdir(join(fixture, 'scripts'), { recursive: true })
    await copyFile(join(root, 'scripts/dev-server.mjs'), join(fixture, 'scripts/dev-server.mjs'))
    await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir')
    await mkdir(join(fixture, 'src/generated/prisma'), { recursive: true })
    await writeFile(join(fixture, 'package.json'), '{"type":"module"}')
    await writeFile(join(fixture, 'src/server/.env'), 'PORT=0\n')
    await writeFile(join(fixture, 'src/generated/prisma/enums.ts'), "export const marker = 'before'\n")
    await writeFile(join(fixture, 'src/generated/prisma/client.ts'), "import { marker } from './enums.ts'; export const client = marker\n")
    await writeFile(join(fixture, 'src/server/service.ts'), "export const service = 'before'\n")
    await writeFile(join(fixture, 'src/server/index.ts'), `
      import { createServer } from 'node:http'
      import { client } from '../generated/prisma/client.ts'
      import { service } from './service.ts'
      const server = createServer((_request, response) => response.end(JSON.stringify({ pid: process.pid, service, client })))
      server.listen(0, '127.0.0.1', () => console.log('READY ' + JSON.stringify({ pid: process.pid, port: server.address().port, service })))
      process.once('SIGTERM', () => server.close())
      process.once('SIGINT', () => server.close())
    `)
    child = spawn(scripts['dev:server'], { shell: true, cwd: fixture, detached: true, env: { ...process.env, PATH: join(root, 'node_modules/.bin') + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.once('exit', () => { exited = true })
    let output = ''
    child.stdout!.on('data', chunk => {
      const text = chunk.toString(); log += text; output += text
      const lines = output.split('\n'); output = lines.pop()!
      for (const line of lines) if (line.startsWith('READY ')) starts.push(JSON.parse(line.slice(6)))
    })
    child.stderr!.on('data', chunk => { log += chunk.toString() })
    const waitForStart = async (count: number) => {
      const deadline = Date.now() + 7000
      while (!exited && starts.length < count && Date.now() < deadline) await delay(25)
      assert.ok(starts.length >= count, `Watcher did not become ready: ${log}`)
      return starts.at(-1)!
    }
    const first = await waitForStart(1)
    for (const [name, content] of [
      ['client.ts', "import { marker } from './enums.ts'; export const client = 'updated-' + marker\n"],
      ['enums.ts', "export const marker = 'after'\n"],
    ]) {
      await writeFile(join(fixture, 'src/generated/prisma', name), content)
      for (let i = 0; i < 12; i++) {
        await delay(100)
        assert.equal(starts.length, 1, `Generated ${name} restarted the API: ${log}`)
        const response = await fetch(`http://127.0.0.1:${first.port}`, { signal: AbortSignal.timeout(1000) })
        assert.equal((await response.json()).pid, first.pid)
      }
    }
    for (let i = 0; i < 5; i++) {
      await writeFile(join(fixture, 'src/server/service.ts'), "export const service = 'after'\n")
      await delay(40)
    }
    const next = await waitForStart(2)
    await delay(1000)
    assert.equal(starts.length, 2, `One burst must produce one restart: ${log}`)
    assert.notEqual(next.pid, first.pid)
    const response = await fetch(`http://127.0.0.1:${next.port}`, { signal: AbortSignal.timeout(1000) })
    assert.equal((await response.json()).service, 'after')
  } finally {
    if (child?.pid) {
      const signal = (value: NodeJS.Signals) => { try { process.kill(-child!.pid!, value) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
      signal('SIGTERM')
      const deadline = Date.now() + 3000
      while (!exited && Date.now() < deadline) await delay(25)
      if (!exited) signal('SIGKILL')
    }
    await rm(fixture, { recursive: true, force: true })
  }
})
