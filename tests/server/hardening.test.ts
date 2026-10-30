import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import nodemailer from 'nodemailer'
import { validateProductionConfig } from '../../src/server/production-config.ts'
import { checkDatabasePolicy } from '../../src/server/database-policy.ts'
import { createDatabaseBackup, libpqEnvironment } from '../../scripts/database-backup.ts'
import { drainHttpServer } from '../../src/server/http-drain.ts'
import { getSmtpOptions } from '../../src/server/mail/transport.ts'
import { PrismaClient } from '../../src/generated/prisma/client.ts'
import { SequentialPrismaPg } from '../../src/server/prisma-pg.ts'

it('rejects placeholder secrets, insecure storage and malformed production origins before serving requests', () => {
  const valid = { NODE_ENV: 'production', DB_TIMEZONE: 'UTC', JWT_SECRET: randomBytes(32).toString('hex'), INVITE_CODE_SECRET: randomBytes(32).toString('hex'), METRICS_TOKEN: randomBytes(32).toString('hex'), APP_ORIGIN: 'https://staffly.test', STORAGE_DRIVER: 's3', SMTP_USER: 'test', SMTP_APP_PASSWORD: 'test' }
  assert.doesNotThrow(() => validateProductionConfig(valid))
  for (const patch of [
    { JWT_SECRET: 'replace-with-a-random-secret-of-at-least-32-characters' }, { JWT_SECRET: 'x'.repeat(64) }, { INVITE_CODE_SECRET: '' }, { METRICS_TOKEN: valid.JWT_SECRET },
    { APP_ORIGIN: 'http://staffly.test' }, { APP_ORIGIN: 'https://staffly.test/app' }, { APP_ORIGIN: 'https://staffly.test/' }, { APP_ORIGIN: 'https://user:pass@staffly.test' },
    { S3_ALLOW_INSECURE: 'true' }, { S3_ENDPOINT: 'http://minio:9000' }, { STORAGE_DRIVER: 'local' }, { DB_TIMEZONE: 'Europe/Kiev' },
  ]) assert.throws(() => validateProductionConfig({ ...valid, ...patch }))
})

