import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { createServer, request as proxyRequest } from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { hash } from 'argon2'

// Uses an isolated Chrome profile and the runner's disposable PostgreSQL/API.
// No personal browser profile, credentials, production data or external services.
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map(), listeners = new Map()
  let nextId = 0
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id); clearTimeout(call.timer)
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result)
    } else for (const listener of listeners.get(message.method) ?? []) listener(message.params)
  })
  await once(socket, 'open')
  return {
    on(name, listener) { listeners.set(name, [...listeners.get(name) ?? [], listener]) },
    call(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 30000)
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { socket.close() },
  }
}

async function inventory(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, '.vite/manifest.json'), 'utf8'))
  const entry = manifest['index.html'], seen = new Set()
  function visit(key) { if (seen.has(key)) return; seen.add(key); for (const child of manifest[key]?.imports ?? []) visit(child) }
  visit('index.html')
  const files = [...seen].flatMap(key => [manifest[key].file, ...manifest[key].css ?? []])
  const initial = await Promise.all([...new Set(files)].map(async file => { const bytes = await readFile(path.join(directory, file)); return { file, bytes: bytes.length, gzipBytes: gzipSync(bytes).length } }))
  const chunks = await Promise.all(Object.values(manifest).filter(v => v.file.endsWith('.js')).map(async v => ({ file: v.file, bytes: (await readFile(path.join(directory, v.file))).length })))
  return { entry: entry.file, initial, initialGzipBytes: initial.reduce((sum, f) => sum + f.gzipBytes, 0), largestChunks: chunks.sort((a, b) => b.bytes - a.bytes).slice(0, 8) }
}

