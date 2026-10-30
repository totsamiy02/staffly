import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, realpath, rm, access } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { SignJWT } from 'jose'
import { createArtifactDirectory, writeReport } from '../support/artifacts.mjs'

// Always creates its own disposable PostgreSQL cluster. No .env or existing DB is used.
// Run: npm run test:load -- --seconds=20
const root = fileURLToPath(new URL('../../', import.meta.url))
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
const databaseTimezone = options['db-timezone'] ?? 'UTC'
assert(/^[A-Za-z0-9_+/-]+$/.test(databaseTimezone), 'Invalid database timezone')
new Intl.DateTimeFormat('en', { timeZone: databaseTimezone }).format()
const processTimezone = options['process-timezone'] ?? 'UTC'
new Intl.DateTimeFormat('en', { timeZone: processTimezone }).format()
const seconds = Number(options.seconds ?? 20)
assert(Number.isInteger(seconds) && seconds >= 5 && seconds <= 120, '--seconds must be 5–120')
const bin = options['pg-bin'] ?? '/Applications/Postgres.app/Contents/Versions/18/bin'
await access(path.join(bin, 'initdb'))
const output = await createArtifactDirectory(options.tests ? 'regression' : options.profile === 'scale' ? 'scale' : options.profile === 'frontend' ? 'frontend' : 'load', options.output)
const temporary = await mkdtemp(path.join(os.tmpdir(), 'staffly-load-'))
const data = path.join(temporary, 'postgres')
const storage = path.join(temporary, 'storage')
const secret = randomUUID() + randomUUID()
const origin = 'http://localhost:5173'
const env = { PATH: process.env.PATH, LANG: 'C', USER: process.env.USER, TMPDIR: temporary,
  TZ: processTimezone,
  NODE_ENV: 'test', JWT_SECRET: secret, APP_ORIGIN: origin, LOCAL_STORAGE_ROOT: storage, ISOLATED_TEST_CLUSTER: 'true', PG_BIN: bin,
  SMTP_USER: '', SMTP_APP_PASSWORD: '', YANDEX_CLIENT_ID: '', YANDEX_CLIENT_SECRET: '', STORAGE_DRIVER: 'local', LIVE_DATABASE_URL: '', TRUST_PROXY: 'false', API_WARMUP: 'false' }
const results = { formatVersion: 1, status: 'running', startedAt: new Date().toISOString(), environment: { node: process.version,
  platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 1024 ** 3), seconds,
  apiProcesses: 1, poolMax: 10, databaseTimezone, processTimezone, postgresConfig: 'initdb defaults plus explicit timezone; fsync and synchronous_commit enabled' },
  methodology: 'Real HTTP API, pre-authenticated distinct users; no browser/TLS/SMTP/login hashing. Closed-loop clients, 0.5–1s think time unless noted. All fixtures synthetic. Service bursts separately exclude HTTP middleware.', phases: [] }