it('refuses SMTP credentials over a server that does not support STARTTLS', async () => {
  let commands = ''
  const server = tcpServer(socket => {
    socket.write('220 test.example ESMTP\r\n')
    socket.on('data', part => {
      commands += part
      if (part.toString().startsWith('EHLO')) socket.write('250-test.example\r\n250 AUTH PLAIN LOGIN\r\n')
      else if (part.toString().startsWith('STARTTLS')) socket.write('502 TLS unavailable\r\n')
      else socket.end('221 bye\r\n')
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const transport = nodemailer.createTransport({ ...getSmtpOptions({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String((server.address() as { port: number }).port), SMTP_USER: 'private-account', SMTP_APP_PASSWORD: 'private-password' }), connectionTimeout: 2000 })
  try { await assert.rejects(transport.verify()); assert.match(commands, /STARTTLS/); assert.doesNotMatch(commands, /AUTH|private-account|private-password/) }
  finally { transport.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('closes the listener immediately and drains a response lasting longer than the old four-second limit', { timeout: 10000 }, async () => {
  let entered!: () => void
  const active = new Promise<void>(resolve => { entered = resolve })
  const server = createServer((_request, response) => { entered(); setTimeout(() => response.end('committed'), 4200) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const response = fetch(url)
  try {
    await active
    const stopped = drainHttpServer(server)
    assert.equal(server.listening, false)
    assert.equal(await (await response).text(), 'committed')
    await stopped
  } finally { server.closeAllConnections(); server.close() }
})

async function command(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', part => { log += part }); child.stderr.on('data', part => { log += part })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, log.replaceAll(env.APP_DATABASE_PASSWORD ?? 'unused-secret', '[redacted]').replaceAll(env.MIGRATION_DATABASE_PASSWORD ?? 'unused-secret', '[redacted]'))
}

it('runs real migrations as a schema owner, grants runtime CRUD and denies DDL, role changes and migration tampering', { skip: process.env.ISOLATED_TEST_CLUSTER !== 'true', timeout: 30000 }, async () => {
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, '/staffly_test')
  const admin = new Pool({ connectionString: process.env.DATABASE_URL })
  const directory = await mkdtemp(path.join(tmpdir(), 'staffly-policy-'))
  const db = `staffly_policy_${randomUUID().replaceAll('-', '')}`
  const migrationUrl = new URL(process.env.DATABASE_URL!), appUrl = new URL(migrationUrl)
  migrationUrl.pathname = '/' + db; appUrl.pathname = '/' + db
  migrationUrl.username = 'staffly_migrator'; appUrl.username = 'staffly_app'
  migrationUrl.password = randomBytes(24).toString('hex'); appUrl.password = randomBytes(24).toString('hex')
  const env = { ...process.env, POSTGRES_DB: db, APP_DATABASE_PASSWORD: appUrl.password, MIGRATION_DATABASE_PASSWORD: migrationUrl.password }
  let app: Pool | undefined
  let migrated: Pool | undefined
  let restored: Pool | undefined
  let client: PrismaClient | undefined
  const restoredDb = db + '_restore'
  try {
    await admin.query(`CREATE DATABASE ${db}`)
    await admin.query(`ALTER DATABASE ${db} SET timezone = 'UTC'`)
    const bootstrapUrl = new URL(process.env.DATABASE_URL!); bootstrapUrl.pathname = '/' + db
    await command(path.join(process.env.PG_BIN!, 'psql'), [bootstrapUrl.toString(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'deploy/init-database.sql'], env)
    const config = path.join(directory, 'prisma.config.mjs')
    await writeFile(config, `export default ${JSON.stringify({ schema: path.resolve('prisma/schema.prisma'), migrations: { path: path.resolve('prisma/migrations') }, datasource: { url: migrationUrl.toString() } })}`)
    await command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config], env)
    migrated = new Pool({ connectionString: migrationUrl.toString() })
    await migrated.query(await readFile('deploy/runtime-grants.sql', 'utf8'))
    app = new Pool({ connectionString: appUrl.toString() })
    const timezone = (await app.query('SHOW TIME ZONE')).rows[0].TimeZone
    assert.equal(timezone, 'UTC')
    await checkDatabasePolicy(app, timezone)
    await assert.rejects(checkDatabasePolicy(admin, timezone), /data access only/)
    await assert.rejects(checkDatabasePolicy(app, 'unconfigured-timezone'), /timezone/)
    // Exercise the real Prisma adapter and real timestamptz storage in UTC:
    // explicit JS dates, defaults, range filters and native pg must agree.
    client = new PrismaClient({ adapter: new SequentialPrismaPg(app, { disposeExternalPool: false }) })
    const roundTripAt = new Date(Date.now() + 60000)
    const fixture = await client.user.create({ data: { email: 'utc-round-trip@example.test', emailVerifiedAt: roundTripAt } })
    assert.equal(fixture.emailVerifiedAt?.toISOString(), roundTripAt.toISOString())
    assert.ok(Math.abs(fixture.createdAt.getTime() - Date.now()) < 2000)
    const native = (await app.query('SELECT email_verified_at FROM users WHERE id = $1', [fixture.id])).rows[0].email_verified_at as Date
    assert.equal(native.toISOString(), roundTripAt.toISOString())
    assert.equal(await client.user.count({ where: { id: fixture.id, emailVerifiedAt: { gt: new Date(roundTripAt.getTime() - 1) } } }), 1)
    await client.user.delete({ where: { id: fixture.id } })
    const id = randomUUID()
    await app.query('INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())', [id, 'limited@example.test'])
    await app.query('UPDATE users SET first_name = $1 WHERE id = $2', ['Limited', id])
    assert.equal((await app.query('SELECT first_name FROM users WHERE id = $1', [id])).rows[0].first_name, 'Limited')
    for (const sql of ['CREATE TABLE public.forbidden (id int)', 'ALTER TABLE public.users ADD COLUMN forbidden int', 'DROP TABLE public.users CASCADE', 'TRUNCATE public.users CASCADE', 'DELETE FROM public._prisma_migrations', 'CREATE ROLE forbidden', 'SET ROLE staffly_migrator', 'UPDATE organization_resource_budgets SET storage_limit_bytes=999999999999', 'UPDATE organization_resource_budgets SET storage_bytes=0', 'UPDATE organization_resource_budgets SET email_queue_limit=100000', 'DELETE FROM organization_resource_budgets']) await assert.rejects(app.query(sql), { code: '42501' })
    // Exercise quota triggers with the actual restricted runtime role as well.
    const org = await client.organization.create({ data: { name: 'Runtime quotas', timezone: 'Europe/Moscow', createdByUserId: id } })
    await migrated.query('UPDATE organization_resource_budgets SET storage_limit_bytes=12,email_queue_limit=1 WHERE organization_id=$1', [org.id])
    const fileData = { organizationId: org.id, uploadedByUserId: id, purpose: 'DOCUMENT' as const, size: 12, mimeType: 'text/plain', checksumSha256: '0'.repeat(64) }
    const file = await client.storedFile.create({ data: { ...fileData, objectKey: `runtime/${randomUUID()}` } })
    await assert.rejects(client.storedFile.create({ data: { ...fileData, objectKey: `runtime/${randomUUID()}` } }), /ORGANIZATION_STORAGE_QUOTA_EXCEEDED/)
    await client.emailDelivery.createMany({ data: Array.from({ length: 2 }, () => ({ userId: id, organizationId: org.id, sourceKey: `runtime:${randomUUID()}`, sourceKind: 'DOCUMENT_REMINDER', category: 'documents' })) })
    const usage = await client.organizationResourceBudget.findUniqueOrThrow({ where: { organizationId: org.id } })
    assert.equal(usage.storageBytes, 12n); assert.equal(usage.pendingEmails, 1)
    assert.equal(await client.emailDelivery.count({ where: { organizationId: org.id, status: 'SKIPPED', skipReason: 'ORGANIZATION_QUEUE_QUOTA' } }), 1)
    await client.organizationResourceBudget.update({ where: { organizationId: org.id }, data: { lastEmailAt: new Date(), offerCheckCursor: randomUUID(), requestCheckCursor: randomUUID() } })
    await client.storedFile.delete({ where: { id: file.id } })
    await client.emailDelivery.deleteMany({ where: { organizationId: org.id } })
    const released = await client.organizationResourceBudget.findUniqueOrThrow({ where: { organizationId: org.id } })
    assert.equal(released.storageBytes, 0n); assert.equal(released.pendingEmails, 0)
    await client.organization.delete({ where: { id: org.id } })
    assert.equal((await app.query('DELETE FROM users WHERE id = $1', [id])).rowCount, 1)
    await migrated.query('CREATE TABLE public.future_table (id int)')
    await app.query('INSERT INTO public.future_table VALUES (1)')
    const dump = path.join(directory, 'backup.dump')
    await createDatabaseBackup({ databaseUrl: migrationUrl.toString(), pgBin: process.env.PG_BIN, file: dump })
    await assert.rejects(createDatabaseBackup({ databaseUrl: migrationUrl.toString(), pgBin: process.env.PG_BIN, file: dump }), { code: 'EEXIST' })
    await admin.query(`CREATE DATABASE ${restoredDb} OWNER staffly_migrator`)
    const restoredUrl = new URL(migrationUrl); restoredUrl.pathname = '/' + restoredDb
    restored = new Pool({ connectionString: restoredUrl.toString() })
    await command(path.join(process.env.PG_BIN!, 'pg_restore'), ['--dbname', restoredDb, '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', dump], { ...env, ...libpqEnvironment(restoredUrl.toString()) })
    assert.equal((await restored.query('SELECT id FROM public.future_table')).rows[0].id, 1)
    assert.ok((await restored.query('SELECT count(*) FROM public._prisma_migrations')).rows[0].count >= 48)
  } finally {
    await client?.$disconnect(); await app?.end(); await migrated?.end(); await restored?.end()
    await admin.query(`DROP DATABASE IF EXISTS ${restoredDb} WITH (FORCE)`)
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await admin.query('DROP ROLE IF EXISTS staffly_app, staffly_migrator')
    await admin.end(); await rm(directory, { recursive: true, force: true })
  }
})
