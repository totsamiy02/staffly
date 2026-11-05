import assert from 'node:assert/strict'
import { it } from 'node:test'
import { spawn } from 'node:child_process'
import { request, createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { processFile } from '../../src/server/file-processing/client.ts'
import { parserArguments } from '../../src/server/file-processing/runner.ts'
import { validateDocumentFile } from '../../src/server/documents/file-validation.ts'

it('denies parser reads outside its allowlist, filesystem writes, subprocesses and workers; strips secrets', async () => {
  const script = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { Worker } from 'node:worker_threads';
    let denied = 0;
    for (const action of [() => readFileSync('/etc/passwd'), () => readFileSync('src/server/.env'), () => writeFileSync('/tmp/parser-escape', 'x'), () => spawnSync(process.execPath, ['-e','']), () => new Worker('process.exit()', {eval:true})]) {
      try { action(); } catch(e) { if(e.code === 'ERR_ACCESS_DENIED') denied++; else throw e; }
    }
    if (denied !== 5 || process.env.JWT_SECRET || process.env.DATABASE_URL) process.exit(2);
  `
  const child = spawn(process.execPath, parserArguments('-e', [script]), { env: { LANG: 'C' }, stdio: 'ignore' })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0)
})

it('re-encodes document images without appended content or metadata and preserves the declared format', async () => {
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).withMetadata({ exif: { IFD0: { Artist: 'private-metadata' } } }).png().toBuffer()
  const appended = Buffer.concat([image, Buffer.from('<script>untrusted-appendix</script>')])
  const file = await validateDocumentFile(appended, 'image/png', 'image.png')
  assert.equal((await sharp(file.contents).metadata()).format, 'png')
  assert.equal((await sharp(file.contents).metadata()).exif, undefined)
  assert.equal(file.contents.includes(Buffer.from('untrusted-appendix')), false)
  await assert.rejects(processFile('image', 'jpeg', image))
})

it('fails closed in production when no isolated processor is configured', async () => {
  const previous = process.env.NODE_ENV, socket = process.env.FILE_PROCESSOR_SOCKET
  process.env.NODE_ENV = 'production'; delete process.env.FILE_PROCESSOR_SOCKET
  try { await assert.rejects(processFile('avatar', 'auto', Buffer.from('x')), { code: 'FILE_PROCESSOR_UNAVAILABLE' }) }
  finally { process.env.NODE_ENV = previous; if (socket) process.env.FILE_PROCESSOR_SOCKET = socket }
})

it('processes files over a private Unix socket and rejects arbitrary operation names', { timeout: 10_000 }, async () => {
  // macOS Unix sockets have a short path limit; the test runner's nested TMPDIR
  // exceeds it. Production uses the fixed /run/file-processor socket path.
  const directory = await mkdtemp('/tmp/staffly-fp-'), socketPath = path.join(directory, 'processor.sock')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/server/file-processing/server.ts', import.meta.url))], { env: { FILE_PROCESSOR_SOCKET: socketPath }, stdio: ['ignore', 'ignore', 'pipe'] })
  let diagnostic = ''
  child.stderr.on('data', data => { diagnostic += data })
  const send = (route: string, bytes = Buffer.alloc(0), method = 'POST') => new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
    const req = request({ socketPath, path: route, method, signal: AbortSignal.timeout(3000) }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) })) })
    req.on('error', reject); req.end(bytes)
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 50; attempt++) {
      try { ready = (await send('/health', undefined, 'GET')).status === 200 } catch { /* Startup only. */ }
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(ready, diagnostic)
    assert.equal((await send('/execute/shell', Buffer.from('whoami'))).status, 404)
    const result = await send('/preview/csv', Buffer.from('name,value\nAnna,10'))
    assert.equal(result.status, 200); assert.equal(JSON.parse(result.bytes.toString()).sheets[0].cells['2:1'].text, 'Anna')
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer()
    const avatar = await send('/avatar/auto', image)
    assert.equal(avatar.status, 200); assert.equal((await sharp(avatar.bytes).metadata()).format, 'webp')
    const previousSocket = process.env.FILE_PROCESSOR_SOCKET
    process.env.FILE_PROCESSOR_SOCKET = socketPath
    try { assert.equal((await sharp(await processFile('avatar', 'auto', image)).metadata()).format, 'webp') }
    finally { if (previousSocket) process.env.FILE_PROCESSOR_SOCKET = previousSocket; else delete process.env.FILE_PROCESSOR_SOCKET }
    assert.equal((await send('/office/docx', Buffer.from('bad'))).status, 415)
    const compose = await readFile('deploy/compose.yaml', 'utf8')
    assert.match(compose, /file-processor:[\s\S]*?network_mode: none/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})

it('distinguishes processor outages and timeouts from corrupt uploads over the socket protocol', async () => {
  const directory = await mkdtemp('/tmp/staffly-fp-'), socket = path.join(directory, 'processor.sock')
  let status = 500
  const server = createServer((req, res) => { req.resume(); res.writeHead(status).end() })
  const previous = process.env.FILE_PROCESSOR_SOCKET
  server.listen(socket); await new Promise<void>(resolve => server.once('listening', resolve))
  process.env.FILE_PROCESSOR_SOCKET = socket
  try {
    for (const [httpStatus, code] of [[500, 'FILE_PROCESSOR_UNAVAILABLE'], [422, 'FILE_VALIDATION_TIMEOUT'], [413, 'FILE_PROCESSING_TOO_LARGE'], [415, 'INVALID_DOCUMENT_FILE'], [503, 'FILE_VALIDATION_BUSY']] as const) {
      status = httpStatus
      await assert.rejects(processFile('image', 'png', Buffer.from('fixture')), { code })
    }
  } finally {
    if (previous) process.env.FILE_PROCESSOR_SOCKET = previous; else delete process.env.FILE_PROCESSOR_SOCKET
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
