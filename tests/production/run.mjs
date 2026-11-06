import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createArtifactDirectory, writeReport } from '../support/artifacts.mjs'
import { runChecks } from './checks.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
assert(Object.keys(options).every(key => ['output', 'preflight'].includes(key)), 'Only --output and --preflight options are supported')
// No .env, application credentials or user Compose variables are inherited.
const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'LANG', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
env.BUILDKIT_PROGRESS = 'plain'
let composeCommand
async function command(binary, args, { input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`${path.basename(binary)} exited ${code}: ${output.slice(-6000)}`)) })
    child.stdin.on('error', () => {}); child.stdin.end(input)
  })
}
await command('docker', ['info', '--format', '{{.OSType}}']).then(value => assert.equal(value.trim(), 'linux')).catch(() => {
  throw new Error('A running Linux Docker engine is required. Start Docker/Colima, select it with DOCKER_HOST/context, then run npm run test:production again. No application data was changed.')
})
try { await command('docker', ['compose', 'version']); composeCommand = ['docker', 'compose'] }
catch { await command('docker-compose', ['version']); composeCommand = ['docker-compose'] }
if (options.preflight === 'true') { console.log('Linux Docker and Compose are available.'); process.exit(0) }

const output = await createArtifactDirectory('production', options.output)
const temporary = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'staffly-production-'))
await chmod(temporary, 0o700)
const tls = path.join(temporary, 'tls'); await mkdir(tls, { mode: 0o755 })
const project = 'staffly-audit-' + randomUUID().slice(0, 12)
const prefix = '172.29.' + randomInt(20, 240)
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
const origin = 'https://staffly.test:' + port
const password = randomBytes(24).toString('hex')
const values = {
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'), APP_DATABASE_PASSWORD: randomBytes(32).toString('hex'), MIGRATION_DATABASE_PASSWORD: randomBytes(32).toString('hex'),
  JWT_SECRET: randomBytes(32).toString('hex'), INVITE_CODE_SECRET: randomBytes(32).toString('hex'), METRICS_TOKEN: randomBytes(32).toString('hex'),
  DATABASE_URL: '', MIGRATION_DATABASE_URL: '', DB_TIMEZONE: 'UTC', APP_ORIGIN: origin,
  SMTP_HOST: 'smtp', SMTP_PORT: '465', SMTP_USER: 'audit@example.test', SMTP_APP_PASSWORD: randomBytes(24).toString('hex'),
  STORAGE_DRIVER: 'local', LOCAL_STORAGE_SHARED: 'true', BIND_ADDRESS: '127.0.0.1', HTTPS_PORT: String(port),
  EDGE_INTERNAL_IP: prefix + '.10', BACKEND_SUBNET: prefix + '.0/24',
  APP_IMAGE: project + '-runtime:local', MIGRATION_IMAGE: project + '-migrations:local', FILE_PROCESSOR_IMAGE: project + '-processor:local', EDGE_IMAGE: project + '-edge:local',
  TLS_CERT_PATH: path.join(tls, 'cert.pem'), TLS_KEY_PATH: path.join(tls, 'key.pem'), AUDIT_PASSWORD: password,
}
values.DATABASE_URL = `postgresql://staffly_app:${values.APP_DATABASE_PASSWORD}@postgres:5432/staffly`
values.MIGRATION_DATABASE_URL = `postgresql://staffly_migrator:${values.MIGRATION_DATABASE_PASSWORD}@postgres:5432/staffly`
const envFile = path.join(temporary, 'audit.env'), override = path.join(temporary, 'compose.yaml')
await writeFile(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 })
const auditDir = JSON.stringify(fileURLToPath(new URL('./', import.meta.url)).replace(/\/$/, '') + ':/app/tests/production:ro')
const tlsDir = JSON.stringify(tls + ':/run/audit:ro')
// Read-only fixture scripts and a private TLS mail sink exist only in this overlay.
await writeFile(override, `services:\n` + ['api1','api2','api3','api4','worker'].map(service => `  ${service}:\n    environment:\n      NODE_EXTRA_CA_CERTS: /run/audit/cert.pem\n      PRODUCTION_AUDIT: 'true'\n      AUDIT_PASSWORD: \${AUDIT_PASSWORD}\n    volumes: [${auditDir}, ${tlsDir}]\n`).join('') + `  smtp:\n    image: \${APP_IMAGE}\n    command: [node, tests/production/smtp.mjs]\n    user: node\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: ['no-new-privileges:true']\n    sysctls: {net.ipv4.ip_unprivileged_port_start: '0'}\n    networks: [backend]\n    volumes: [${auditDir}, ${tlsDir}]\n`)
const compose = (...args) => command(composeCommand[0], [...composeCommand.slice(1), '--project-name', project, '--env-file', envFile, '-f', path.join(root, 'deploy/compose.yaml'), '-f', path.join(root, 'deploy/compose.local-files.yaml'), '-f', override, ...args], { timeout: 900000 })
const exec = (service, script, input) => command(composeCommand[0], [...composeCommand.slice(1), '--project-name', project, '--env-file', envFile, '-f', path.join(root, 'deploy/compose.yaml'), '-f', path.join(root, 'deploy/compose.local-files.yaml'), '-f', override, 'exec', '-T', service, 'node', '--import', 'tsx', '--input-type=module', '-e', script], { input: input === undefined ? undefined : JSON.stringify(input) })
const fixtureAction = async (action, fixture) => {
  const value = await exec('api1', `process.env.AUDIT_FIXTURE=${JSON.stringify(JSON.stringify(fixture ?? {}))}; process.argv[2]=${JSON.stringify(action)}; await import('./tests/production/fixtures.ts')`)
  return JSON.parse(value.trim().split('\n').at(-1))
}
const secrets = Object.entries(values).filter(([key]) => /PASSWORD|SECRET|TOKEN|DATABASE_URL/.test(key)).map(([,value]) => value)
const safe = value => { let result = String(value); for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]'); return result.replace(/Bearer [\w.-]+/g, 'Bearer [redacted]').replace(/(staffly_refresh=)[^;\s]+/g, '$1[redacted]') }
const results = { formatVersion: 1, status: 'running', startedAt: new Date().toISOString(), environment: { mode: 'production', nodeImage: 'node:24-bookworm-slim', apiProcesses: 4, separateWorker: true, storage: 'shared local Docker volume', project }, checks: [] }
let started = false, cleaning = false
async function cleanup() {
  if (cleaning) return; cleaning = true
  try { if (started) await compose('down', '--volumes', '--remove-orphans', '--timeout', '15') }
  finally { await rm(temporary, { recursive: true, force: true }) }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)) })
