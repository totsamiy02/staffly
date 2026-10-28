import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createArtifactDirectory, writeReport } from '../support/artifacts.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const binary = process.argv[2]
if (!binary || !path.isAbsolute(binary)) throw new Error('Usage: npm run test:edge -- /absolute/path/to/nginx')
await access(binary)
const output = await createArtifactDirectory('edge', process.argv.slice(3).find(arg => arg.startsWith('--output='))?.slice(9))
const directory = await mkdtemp(path.join(os.tmpdir(), 'staffly-edge-'))
const backends = [], sockets = new Set(), agent = new https.Agent({ keepAlive: true, maxSockets: 32 })
let nginx, log = '', forwarded = [], upstreamRequests = 0
const results = { checkedAt: new Date().toISOString(), nginxBinary: binary, checks: {} }
async function command(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const [code] = await once(child, 'exit'); assert.equal(code, 0, output); return output
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
try {
  await mkdir(path.join(directory, 'logs'))
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'])
  for (let index = 0; index < 4; index++) {
    const server = http.createServer((request, response) => {
      upstreamRequests++
      forwarded.push(request.headers['x-forwarded-for'])
      if (request.url.startsWith('/api/live')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('event: ready\ndata: {}\n\n'); return
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, backend: index }))
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); backends.push(server)
  }
  const port = await freePort(), configuration = path.join(directory, 'nginx.conf')
  let config = await readFile(path.join(root, 'deploy/nginx.conf'), 'utf8')
  config = config.replace('worker_processes auto;', 'worker_processes 2;')
    .replace('events {', `pid ${JSON.stringify(path.join(directory, 'nginx.pid'))};\nevents {`)
    .replace('/etc/nginx/mime.types', JSON.stringify(path.join(path.dirname(binary), '../conf/mime.types')))
    .replaceAll('/var/log/nginx/access.log', JSON.stringify(path.join(directory, 'access.log')))
    .replaceAll('/var/log/nginx/error.log', JSON.stringify(path.join(directory, 'error.log')))
    .replace('server api1:3001', `server 127.0.0.1:${backends[0].address().port}`)
    .replace('server api2:3001', `server 127.0.0.1:${backends[1].address().port}`)
    .replace('server api3:3001', `server 127.0.0.1:${backends[2].address().port}`)
    .replace('server api4:3001', `server 127.0.0.1:${backends[3].address().port}`)
    .replace('listen 443 ssl;', `listen 127.0.0.1:${port} ssl;`)
    .replace('/etc/nginx/tls/fullchain.pem', JSON.stringify(path.join(directory, 'cert.pem')))
    .replace('/etc/nginx/tls/privkey.pem', JSON.stringify(path.join(directory, 'key.pem')))
    .replace('root /srv/staffly;', `root ${JSON.stringify(path.join(root, 'dist'))};`)
    .replaceAll('/etc/nginx/staffly-proxy.conf', JSON.stringify(path.join(root, 'deploy/proxy.conf')))
    .replaceAll('/etc/nginx/staffly-cloudflare-realip.conf', JSON.stringify(path.join(root, 'deploy/cloudflare-realip.conf')))
  // Source-tree builds place mime.types in ../conf; installed builds can use NGINX_MIME_TYPES.
  if (process.env.NGINX_MIME_TYPES) config = config.replace(JSON.stringify(path.join(path.dirname(binary), '../conf/mime.types')), JSON.stringify(process.env.NGINX_MIME_TYPES))
  await writeFile(configuration, config)
  results.syntax = await command(binary, ['-p', directory + '/', '-c', configuration, '-t'])
  nginx = spawn(binary, ['-p', directory + '/', '-c', configuration, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] })
  nginx.stdout.on('data', chunk => { log += chunk }); nginx.stderr.on('data', chunk => { log += chunk })
  const request = (pathname, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const connection = https.request({ hostname: '127.0.0.1', port, path: pathname, method, headers, agent,
      rejectUnauthorized: false, timeout: 5000 }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    connection.on('error', reject); connection.on('timeout', () => connection.destroy(new Error('Edge request timed out'))); connection.end()
  })
  let ready = false
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await request('/api/probe')).status === 200) { ready = true; break } } catch { /* Wait for this local proxy. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(ready, log)
  const page = await request('/app')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval';/)
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.match(page.headers['content-security-policy'], /object-src 'none'/)
  assert.equal(page.headers['x-frame-options'], 'DENY')
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  const html = await readFile(path.join(root, 'dist/index.html'), 'utf8')
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)
  assert(asset, 'Build must contain a JS asset')
  const staticAsset = await request(asset[1])
  assert.equal(staticAsset.status, 200)
  assert.equal(staticAsset.headers['content-security-policy'], page.headers['content-security-policy'])
  results.checks.spaAndAssetsProtected = true
  await request('/api/probe', { 'X-Forwarded-For': '203.0.113.123', 'CF-Connecting-IP': '203.0.113.123', Forwarded: 'for=203.0.113.123' })
  assert.equal(forwarded.at(-1), '127.0.0.1'); results.checks.spoofedForwardingHeadersOverwritten = true
  const office = await Promise.all(Array.from({ length: 40 }, () => request('/api/probe')))
  assert(office.every(response => response.status === 200)); results.checks.officeBurst40 = '40/40 accepted'
  const before = upstreamRequests
  assert.equal((await request('/api/probe', { 'Content-Length': String(26 * 1024 * 1024) }, 'POST')).status, 413)
  assert.equal(upstreamRequests, before); results.checks.oversizedBodyRejectedBeforeApi = true
  assert.equal((await request('/health/live')).status, 404); results.checks.internalHealthNotPublic = true
  const streaming = await new Promise((resolve, reject) => {
    const start = performance.now()
    const req = https.get({ hostname: '127.0.0.1', port, path: '/api/live', rejectUnauthorized: false }, response => {
      response.once('data', chunk => { resolve({ status: response.statusCode, initialFrame: chunk.toString(), ms: performance.now() - start }); req.destroy() })
    })
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('SSE was buffered')))
  })
  assert.equal(streaming.status, 200); assert.match(streaming.initialFrame, /event: ready/)
  results.checks.sseNotBuffered = { firstFrameMs: +streaming.ms.toFixed(1) }
  await request('/api/auth/yandex/callback?code=never-log-this&state=secret')
  const flood = await Promise.all(Array.from({ length: 1000 }, () => request('/api/probe')))
  const statuses = Object.fromEntries([...new Set(flood.map(item => item.status))].map(status => [status, flood.filter(item => item.status === status).length]))
  assert(statuses[429] > 0); assert(!Object.keys(statuses).some(code => Number(code) >= 500)); results.checks.flood = statuses
  await new Promise(resolve => setTimeout(resolve, 100))
  const accessLog = await readFile(path.join(directory, 'access.log'), 'utf8')
  assert(!accessLog.includes('never-log-this') && !accessLog.includes('state=secret')); results.checks.oauthQueryNotLogged = true
  await writeReport(output, results)
  console.log(JSON.stringify(results, null, 2))
  console.log(`Results saved to ${path.relative(root, output)}/report.json`)
} catch (error) {
  results.failure = error.message
  await writeReport(output, results)
  if (log) await writeFile(path.join(output, 'edge.log'), log)
  throw error
} finally {
  agent.destroy(); sockets.forEach(socket => socket.destroy())
  if (nginx && nginx.exitCode === null && nginx.signalCode === null) {
    const done = once(nginx, 'exit'); nginx.kill('SIGTERM')
    const timer = setTimeout(() => nginx.kill('SIGKILL'), 5000)
    try { await done } finally { clearTimeout(timer) }
  }
  await Promise.all(backends.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })))
  await rm(directory, { recursive: true, force: true })
}