let clusterStarted = false, prisma, admin, api, metrics = [], apiLog = '', stopping = false
const extraCleanup = []
if (process.platform === 'darwin' && options.profile === 'scale') {
  const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
  awake.on('error', () => { console.warn('Idle-sleep guard unavailable; keep the computer awake manually.') })
  extraCleanup.push(async () => { if (awake.exitCode === null && awake.signalCode === null) awake.kill('SIGTERM') })
}
const samples = values => {
  const sorted = values.toSorted((a, b) => a - b)
  const p = q => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0
  return { count: sorted.length, p50Ms: +p(.5).toFixed(1), p95Ms: +p(.95).toFixed(1),
    p99Ms: +p(.99).toFixed(1), maxMs: +p(1).toFixed(1) }
}
async function command(command, args, extra = {}) {
  const { logFile, ...spawnOptions } = extra
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions })
  let text = ''
  child.stdout?.on('data', chunk => { text += chunk })
  child.stderr?.on('data', chunk => { text += chunk })
  const [code] = await once(child, 'exit')
  if (logFile) await writeFile(logFile, text)
  if (code !== 0) throw new Error(`${path.basename(command)} failed (${code}): ${text.slice(-5000)}`)
  return text
}
async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function stopApi() {
  if (!api || api.exitCode !== null || api.signalCode !== null) return
  const child = api, exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 6000)
  try { await exited } finally { clearTimeout(timer); api = undefined }
}
async function startApi() {
  await stopApi()
  const port = await freePort()
  api = spawn(process.execPath, ['--import', path.join(temporary, 'metrics.mjs'), '--import', 'tsx', 'src/server/index.ts'],
    { cwd: root, env: { ...env, PORT: String(port), DATABASE_URL: env.DATABASE_URL + '?application_name=staffly-load-api' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  api.stdout.on('data', chunk => { apiLog += chunk })
  api.stderr.on('data', chunk => { apiLog += chunk })
  api.on('message', message => metrics.push({ ...message, time: Date.now() }))
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(`API exited: ${apiLog.slice(-3000)}`)
    try {
      const response = await fetch(url + '/api/database-status', { signal: AbortSignal.timeout(1000) })
      if (response.ok && (await response.json()).connected) { await delay(1000); return url }
    } catch { /* Wait only for our new isolated process. */ }
    await delay(100)
  }
  throw new Error('Isolated API did not become ready')
}
async function monitor(phase, work) {
  const from = Date.now(), database = []
  let sampling = false
  const timer = setInterval(async () => {
    if (sampling) return
    sampling = true
    try {
      const { rows } = await admin.query("SELECT count(*)::int AS connections, count(*) FILTER (WHERE state='active')::int AS active, count(*) FILTER (WHERE wait_event_type='Lock')::int AS lock_waiters FROM pg_stat_activity WHERE application_name='staffly-load-api'")
      database.push(rows[0])
    } catch { /* Cleanup may close the monitoring connection. */ }
    finally { sampling = false }
  }, 250)
  try { await work() } finally { clearInterval(timer); while (sampling) await delay(10) }
  const captured = metrics.filter(m => m.time >= from)
  phase.api = { maxRssMiB: Math.round(Math.max(0, ...captured.map(m => m.rss)) / 1024 ** 2),
    maxCpuPercentOfOneCore: +Math.max(0, ...captured.map(m => m.cpuPercent)).toFixed(1),
    maxEventLoopP95Ms: +Math.max(0, ...captured.map(m => m.loopP95Ms)).toFixed(1),
    maxEventLoopDelayMs: +Math.max(0, ...captured.map(m => m.loopMaxMs)).toFixed(1) }
  phase.database = { samples: database.length, maxConnections: Math.max(0, ...database.map(m => m.connections)),
    maxActive: Math.max(0, ...database.map(m => m.active)), maxLockWaiters: Math.max(0, ...database.map(m => m.lock_waiters)),
    lockWaitSamplePercent: +(100 * database.filter(m => m.lock_waiters > 0).length / (database.length || 1)).toFixed(1) }
  results.phases.push(phase)
  console.log(JSON.stringify(phase))
}
const fixtures = []
async function seed() {
  const { createOrganization } = await import('../../src/server/organizations/organization-service.ts')
  for (let group = 0; group < 11; group++) {
    const count = group === 0 ? 100 : 10
    const users = Array.from({ length: count }, (_, i) => ({ id: randomUUID(), email: `load-${group}-${i}@example.test`,
      firstName: `Сотрудник ${i}`, emailVerifiedAt: new Date(), emailNotificationsEnabled: false }))
    await prisma.user.createMany({ data: users })
    const org = await createOrganization(users[0].id, { name: `Load ${group}`, description: null, timezone: 'Europe/Moscow' })
    const owner = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: users[0].id } } })
    const members = [owner, ...users.slice(1).map(user => ({ id: randomUUID(), userId: user.id, organizationId: org.id, role: 'MEMBER' }))]
    await prisma.organizationMember.createMany({ data: members.slice(1) })
    await prisma.locationMember.createMany({ data: members.slice(1).map(member => ({ organizationId: org.id, locationId: org.locationId, memberId: member.id })) })
    const requestType = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.id, systemCode: 'VACATION' } })
    const sessions = users.map(user => ({ id: randomUUID(), userId: user.id, refreshTokenHash: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''), idleExpiresAt: new Date(Date.now() + 86400000), absoluteExpiresAt: new Date(Date.now() + 86400000) }))
    await prisma.authSession.createMany({ data: sessions })
    const shifts = members.flatMap(member => Array.from({ length: 10 }, (_, day) => ({ organizationId: org.id, locationId: org.locationId,
      memberId: member.id, createdByMemberId: owner.id, scheduledStartAt: new Date(`2038-11-${String(day + 1).padStart(2, '0')}T06:00:00Z`),
      scheduledEndAt: new Date(`2038-11-${String(day + 1).padStart(2, '0')}T14:00:00Z`), breakMinutes: 30 })))
    await prisma.workShift.createMany({ data: shifts })
    await prisma.organizationRequest.createMany({ data: members.map(member => ({ organizationId: org.id, locationId: org.locationId,
      createdByMemberId: member.id, authorMemberId: member.id, requestTypeId: requestType.id, typeNameSnapshot: 'Отпуск', systemCodeSnapshot: 'VACATION',
      startDate: new Date('2038-12-01'), endDate: new Date('2038-12-03'), status: 'PENDING' })) })
    const clients = await Promise.all(users.map(async (user, i) => ({ userId: user.id, orgId: org.id, locationId: org.locationId,
      requestTypeId: requestType.id, token: await new SignJWT({ sid: sessions[i].id }).setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret)) })))
    fixtures.push(clients)
  }
  results.fixtures = { users: 200, organizations: 11, membersInLargeOrganization: 100, shifts: 2000, initialRequests: 200 }
  await admin.query('ANALYZE')
}
async function httpPhase(name, clients, concurrency, { thinkMs = 750, writes = 0, burst = false } = {}) {
  const url = await startApi(), records = [], phase = { name, kind: 'HTTP', virtualUsers: concurrency, thinkMs, plannedWrites: writes, burst }
  const probe = clients[0]
  for (const endpoint of [`/organizations/${probe.orgId}/requests/mine?pageSize=20`, `/notifications?organizationId=${probe.orgId}`, `/organizations/${probe.orgId}/schedule?from=2038-11-01&to=2038-11-08&locationId=${probe.locationId}`]) {
    const response = await fetch(url + '/api' + endpoint, { headers: { Authorization: `Bearer ${probe.token}` }, signal: AbortSignal.timeout(10000) })
    const body = await response.text()
    assert.equal(response.status, 200, `Preflight ${endpoint}: ${body.slice(0, 300)}`)
  }
  const created = []
  await monitor(phase, async () => {
    const start = performance.now(), deadline = start + seconds * 1000
    await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
      const client = clients[index % clients.length]
      let round = 0
      if (!burst) await delay((index * 37) % 750)
      do {
        const write = round === 0 && index < writes
        const operation = write ? 'create-request' : ['schedule', 'requests', 'notifications'][round % 3]
        round++
        const endpoint = operation === 'schedule' ? `/organizations/${client.orgId}/schedule?from=2038-11-01&to=2038-11-08&locationId=${client.locationId}`
          : operation === 'requests' || write ? `/organizations/${client.orgId}/requests${write ? '' : '/mine?page=1&pageSize=20'}`
            : `/notifications?organizationId=${client.orgId}&limit=20`
        const started = performance.now()
        try {
          const response = await fetch(url + '/api' + endpoint, { method: write ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${client.token}`, Origin: origin, ...(write ? { 'Content-Type': 'application/json' } : {}) },
            ...(write ? { body: JSON.stringify({ requestTypeId: client.requestTypeId, submissionKey: randomUUID(), startDate: '2038-12-10', endDate: '2038-12-12', comment: 'Synthetic load test' }) } : {}),
            signal: AbortSignal.timeout(30000) })
          const text = await response.text()
          const body = text ? JSON.parse(text) : {}
          records.push({ operation, status: response.status, ms: performance.now() - started, bytes: Buffer.byteLength(text), code: body.code })
          if (write && response.status === 201) created.push(body.request.id)
        } catch (error) { records.push({ operation, status: 'transport-error', ms: performance.now() - started, code: error.message }) }
        if (burst) break
        await delay(thinkMs + (index * 13 + round * 17) % 251)
      } while (performance.now() < deadline)
    }))
    phase.elapsedSeconds = +((performance.now() - start) / 1000).toFixed(2)
    phase.requests = records.length
    phase.requestsPerSecond = +(records.length / phase.elapsedSeconds).toFixed(1)
    phase.latency = samples(records.map(r => r.ms))
    phase.statuses = Object.fromEntries([...new Set(records.map(r => r.status))].map(status => [status, records.filter(r => r.status === status).length]))
    phase.operations = Object.fromEntries([...new Set(records.map(r => r.operation))].map(operation => {
      const matching = records.filter(r => r.operation === operation)
      return [operation, { ...samples(matching.map(r => r.ms)), meanBytes: Math.round(matching.reduce((n, r) => n + (r.bytes ?? 0), 0) / matching.length) }]
    }))
    phase.errorExamples = records.filter(r => r.status >= 400 || typeof r.status === 'string').slice(0, 5)
    if (created.length) {
      const persisted = await prisma.organizationRequest.count({ where: { id: { in: created } } })
      assert.equal(persisted, created.length, 'Every successful write must persist')
      phase.persistedWrites = persisted
    }
  })
}
async function serviceBurst(name, clients) {
  await stopApi()
  const { createRequest } = await import('../../src/server/requests/service.ts')
  const { locationContext } = await import('../../src/server/organizations/location-context.ts')
  const started = performance.now()
  const records = await Promise.all(clients.map(async client => {
    const begin = performance.now()
    try {
      const item = await locationContext.run({ organizationId: client.orgId, locationId: client.locationId }, () => createRequest(client.userId, client.orgId,
        { requestTypeId: client.requestTypeId, submissionKey: randomUUID(), startDate: '2038-12-15', endDate: '2038-12-17', comment: 'Synthetic service burst' }))
      return { status: 'saved', id: item.id, ms: performance.now() - begin }
    } catch (error) { return { status: error.code ?? error.name, ms: performance.now() - begin, message: error.message.slice(0, 300) } }
  }))
  const saved = records.filter(r => r.status === 'saved')
  assert.equal(await prisma.organizationRequest.count({ where: { id: { in: saved.map(r => r.id) } } }), saved.length)
  const phase = { name, kind: 'service (no HTTP/auth/rate limiter)', concurrentWrites: clients.length,
    elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2), latency: samples(records.map(r => r.ms)),
    statuses: Object.fromEntries([...new Set(records.map(r => r.status))].map(status => [status, records.filter(r => r.status === status).length])),
    persistedWrites: saved.length, errorExamples: records.filter(r => r.status !== 'saved').slice(0, 3) }
  results.phases.push(phase); console.log(JSON.stringify(phase))
}
async function cleanup() {
  if (stopping) return
  stopping = true
  await Promise.all(extraCleanup.map(stop => stop()))
  await stopApi()
  await prisma?.$disconnect()
  await admin?.end()
  if (clusterStarted) await command(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'])
  await rm(temporary, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().finally(() => process.exit(1)) })
try {
  console.log('Creating disposable PostgreSQL cluster and applying project migrations…')
  await command(path.join(bin, 'initdb'), ['-D', data, '-U', 'loadbench', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', `--locale=${options.locale ?? 'en_US.UTF-8'}`])
  const dbPort = await freePort()
  await command(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(temporary, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${dbPort} -k ${temporary} -c timezone=${databaseTimezone}${options.profile === 'scale' ? ' -c shared_preload_libraries=pg_stat_statements' : ''}`, '-w', 'start'])
  clusterStarted = true
  admin = new pg.Client({ connectionString: `postgresql://loadbench@127.0.0.1:${dbPort}/postgres` })
  await admin.connect()
  assert.equal(await realpath((await admin.query('SHOW data_directory')).rows[0].data_directory), await realpath(data))
  await admin.query('CREATE DATABASE staffly_test')
  env.DATABASE_URL = `postgresql://loadbench@127.0.0.1:${dbPort}/staffly_test`
  const config = path.join(temporary, 'prisma.config.mjs')
  await writeFile(config, `export default ${JSON.stringify({ schema: path.join(root, 'prisma/schema.prisma'), migrations: { path: path.join(root, 'prisma/migrations') }, datasource: { url: env.DATABASE_URL } })}`)
  await command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config])
  await admin.end()
  admin = new pg.Client({ connectionString: env.DATABASE_URL }); await admin.connect()
  if (options.profile === 'scale') await admin.query('CREATE EXTENSION pg_stat_statements')
  Object.assign(process.env, env)
  ;({ prisma } = await import('../../src/server/db.ts'))
  await writeFile(path.join(temporary, 'metrics.mjs'), `
    import { monitorEventLoopDelay } from 'node:perf_hooks';
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
    let cpu = process.cpuUsage(), time = performance.now();
    setInterval(() => { const now = performance.now(), next = process.cpuUsage();
      process.send?.({ rss: process.memoryUsage().rss, cpuPercent: ((next.user-cpu.user)+(next.system-cpu.system))/((now-time)*10), loopP95Ms: loop.percentile(95)/1e6, loopMaxMs: loop.max/1e6 });
      cpu=next; time=now; loop.reset(); },1000).unref();
  `)
  if (options.tests) {
    console.log('Running regression tests against the disposable database…')
    const testLog = await command(process.execPath, options['test-file']
      ? ['--import', 'tsx', '--test', '--test-concurrency=1', options['test-file']]
      : ['scripts/run-tests.mjs'], { logFile: path.join(output, 'tests.log') })
    await mkdir(output, { recursive: true })
    results.regression = Object.fromEntries(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped'].map(key => {
      const value = testLog.match(new RegExp(`(?:^|\\n)[ℹ#]?\\s*${key}\\s+(\\d+)`, 'm'))?.[1]
      return [key, value === undefined ? null : Number(value)]
    }))
    console.log(testLog.slice(-2500))
  }
  if (options.profile === 'frontend') {
    const { runFrontend } = await import('./frontend-scenarios.mjs')
    results.frontend = await runFrontend({ prisma, env, root, temporary, output, options, startApi })
  } else if (options.profile === 'scale') {
    results.environment.apiProcesses = Number(options.instances ?? 2)
    results.methodology = 'Scale profile: real password login and rotating sessions, 4000 SSE clients, fixed-rate actions and event-driven reads, background exports. Workload, SQL and timing profiles are included in this report.'
    const { runScale } = await import('./scale-scenarios.mjs')
    results.scale = await runScale({ prisma, env, root, temporary, output, options, registerCleanup: stop => extraCleanup.push(stop),
      saveReport: async scale => { results.scale = scale; await writeReport(output, results) } })
  } else if (options.tests !== 'only') {
    console.log('Seeding 200 synthetic users, 11 organizations and 2,000 shifts…')
    await seed()
    const single = fixtures[0], multiple = fixtures.slice(1).flat()
    await httpPhase('baseline-1-user', single, 1)
    await httpPhase('100-users-one-organization', single, 100, { writes: 50 })
    await httpPhase('100-users-ten-organizations', multiple, 100, { writes: 50 })
    await httpPhase('300-inflight-clients-ten-organizations', multiple, 300, { thinkMs: 500, writes: 50 })
    await httpPhase('100-simultaneous-writes-one-ip', single, 100, { writes: 100, burst: true })
    await serviceBurst('100-write-service-burst-one-organization', single)
    await serviceBurst('100-write-service-burst-ten-organizations', multiple)
  }
  results.finishedAt = new Date().toISOString()
  results.status = 'completed'
  await mkdir(output, { recursive: true })
  await writeReport(output, results)
  if (options.profile !== 'scale' && options.tests !== 'only') await writeFile(path.join(output, 'api.log'), apiLog)
  await rm(path.join(output, 'failed-run.log'), { force: true })
  console.log(`Results saved to ${path.relative(root, output)}/report.json`)
} catch (error) {
  results.failure = error.message
  results.status = 'failed'
  results.finishedAt = new Date().toISOString()
  await writeReport(output, results)
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'failed-run.log'), `${error.stack}\n${apiLog.slice(-20000)}`)
  throw error
} finally { await cleanup() }