try {
  console.log('Building production images; all database/files are disposable…')
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', values.TLS_KEY_PATH, '-out', values.TLS_CERT_PATH, '-days', '1', '-subj', '/CN=staffly.test', '-addext', 'subjectAltName=DNS:staffly.test,DNS:smtp'])
  // Directory is 0700; only edge/mail containers receive these test-only TLS files.
  await chmod(values.TLS_KEY_PATH, 0o644)
  await compose('config', '--quiet')
  started = true
  const build = await compose('build', 'api1', 'migrate', 'file-processor', 'edge')
  await writeFile(path.join(output, 'build.log'), safe(build))
  await compose('up', '-d', '--wait', '--wait-timeout', '180')
  results.checks.push({ name: 'production stack starts with real migrations and restricted runtime roles', status: 'passed' })
  console.log('Running HTTPS, storage, worker, export and failover checks…')
  const fixture = await fixtureAction('seed')
  const check = async (name, run) => { const details = await run(); results.checks.push({ name, status: 'passed', ...(details ? { details } : {}) }); await writeReport(output, results); console.log('Passed: ' + name) }
  await check('runtime database cannot change schema, roles, audit history or quotas', () => fixtureAction('permissions'))
  let sharedVolume
  for (const service of ['api1','api2','api3','api4','worker']) {
    await check(service + ' uses a non-root user and a read-only application filesystem', async () => {
      const id = (await compose('ps', '-q', service)).trim()
      const meta = JSON.parse(await command('docker', ['inspect', '--format', '{{json .HostConfig.ReadonlyRootfs}}', id])); assert.equal(meta, true)
      const mounts = JSON.parse(await command('docker', ['inspect', '--format', '{{json .Mounts}}', id]))
      const files = mounts.find(mount => mount.Destination === '/var/lib/staffly/storage')
      assert.equal(files?.Type,'volume'); assert.equal(files.RW,true)
      sharedVolume ??= files.Name; assert.equal(files.Name,sharedVolume)
      await exec(service, `import assert from 'node:assert/strict'; import { writeFile, unlink } from 'node:fs/promises'; assert.notEqual(process.getuid(),0); await assert.rejects(writeFile('/app/production-audit-write','denied'), {code:'EROFS'}); await writeFile('/tmp/production-audit-write','allowed'); await unlink('/tmp/production-audit-write');`)
    })
  }
  await check('file processor has no network, database credentials or writable application filesystem', async () => {
    const id = (await compose('ps', '-q', 'file-processor')).trim()
    assert.equal((await command('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', id])).trim(),'none')
    assert.equal((await command('docker', ['inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', id])).trim(),'true')
    await exec('file-processor', `import assert from 'node:assert/strict'; assert.notEqual(process.getuid(),0); for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','JWT_SECRET','SMTP_APP_PASSWORD'])assert.equal(process.env[key],undefined);`)
  })
  await check('nginx runs without root and serves static files from a read-only filesystem', async () => {
    const id = (await compose('ps','-q','edge')).trim()
    assert.equal((await command('docker',['inspect','--format','{{.HostConfig.ReadonlyRootfs}}',id])).trim(),'true')
    assert.notEqual((await compose('exec','-T','edge','id','-u')).trim(),'0')
    await compose('exec','-T','edge','nginx','-t')
  })
  await runChecks({ origin, ca: await readFile(values.TLS_CERT_PATH), password, fixture, check, compose, exec, fixtureAction, output, root })
  const mail = await compose('logs', '--no-color', 'smtp'); assert.match(mail, /audit-mail-accepted/)
  results.checks.push({ name: 'production SMTP delivers only into the private TLS test sink', status: 'passed' })
  results.status = 'passed'
} catch (error) {
  results.status = 'failed'; results.failure = safe(error.message); console.error(results.failure)
  process.exitCode = 1
} finally {
  if (started) await compose('logs', '--no-color', '--tail', '150').then(log => writeFile(path.join(output, 'containers.log'), safe(log))).catch(() => {})
  try { await cleanup(); results.cleanup = 'removed audit containers, volumes, network and temporary credentials' }
  catch (error) { results.status = 'failed'; results.cleanup = safe(error.message); process.exitCode = 1 }
  results.finishedAt = new Date().toISOString(); await writeReport(output, results)
  console.log('Results saved to ' + path.relative(root, path.join(output, 'report.json')))
}