export async function runFrontend({ prisma, env, root, temporary, output, options, startApi }) {
  const requestTab = options['request-tab'] ?? 'mine'
  assert(['mine', 'incoming'].includes(requestTab), '--request-tab must be mine or incoming')
  const { createOrganization } = await import('../../src/server/organizations/organization-service.ts')
  const ui = options.ui === 'true'
  const passwordHash = await hash(randomUUID())
  const owner = await prisma.user.create({ data: { email: ui ? 'anna@example.test' : `frontend-${randomUUID()}@example.test`, passwordHash, emailVerifiedAt: new Date(), firstName: ui ? 'Анна' : 'Performance', lastName: ui ? 'Смирнова' : 'Test' } })
  const org = await createOrganization(owner.id, { name: ui ? 'Команда Север' : 'Frontend test organization', description: null, timezone: 'Europe/Moscow', ...(ui ? { firstLocation: {name:'Центральная',city:'Москва',address:'Садовая, 12',timezone:'Europe/Moscow'}, locations: Array.from({length:7},(_,i)=>({name:`Точка ${i+2}`,city:'Москва',address:`Примерная, ${i+2}`,timezone:'Europe/Moscow'})) } : {}) })
  const ownerMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } })
  const users = Array.from({ length: 39 }, (_, i) => ({ id: randomUUID(), email: `frontend-${i}-${randomUUID()}@example.test`, passwordHash, emailVerifiedAt: new Date(), firstName: `Employee ${i}` }))
  await prisma.user.createMany({ data: users })
  const members = users.map(u => ({ id: randomUUID(), userId: u.id, organizationId: org.id }))
  await prisma.organizationMember.createMany({ data: members })
  await prisma.locationMember.createMany({ data: members.map(m => ({ organizationId: org.id, memberId: m.id, locationId: org.locationId })) })
  const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.id, systemCode: 'OTHER' } })
  await prisma.organizationRequest.createMany({ data: members.map(m => ({ organizationId: org.id, locationId: org.locationId, createdByMemberId: m.id, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'OTHER', comment: 'Performance fixture' })) })
  const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(7, 0, 0, 0)
  await prisma.workShift.createMany({ data: members.map(m => ({ organizationId: org.id, locationId: org.locationId, memberId: m.id, createdByMemberId: ownerMember.id, scheduledStartAt: tomorrow, scheduledEndAt: new Date(+tomorrow + 8 * 3600000) })) })
  let directory, apiUrl, offline = false, holdProfile = false, heldProfile, organizationDelay = 0
  const controls = {
    offline(value) { offline = value },
    holdProfile() { holdProfile = true; heldProfile = undefined },
    get profileHeld() { return !!heldProfile },
    releaseProfile() { heldProfile?.(); heldProfile = undefined },
    async restart() { apiUrl = await startApi() },
    delayOrganizations(value) { organizationDelay = value },
  }
  const cache = new Map()
  const server = createServer(async (request, response) => {
    if (request.url.startsWith('/api/')) {
      const unavailable = () => { if(response.headersSent || response.destroyed) { response.destroy();return };response.writeHead(503,{'Content-Type':'application/json','Retry-After':'1'});response.end(JSON.stringify({code:'API_UNAVAILABLE',message:'Test API restarting'})) }
      if(offline){unavailable();return}
      const defer = holdProfile && request.method === 'GET' && request.url.split('?')[0] === '/api/profile'
      const waitOrganization = organizationDelay && request.method === 'GET' && /^\/api\/organizations\/[0-9a-f-]{36}$/.test(request.url.split('?')[0]) ? organizationDelay : 0
      if(defer)holdProfile=false
      const upstream = proxyRequest(apiUrl + request.url, { method: request.method, headers: request.headers }, result => {
        if(defer||waitOrganization){const chunks=[];result.on('data',chunk=>chunks.push(chunk));result.on('end',()=>{const release=()=>{if(!response.destroyed){response.writeHead(result.statusCode,result.headers);response.end(Buffer.concat(chunks))}};if(defer)heldProfile=release;else setTimeout(release,waitOrganization)});return}
        response.writeHead(result.statusCode, result.headers); result.pipe(response)
      })
      upstream.on('error', unavailable); response.on('close', () => upstream.destroy()); request.pipe(upstream); return
    }
    try {
      const pathname = new URL(request.url, 'http://test').pathname
      const file = path.extname(pathname) ? pathname.slice(1) : 'index.html'
      assert(!file.includes('..'))
      const key = directory + '/' + file
      if (!cache.has(key)) cache.set(key, gzipSync(await readFile(key)))
      const mime = file.endsWith('.css') ? 'text/css' : /\.(js|mjs)$/.test(file) ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.webp') ? 'image/webp' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': mime, 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' }); response.end(cache.get(key))
    } catch { response.statusCode = 404; response.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  env.APP_ORIGIN = origin; apiUrl = await startApi()
  const profile = path.join(temporary, 'chrome')
  const chrome = spawn(options.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
  let port
  try {
    for (let i = 0; i < 100; i++) { try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { await delay(100) } }
    assert(port, 'Headless Chrome did not start')
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const result = { browser: browser.Browser, requestTab, repetitions: Number(options['frontend-runs'] ?? 3), methodology: 'Cold browser cache, gzip HTTP, 6x CPU slowdown, 1.6 Mbps down / 768 kbps up / 150ms latency, 390x844 viewport. Real local API with 40 synthetic members, 39 requests and shifts. Content-ready means a visible heading/main without route loaders, plus 400ms without an outstanding API response header. FCP/LCP use PerformanceObserver. Desktop Chrome emulation, not a physical low-end device or production network.', builds: {} }
    const routes = [['auth', '/auth', false], ['organizations', '/app', true], ['requests', `/app/organizations/${org.id}/requests?tab=${requestTab}`, true], ['schedule', `/app/organizations/${org.id}/schedule`, true], ['employees', `/app/organizations/${org.id}/employees`, true]]
    for (const [label, build] of [['baseline', options.baseline ?? 'artifacts/frontend/baseline'], ['optimized', 'dist']]) {
      directory = path.resolve(root, build)
      const samples = []
      for (const [name, route, authenticated] of routes.filter(r => !options['frontend-routes'] || options['frontend-routes'].split(',').includes(r[0]))) for (let run = 0; run < Number(options['frontend-runs'] ?? 3); run++) {
        const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
        const cdp = await connect(target.webSocketDebuggerUrl), inflight = new Map(), errors = [], responses = [], scripts = []
        let lastApi = Date.now(), transferredBytes = 0
        try {
          cdp.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.text + ': ' + (e.exceptionDetails.exception?.description ?? '')))
          cdp.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') errors.push(e.args.map(a => a.description ?? a.value ?? '').join(' ')) })
          cdp.on('Network.requestWillBeSent', e => { if (e.request.url.includes('/api/') && !/\/live(?:\?|$)/.test(e.request.url)) inflight.set(e.requestId, e.request.url) })
          cdp.on('Network.responseReceived', e => {
            if (e.response.url.includes('/api/')) {
              responses.push({ url: new URL(e.response.url).pathname, status: e.response.status })
              if (inflight.delete(e.requestId)) lastApi = Date.now()
            }
            if (e.type === 'Script') scripts.push(new URL(e.response.url).pathname)
          })
          cdp.on('Network.loadingFinished', e => { transferredBytes += e.encodedDataLength; if (inflight.delete(e.requestId)) lastApi = Date.now() })
          cdp.on('Network.loadingFailed', e => { if (inflight.delete(e.requestId)) lastApi = Date.now() })
          await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable')
          await cdp.call('Network.setCacheDisabled', { cacheDisabled: true })
          await cdp.call('Emulation.setCPUThrottlingRate', { rate: 6 })
          await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
          await cdp.call('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1600 * 1024 / 8, uploadThroughput: 768 * 1024 / 8, connectionType: 'cellular4g' })
          await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: "window.__perf={lcp:0,longTasks:0};new PerformanceObserver(l=>{for(const e of l.getEntries())window.__perf.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())window.__perf.longTasks+=Math.max(0,e.duration-50)}).observe({type:'longtask',buffered:true});" })
          await cdp.call('Network.clearBrowserCookies')
          if (authenticated) {
            const token = randomUUID() + randomUUID()
            await prisma.authSession.create({ data: { userId: owner.id, refreshTokenHash: createHash('sha256').update(token).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
            await cdp.call('Network.setCookie', { name: 'staffly_refresh', value: token, url: origin + '/api/auth', path: '/api/auth', httpOnly: true, sameSite: 'Lax' })
          }
          await cdp.call('Page.navigate', { url: origin + route })
          let ready, measurement
          for (let i = 0; i < 300; i++) {
            measurement = (await cdp.call('Runtime.evaluate', { expression: "({ready:!!document.querySelector('h1,h2')&&!document.querySelector('.app-loading,.route-loading')&&!!document.querySelector('form,main'),time:performance.now(),fcp:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??0,...window.__perf})", returnByValue: true })).result.value
            if (measurement?.ready && !inflight.size && Date.now() - lastApi > 400) { ready = true; break }
            await delay(100)
          }
          if (!ready) {
            const diagnostic = await cdp.call('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,1500)', returnByValue: true })
            throw new Error(`Page never ready: ${label}/${name}: ` + JSON.stringify({ measurement, pending: [...inflight.values()], responses, errors, text: diagnostic.result.value }))
          }
          assert.equal(errors.length, 0, errors.join('\n'))
          if (authenticated) assert(!responses.some(r => r.status >= 400), JSON.stringify(responses))
          assert(!scripts.some(s => /pdf-preview|pptx|presentation-charts|office-preview/.test(s)), 'An unopened viewer was fetched')
          const sample = { name, run, contentReadyMs: Math.round(measurement.time), fcpMs: Math.round(measurement.fcp), lcpMs: Math.round(measurement.lcp), longTaskBlockingMs: Math.round(measurement.longTasks), transferredBytes, scripts }
          samples.push(sample); console.log(JSON.stringify({ build: label, ...sample, scripts: scripts.length }))
          if (run === 0) { const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, `${label}-${name}.png`), Buffer.from(shot.data, 'base64')) }
        } finally { cdp.close(); await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`) }
      }
      result.builds[label] = { inventory: await inventory(directory), samples }
      await writeFile(path.join(output, 'frontend-progress.json'), JSON.stringify(result, null, 2))
    }
    const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
    result.comparison = routes.map(([name]) => {
      const before = result.builds.baseline.samples.filter(s => s.name === name), after = result.builds.optimized.samples.filter(s => s.name === name)
      if (!before.length || !after.length) return null
      const summarize = rows => Object.fromEntries(['contentReadyMs', 'fcpMs', 'lcpMs', 'longTaskBlockingMs', 'transferredBytes'].map(key => [key, median(rows.map(r => r[key]))]))
      return { name, baseline: summarize(before), optimized: summarize(after) }
    }).filter(Boolean)
    // Import the optional viewer entrypoints after the page measurements. This
    // catches broken vendor chunk initialization without charging it to routes.
    const manifest = JSON.parse(await readFile(path.join(root, 'dist/.vite/manifest.json'), 'utf8'))
    const viewers = Object.values(manifest).filter(v => /\/(pdf-preview|office-preview|pptx-preview|docx-preview)[^/]*\.js$/.test(v.file)).map(v => '/' + v.file)
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${origin}/auth`, { method: 'PUT' })).json()
    const cdp = await connect(target.webSocketDebuggerUrl)
    try {
      await cdp.call('Page.enable')
      await cdp.call('Page.navigate', { url: origin + '/auth' })
      for (let i = 0; i < 100; i++) {
        const state = await cdp.call('Runtime.evaluate', { expression: `location.origin===${JSON.stringify(origin)}&&document.readyState==='complete'`, returnByValue: true })
        if (state.result.value) break
        await delay(100)
      }
      const imported = await cdp.call('Runtime.evaluate', { expression: `Promise.all(${JSON.stringify(viewers)}.map(file=>import(file))).then(modules=>modules.map(m=>Object.keys(m)))`, awaitPromise: true, returnByValue: true })
      assert(!imported.exceptionDetails, JSON.stringify(imported.exceptionDetails))
      assert.equal(imported.result.value.length, viewers.length)
      result.viewerImports = { files: viewers, exports: imported.result.value, passed: true }
    } finally { cdp.close(); await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`) }
    if (ui) {
      const { runUiSmoke } = await import('./ui-scenarios.mjs')
      result.ui = await runUiSmoke({ prisma, owner, org, origin, port, root, temporary, output, connect, controls, publishGuideExamples: options['publish-guide-examples'] === 'true' })
    }
    await rm(path.join(output, 'frontend-progress.json'), { force: true })
    return result
  } finally {
    if (chrome.exitCode === null) { const stopped = once(chrome, 'exit'); chrome.kill('SIGTERM'); await stopped }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
}
