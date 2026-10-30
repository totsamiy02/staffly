import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { passwordHash } from '../../src/server/auth/passwords.ts'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'
import { createBusinessOrganization as createOrganization } from '../support/business-organization.ts'
import { eventParser } from '../../src/app/live-stream.ts'
import { liveHintMatches } from '../../src/app/live-query.ts'
import { accessTokenNeedsRefresh } from '../../src/app/auth/session-transport.ts'

const distribution = values => {
  const sorted = values.toSorted((a, b) => a - b), pick = q => +(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0).toFixed(1)
  return { count: sorted.length, p50Ms: pick(.5), p95Ms: pick(.95), p99Ms: pick(.99), maxMs: pick(1) }
}
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const number = server.address().port; await new Promise(resolve => server.close(resolve)); return number
}
export async function runScale({ prisma, env, root, temporary, output, options, registerCleanup, saveReport }) {
  await mkdir(output, { recursive: true })
  const soakSeconds = Number(options['soak-seconds'] ?? 180), rate = Number(options.rate ?? 200)
  let instances = Number(options.instances ?? 2)
  const poolBudget = Number(options['pool-budget'] ?? instances * 10)
  const heapBudget = Number(options['heap-budget-mib'] ?? 2048)
  assert(Number.isInteger(poolBudget) && poolBudget >= 8 && poolBudget <= 80)
  assert(Number.isInteger(heapBudget) && heapBudget >= 2048 && heapBudget <= 8192)
  const metricsToken = randomUUID() + randomUUID()
  assert(Number.isInteger(instances) && instances >= 1 && instances <= 8)
  assert(Number.isInteger(soakSeconds) && soakSeconds >= 10 && soakSeconds <= 7200)
  assert(Number.isInteger(rate) && rate >= 10 && rate <= 1000)
  const report = { methodology: '100 synthetic organizations × 40 distinct authenticated users; 6 historical months plus one planned month. Multiple identical API processes with live PostgreSQL invalidation and one background worker. 4,000 live SSE readers. Fixed-rate user actions plus event-driven refresh of the currently viewed module; 2% request writes and occasional owner shift edits. Real password login over 60 seconds, rotating refresh cookies and background exports. TLS/CDN/browser rendering excluded. Offices have distinct synthetic forwarding IPs from a trusted loopback test proxy context.',
    configuration: { organizations: 100, users: 4000, shifts: 560000, apiProcesses: instances, totalApiPoolBudget: poolBudget, totalApiHeapBudgetMiB: heapBudget, comparisonResources: 'Same host and sequential runs; fixed total SQL pool and V8 heap budgets. CPU and total RSS are measured, not OS-cgroup capped on macOS.', workerPool: 4, soakSeconds, targetUserActionsPerSecond: rate }, phases: [] }
  const children = [], metrics = [], clients = [], controllers = new Set()
  let stopped = false, log = '', current, cursor = 0, sequence = 0, streamStarts = 0, streamErrors = 0, liveConnections = 0
  const liveTasks = []
  async function stop() {
    if (stopped) return
    stopped = true
    controllers.forEach(controller => controller.abort())
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const done = once(child, 'exit'); child.kill('SIGTERM')
      const kill = setTimeout(() => child.kill('SIGKILL'), 10000)
      try { await done } finally { clearTimeout(kill) }
    }))
    await Promise.allSettled(liveTasks)
  }
  registerCleanup(stop)
  const save = async () => {
    await mkdir(output, { recursive: true })
    await saveReport(report)
    await writeFile(path.join(output, 'api.log'), log)
  }
  function child(entry, name, extra) {
    const process = spawn(globalThis.process.execPath, ['--import', path.join(temporary, 'metrics.mjs'), '--import', 'tsx', entry], {
      cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.push(process)
    process.stdout.on('data', data => { log += `[${name}] ${data}` })
    process.stderr.on('data', data => { log += `[${name}] ${data}` })
    process.on('message', item => metrics.push({ ...item, name, time: Date.now() }))
    return process
  }
  try {
    const password = `Scale-test-${randomUUID()}`, hashedPassword = await passwordHash(password)
    console.log('Seeding 100 organizations, 4,000 users and 560,000 shifts…')
    const seedStarted = performance.now()
    const active = new Date(), year = active.getUTCFullYear(), nextMonth = active.getUTCMonth() + 1
    const activeMonth = new Date(Date.UTC(year, nextMonth, 1))
    const textDate = date => date.toISOString().slice(0, 10)
    const from = textDate(activeMonth), to = textDate(new Date(+activeMonth + 7 * 86400000))
    report.configuration.scheduleRange = { from, to }
    for (let group = 0; group < 100; group++) {
      const users = Array.from({ length: 40 }, (_, index) => ({ id: randomUUID(), email: `scale-${group}-${index}@example.test`,
        firstName: `Сотрудник ${index}`, passwordHash: hashedPassword, emailVerifiedAt: new Date(), emailNotificationsEnabled: false }))
      await prisma.user.createMany({ data: users })
      const org = await createOrganization(users[0].id, { name: `Scale organization ${group}`, description: null, timezone: 'Europe/Moscow' })
      const owner = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: users[0].id } } })
      const members = [owner, ...users.slice(1).map(user => ({ id: randomUUID(), userId: user.id, organizationId: org.id, role: 'MEMBER' }))]
      await prisma.organizationMember.createMany({ data: members.slice(1) })
      await prisma.locationMember.createMany({ data: members.slice(1).map(member => ({ organizationId: org.id, locationId: org.locationId, memberId: member.id })) })
      const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.id, systemCode: 'VACATION' } })
      let ownerShift
      for (let month = -6; month <= 0; month++) {
        const monthDate = new Date(Date.UTC(activeMonth.getUTCFullYear(), activeMonth.getUTCMonth() + month, 1))
        const shifts = members.flatMap(member => Array.from({ length: 20 }, (_, day) => {
          const id = randomUUID(), start = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), day + 1, 6))
          if (month === 0 && day === 0 && member.id === owner.id) ownerShift = id
          return { id, organizationId: org.id, locationId: org.locationId, memberId: member.id, createdByMemberId: owner.id,
            scheduledStartAt: start, scheduledEndAt: new Date(+start + 8 * 3600000), breakMinutes: 30 }
        }))
        await prisma.workShift.createMany({ data: shifts })
      }
      await prisma.organizationRequest.createMany({ data: members.map(member => ({ organizationId: org.id, locationId: org.locationId, createdByMemberId: member.id,
        authorMemberId: member.id, requestTypeId: type.id, typeNameSnapshot: 'Отпуск', systemCodeSnapshot: 'VACATION',
        startDate: new Date('2038-12-01'), endDate: new Date('2038-12-03'), status: 'PENDING' })) })
      for (let index = 0; index < 40; index++) clients.push({ id: users[index].id, orgId: org.id, locationId: org.locationId, memberId: members[index].id,
        requestTypeId: type.id, ownerShift, owner: index === 0, ip: `198.18.0.${group + 1}`, page: index % 3,
        email: users[index].email, token: '', cookies: new Map(), expires: 0,
        busy: false, refreshAt: 0 })
      if (group % 20 === 19) console.log(`Seeded ${group + 1}/100 organizations`)
    }
    report.seedSeconds = +((performance.now() - seedStarted) / 1000).toFixed(1)
    await prisma.$executeRaw`ANALYZE`
    const urls = [], apiChildren = []
    let restarting = false
    async function startApis() {
      for (let index = 0; index < instances; index++) {
        const number = await port(), url = `http://127.0.0.1:${number}`
        urls.push(url)
        apiChildren.push(child('src/server/index.ts', `api${index + 1}`, { PORT: String(number), HOST: '127.0.0.1', RUN_BACKGROUND_WORKERS: 'false', TRUST_PROXY: 'loopback', API_WARMUP: 'true',
          DB_POOL_MAX: String(Math.floor(poolBudget / instances) + (index < poolBudget % instances ? 1 : 0)),
          NODE_OPTIONS: `--max-old-space-size=${Math.floor(heapBudget / instances)}`,
          METRICS_TOKEN: metricsToken,
          DATABASE_URL: env.DATABASE_URL + `?application_name=staffly-scale-api${index + 1}` }))
        let ready = false
        for (let attempt = 0; attempt < 300; attempt++) {
          try { const response = await fetch(url + '/health/ready', { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break } } catch { /* Wait for startup. */ }
          await delay(100)
        }
        assert(ready, `API ${index + 1} did not start: ${log.slice(-3000)}`)
      }
    }
    await startApis()
    child('src/server/worker.ts', 'worker', { DB_POOL_MAX: '4', DATABASE_URL: env.DATABASE_URL + '?application_name=staffly-scale-worker' })
    const headers = client => ({ Authorization: `Bearer ${client.token}`, Origin: env.APP_ORIGIN, 'X-Forwarded-For': client.ip })
    const authSamples = { login: [], refresh: [] }, authStatuses = { login: {}, refresh: {} }
    async function authenticate(client, login = false) {
      if (!login && client.expires > Date.now() + 45000 && !accessTokenNeedsRefresh(client.token)) return
      if (client.authenticating) return client.authenticating
      client.authenticating = (async () => {
        const kind = login ? 'login' : 'refresh', start = performance.now()
        const response = await fetch(urls[cursor++ % instances] + `/api/auth/${kind}`, { method: 'POST',
          headers: { Origin: env.APP_ORIGIN, 'X-Forwarded-For': client.ip, 'Content-Type': 'application/json', Cookie: [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
          body: JSON.stringify(login ? { email: client.email, password } : {}), signal: AbortSignal.timeout(15000) })
        authSamples[kind].push(performance.now() - start)
        authStatuses[kind][response.status] = (authStatuses[kind][response.status] ?? 0) + 1
        const result = await response.json()
        assert.equal(response.status, 200, `${kind}: ${response.status} ${result.code ?? ''}`)
        for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], at = pair.indexOf('='); client.cookies.set(pair.slice(0, at), pair.slice(at + 1)) }
        client.token = result.accessToken
        client.expires = JSON.parse(Buffer.from(client.token.split('.')[1], 'base64url')).exp * 1000
      })()
      try { await client.authenticating } finally { client.authenticating = undefined }
    }
    console.log('Signing in 4,000 users with real password verification over 60 seconds…')
    const loginStarted = performance.now(), logins = []
    let loginFailure
    for (let index = 0; index < clients.length; index++) {
      const promise = authenticate(clients[index], true)
      promise.catch(error => { loginFailure ??= error })
      logins.push(promise)
      await delay(Math.max(0, (index + 1) * 15 - (performance.now() - loginStarted)))
      if (loginFailure) break
    }
    await Promise.allSettled(logins)
    report.authentication = { login: { ...distribution(authSamples.login), statuses: authStatuses.login } }
    await save()
    if (loginFailure) throw loginFailure
    const readPath = (client, page = client.page) => page === 0
      ? `/organizations/${client.orgId}/schedule?from=${from}&to=${to}&locationId=${client.locationId}`
      : page === 1 ? `/organizations/${client.orgId}/requests/mine?pageSize=20&locationId=${client.locationId}`
        : `/notifications?organizationId=${client.orgId}&limit=20`
    const exports = []
    async function exportReport(client) {
      const start = performance.now(), result = { organization: clients.indexOf(client) / 40 }
      try {
        await authenticate(client)
        const base = `/organizations/${client.orgId}/statistics/reports`
        const response = await fetch(urls[cursor++ % instances] + '/api' + base + '/export', { method: 'POST', headers: { ...headers(client), 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to, locationIds: [client.locationId], memberIds: [], includeFormer: false, config: defaultReportConfig() }), signal: AbortSignal.timeout(15000) })
        assert.equal(response.status, 202, 'Export must enqueue without blocking the API')
        const { job } = await response.json()
        const deadline = Date.now() + 90000
        let ready = false
        while (Date.now() < deadline && !stopped) {
          await delay(1500)
          const status = await fetch(urls[cursor++ % instances] + '/api' + job.statusUrl, { headers: headers(client), signal: AbortSignal.timeout(15000) })
          assert.equal(status.status, 200)
          const state = await status.json()
          assert.notEqual(state.status, 'FAILED')
          if (state.status === 'READY') { ready = true; break }
        }
        assert(ready, 'Export did not finish in 90 seconds')
        const download = await fetch(urls[cursor++ % instances] + '/api' + job.statusUrl + '/content', { headers: headers(client), signal: AbortSignal.timeout(15000) })
        assert.equal(download.status, 200)
        const bytes = Buffer.from(await download.arrayBuffer())
        assert.equal(bytes.subarray(0, 2).toString(), 'PK')
        result.bytes = bytes.length; result.status = 'downloaded'
      } catch (error) { result.status = 'failed'; result.error = error.message }
      result.elapsedMs = Math.round(performance.now() - start); exports.push(result)
    }
    function record(operation, status, ms, bytes = 0, code) {
      if (!current) return
      current.latencies.push(ms)
      ;(current.operations[operation] ??= []).push(ms)
      current.statuses[status] = (current.statuses[status] ?? 0) + 1
      current.bytes += bytes
      if ((status >= 400 || typeof status === 'string') && current.errors.length < 10) current.errors.push({ operation, status, code })
    }
    async function request(client, { write = false, edit = false, event = false, resync = false } = {}) {
      if (client.busy || stopped) { if (current && !event) current.skipped++; return }
      client.busy = true
      const operation = edit ? 'edit-shift' : write ? 'create-request' : resync ? 'live-resync' : event ? 'live-refresh' : ['schedule', 'requests', 'notifications'][client.page]
      const start = performance.now()
      let endpoint = readPath(client), body
      if (write) {
        endpoint = `/organizations/${client.orgId}/requests?locationId=${client.locationId}`
        body = { requestTypeId: client.requestTypeId, submissionKey: randomUUID(), startDate: '2038-12-10', endDate: '2038-12-12', comment: 'Synthetic scale test' }
      }
      if (edit) {
        endpoint = `/organizations/${client.orgId}/shifts/${client.ownerShift}?locationId=${client.locationId}`
        body = { memberId: client.memberId, startDate: from, endDate: from, startTime: '09:00', endTime: '17:00', breakMinutes: 30, description: `Synthetic edit ${sequence}` }
      }
      const url = urls[cursor++ % urls.length]
      assert.equal(new URL(url).hostname, '127.0.0.1')
      try {
        await authenticate(client)
        const response = await fetch(url + '/api' + endpoint, { method: edit ? 'PATCH' : write ? 'POST' : 'GET', headers: { ...headers(client), ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
        const text = await response.text()
        let result
        if (body || !response.ok) { try { result = JSON.parse(text) } catch { /* Included in status counts. */ } }
        record(operation, response.status, performance.now() - start, Buffer.byteLength(text), result?.code)
        if (write && response.status === 201 && current) current.saved.push(result.request.id)
      } catch (error) { record(operation, 'transport-error', performance.now() - start, 0, error.message) }
      finally { client.busy = false }
    }
    async function stream(client) {
      while (!stopped) {
        if (restarting) { await delay(100); continue }
        if (client.reconnectAfter > Date.now()) await delay(client.reconnectAfter - Date.now())
        const controller = new AbortController(); controllers.add(controller)
        client.streamController = controller
        let live = false
        try {
          await authenticate(client)
          const response = await fetch(urls[clients.indexOf(client) % instances] + `/api/live?organizationId=${client.orgId}`, { headers: headers(client), signal: controller.signal })
          if (!response.ok || !response.body) { streamErrors++; await response.body?.cancel(); throw new Error('Stream rejected') }
          const reader = response.body.getReader(), decoder = new TextDecoder()
          const parse = eventParser(({ event, data }) => {
            if (event === 'ready' && !live) {
              live = true; liveConnections++; streamStarts++
              if (client.seenStream && current) void request(client, { event: true, resync: true })
              client.seenStream = true
            }
            if (event !== 'change' || !current) return
            const hints = JSON.parse(data), key = [ ['schedule', client.orgId], ['requests', client.orgId, 'mine'], ['notifications'] ][client.page]
            if (hints.some(hint => liveHintMatches(hint, key)) && performance.now() - client.refreshAt > 750) {
              client.refreshAt = performance.now()
              void request(client, { event: true })
            }
          })
          try { while (!stopped) { const part = await reader.read(); if (part.done) break; parse(decoder.decode(part.value, { stream: true })) } }
          finally { await reader.cancel().catch(() => undefined) }
        } catch { /* A disconnected stream is explicitly counted and re-established. */ }
        finally { if (live) liveConnections--; controllers.delete(controller); controller.abort() }
        if (!stopped) await delay(500 + Math.random() * 1000)
      }
    }
    console.log(`Opening 4,000 authenticated SSE connections across ${instances} API processes…`)
    const opening = performance.now()
    for (let index = 0; index < clients.length; index++) {
      liveTasks.push(stream(clients[index]))
      if (index % 20 === 19) await delay(50)
    }
    const readyDeadline = Date.now() + 120000
    while (liveConnections < 4000 && Date.now() < readyDeadline) { await delay(1000); console.log(`Live connections: ${liveConnections}/4000`) }
    assert.equal(liveConnections, 4000, 'All 4,000 authenticated sessions must establish live updates')
    report.liveStartup = { seconds: +((performance.now() - opening) / 1000).toFixed(1), connections: liveConnections, rejectedAttempts: streamErrors }
    let persistIds = []
    async function phase(name, duration, targetRate, { attack = false, rotate = false } = {}) {
      const diagnostics = () => Promise.all(urls.map(async url => {
        const response = await fetch(url + '/internal/metrics', { headers: { Authorization: `Bearer ${metricsToken}`, Accept: 'application/json' } })
        assert.equal(response.status, 200)
        return response.json()
      }))
      const beforeDiagnostics = await diagnostics()
      const stage = { name, seconds: duration, targetUserActionsPerSecond: targetRate, liveConnectionsAtStart: liveConnections,
        latencies: [], operations: {}, statuses: {}, bytes: 0, skipped: 0, errors: [], saved: [], minutes: [] }
      current = stage
      await prisma.$executeRaw`SELECT pg_stat_statements_reset()`
      const start = performance.now(), startWall = Date.now(), pending = new Set()
      let issued = 0, lastPrinted = start, lastTick = start, minuteOffset = 0, attackIssued = 0, attackCounts = {}, rotated = 0
      const issue = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)) }
      while (!stopped) {
        const now = performance.now(), gap = now - lastTick
        if (gap > 5000) {
          report.interruption = { phase: name, elapsedSeconds: Math.round((now - start) / 1000), gapSeconds: +(gap / 1000).toFixed(1), reason: 'load-generator-paused' }
          throw new Error('Load generator paused for more than five seconds; measurement is invalid. Keep the computer awake and rerun.')
        }
        lastTick = now
        const elapsed = (now - start) / 1000
        if (elapsed >= duration) break
        if (rotate && elapsed >= 30) {
          const due = Math.min(clients.length, Math.floor((elapsed - 30) * clients.length / 60))
          while (rotated < due) {
            const client = clients[rotated++]; client.expires = 0
            issue(authenticate(client).then(() => client.streamController?.abort(), error => { (stage.rotationErrors ??= []).push(error.message) }))
          }
        }
        const due = Math.min(Math.floor(elapsed * targetRate), issued + 100)
        while (issued < due) {
          const index = (sequence * 37) % clients.length
          const client = clients[index]; issued++; sequence++
          issue(request(client, { write: sequence % 50 === 0 }))
          if (sequence % 500 === 0) issue(request(clients[(Math.floor(sequence / 500) % 100) * 40], { edit: true }))
          if (sequence % 30000 === 0) issue(exportReport(clients[(Math.floor(sequence / 30000) % 100) * 40]))
        }
        if (attack) {
          const count = Math.min(Math.floor(elapsed * 1500) - attackIssued, 50)
          for (let index = 0; index < count; index++) {
            attackIssued++
            const url = urls[attackIssued % instances]
            issue(fetch(url + '/api/organizations', { headers: { Authorization: 'Bearer forged.invalid.signature', 'X-Forwarded-For': '198.19.0.1' }, signal: AbortSignal.timeout(5000) })
              .then(async response => { attackCounts[response.status] = (attackCounts[response.status] ?? 0) + 1; await response.body?.cancel() }, () => { attackCounts.transport = (attackCounts.transport ?? 0) + 1 }))
          }
        }
        if (performance.now() - lastPrinted >= 60000) {
          const recent = stage.latencies.slice(minuteOffset); minuteOffset = stage.latencies.length
          const sample = { elapsedSeconds: Math.round(elapsed), ...distribution(recent), liveConnections }
          stage.minutes.push(sample)
          report.progress = { phase: name, ...sample, requests: stage.latencies.length, statuses: stage.statuses }
          console.log(JSON.stringify({ phase: name, ...sample, statuses: stage.statuses }))
          lastPrinted = performance.now()
          await save()
        }
        await delay(10)
      }
      await Promise.allSettled([...pending])
      await delay(350)
      const drainDeadline = Date.now() + 20000
      while (clients.some(client => client.busy) && Date.now() < drainDeadline) await delay(20)
      const captured = metrics.filter(item => item.time >= startWall && item.name !== 'worker')
      const metricPerProcess = Object.fromEntries(urls.map((_, index) => `api${index + 1}`).map(name => {
        const rows = captured.filter(item => item.name === name)
        return [name, { firstRssMiB: Math.round((rows[0]?.rss ?? 0) / 1024 ** 2), lastRssMiB: Math.round((rows.at(-1)?.rss ?? 0) / 1024 ** 2),
          maxRssMiB: Math.round(Math.max(0, ...rows.map(item => item.rss)) / 1024 ** 2), meanCpuPercentOfOneCore: +(rows.reduce((sum, item) => sum + item.cpuPercent, 0) / (rows.length || 1)).toFixed(1), maxEventLoopP95Ms: +Math.max(0, ...rows.map(item => item.loopP95Ms)).toFixed(1) }]
      }))
      const result = { name, elapsedSeconds: +((performance.now() - start) / 1000).toFixed(1), targetUserActionsPerSecond: targetRate,
        apiProcesses: instances, poolBudget, heapBudgetMiB: heapBudget, forcedSessionRotations: rotated, rotationErrors: stage.rotationErrors ?? [],
        requests: stage.latencies.length, issuedUserActions: issued, latency: distribution(stage.latencies), statuses: stage.statuses, bytes: stage.bytes, skippedBusyClients: stage.skipped,
        operations: Object.fromEntries(Object.entries(stage.operations).map(([name, values]) => [name, distribution(values)])),
        successfulWrites: stage.saved.length, liveConnectionsAtEnd: liveConnections, api: metricPerProcess, minutes: stage.minutes, errorExamples: stage.errors,
        ...(attack ? { attack: { requests: attackIssued, statuses: attackCounts } } : {}) }
      const statements = await prisma.$queryRaw`SELECT left(query, 600) AS query, calls::float8, total_exec_time, mean_exec_time, rows::float8 FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC LIMIT 20`
      result.diagnostics = { sql: statements, timings: { before: beforeDiagnostics, after: await diagnostics() } }
      persistIds.push(...stage.saved)
      current = undefined
      report.phases.push(result); console.log(JSON.stringify({ ...result, diagnostics: undefined })); await save()
    }
    if (options.probe !== 'true') {
      await phase('4000-live-sessions-200rps', Math.min(60, soakSeconds), Math.min(200, rate))
      await phase('4000-live-sessions-400rps-burst', Math.min(20, soakSeconds), Math.min(400, rate * 2))
      await phase('legitimate-traffic-during-anonymous-flood', 15, 100, { attack: true })
    }
    await phase('4000-live-sessions-soak', soakSeconds, rate, { rotate: options['rotate-sessions'] === 'true' })
    if (options['compare-instances']) {
      const counts = options['compare-instances'].split(',').map(Number)
      const duration = Number(options['compare-seconds'] ?? 120)
      assert(Number.isInteger(duration) && duration >= 90 && duration <= 600)
      for (const count of counts) {
        assert(Number.isInteger(count) && count >= 1 && count <= 8)
        if (count === instances) continue
        console.log(`Comparing ${count} API processes with the same total pool/heap budgets…`)
        restarting = true
        clients.forEach(client => { client.reconnectAfter = Date.now() + 10000 + Math.random() * 10000 })
        controllers.forEach(controller => controller.abort())
        await Promise.all(apiChildren.splice(0).map(async api => {
          if (api.exitCode !== null || api.signalCode !== null) return
          const done = once(api, 'exit'); api.kill('SIGTERM')
          const timer = setTimeout(() => api.kill('SIGKILL'), 7000)
          try { await done } finally { clearTimeout(timer) }
        }))
        urls.length = 0; instances = count
        await startApis()
        restarting = false
        const end = Date.now() + 90000
        while (liveConnections < clients.length && Date.now() < end) await delay(500)
        assert.equal(liveConnections, clients.length)
        await phase(`compare-${count}-api`, duration, rate)
      }
    }
    let persisted = 0
    for (let offset = 0; offset < persistIds.length; offset += 1000) persisted += await prisma.organizationRequest.count({ where: { id: { in: persistIds.slice(offset, offset + 1000) } } })
    assert.equal(persisted, persistIds.length, 'Every acknowledged write must remain in the database')
    report.integrity = { acknowledgedWrites: persistIds.length, persistedWrites: persisted }
    report.live = { finalConnections: liveConnections, totalStreamStarts: streamStarts, rejectedAttempts: streamErrors }
    report.authentication.refresh = { ...distribution(authSamples.refresh), statuses: authStatuses.refresh }
    report.exports = exports
    const steady = report.phases.find(phase => phase.name === '4000-live-sessions-soak')
    report.acceptance = { steadyReadP95Under300ms: Object.entries(steady.operations).filter(([name]) => !['create-request', 'edit-shift'].includes(name)).every(([, latency]) => latency.p95Ms <= 300),
      steadyWriteP95Under500ms: ['create-request', 'edit-shift'].every(name => (steady.operations[name]?.p95Ms ?? Infinity) <= 500),
      steadyNoErrors: Object.keys(steady.statuses).every(status => Number(status) >= 200 && Number(status) < 300),
      allBusinessPhasesNoErrors: report.phases.every(phase => Object.keys(phase.statuses).every(status => Number(status) >= 200 && Number(status) < 300)),
      allExportsDownloaded: exports.length > 0 && exports.every(job => job.status === 'downloaded'),
      allLoginSucceeded: authStatuses.login['200'] === 4000,
      continuousGenerator: steady.issuedUserActions >= soakSeconds * rate * .99,
      sessionRotationSucceeded: options['rotate-sessions'] !== 'true' && soakSeconds < 900 || authSamples.refresh.length >= 4000 && Object.keys(authStatuses.refresh).every(status => status === '200') && !steady.rotationErrors.length,
      comparisonNoErrors: report.phases.filter(phase => phase.name.startsWith('compare-')).every(phase => Object.keys(phase.statuses).every(status => Number(status) >= 200 && Number(status) < 300)) }
    report.finishedAt = new Date().toISOString()
    await save()
    if (options['assert-slo'] === 'true') assert(Object.values(report.acceptance).every(Boolean), 'Scale acceptance checks failed; see report.json')
    return report
  } catch (error) { report.failure = error.message; await save(); throw error }
  finally { await stop() }
}
