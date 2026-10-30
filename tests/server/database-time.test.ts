import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { PrismaClient } from '../../src/generated/prisma/client.ts'
import { SequentialPrismaPg } from '../../src/server/prisma-pg.ts'
import { utcDatabaseUrl, checkTimeModel } from '../../src/server/database-time.ts'
import { isCalendarDate, addCalendarDateDays, wallClockToInstant } from '../../src/shared/date-time.ts'
import { localDateTimeIso } from '../../src/app/schedule/date-utils.ts'
import { zonedDateTimeToUtc, startOfZonedDate } from '../../src/server/schedule/timezone.ts'
import { planTimeMigration, applyTimeMigration } from '../../scripts/database-time-migration.ts'
import { createDatabaseBackup } from '../../scripts/database-backup.ts'

it('keeps date-only values independent of clock zones and validates real calendar dates', () => {
  for (const date of ['2024-02-29', '2030-01-01', '0001-01-01']) assert.equal(isCalendarDate(date), true)
  for (const date of ['0000-01-01', '2026-02-29', '2026-04-31', '2026-1-01', '2026-01-01T00:00:00Z']) assert.equal(isCalendarDate(date), false)
  assert.equal(addCalendarDateDays('2024-02-28', 2), '2024-03-01')
  assert.equal(addCalendarDateDays('2026-12-31', 1), '2027-01-01')
  assert.throws(() => wallClockToInstant('2026-02-30', '10:00', 'UTC'))
  assert.throws(() => wallClockToInstant('2026-02-28', '24:00', 'UTC'))
})

it('uses identical UI/server conversion, explicit DST-overlap policy and real elapsed day lengths', () => {
  const cases = [
    ['2026-10-29', '09:00', 'Europe/Moscow', '2026-10-29T06:00:00.000Z'],
    ['2026-01-01', '01:00', 'Asia/Vladivostok', '2025-12-31T15:00:00.000Z'],
    ['2026-01-01', '00:15', 'Pacific/Kiritimati', '2025-12-31T10:15:00.000Z'],
    ['2026-01-01', '00:15', 'Asia/Kathmandu', '2025-12-31T18:30:00.000Z'],
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00.000Z'],
    ['2026-04-05', '01:45', 'Australia/Lord_Howe', '2026-04-04T14:45:00.000Z'],
  ]
  for (const [date, time, zone, expected] of cases) {
    assert.equal(zonedDateTimeToUtc(date, time, zone).toISOString(), expected)
    assert.equal(localDateTimeIso(date, time, zone), expected)
  }
  for (const [date, time, zone] of [['2026-03-08', '02:30', 'America/New_York'], ['2026-10-04', '02:15', 'Australia/Lord_Howe']]) {
    assert.throws(() => localDateTimeIso(date, time, zone))
    assert.throws(() => zonedDateTimeToUtc(date, time, zone), { code: 'INVALID_LOCAL_TIME' })
  }
  assert.equal(+startOfZonedDate('2026-03-09', 'America/New_York') - +startOfZonedDate('2026-03-08', 'America/New_York'), 23 * 3600000)
  assert.equal(+startOfZonedDate('2026-11-02', 'America/New_York') - +startOfZonedDate('2026-11-01', 'America/New_York'), 25 * 3600000)
  assert.equal(startOfZonedDate('2026-09-06', 'America/Santiago').toISOString(), '2026-09-06T04:00:00.000Z')
  assert.throws(() => startOfZonedDate('2011-12-30', 'Pacific/Apia'), { code: 'INVALID_LOCAL_TIME' })
})

async function command(binary: string, args: string[], env = process.env) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', part => { log += part }); child.stderr.on('data', part => { log += part })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, log.slice(-2000))
}

it('keeps date-picker calendar days stable across browser zones, including a locally skipped day', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {calendarKey, parseCalendarDate, calendarDate} from './src/component/ui/date-picker/calendar-date.ts';
    for (const value of ['2011-12-29','2011-12-30','2011-12-31','2026-03-08','2026-11-01']) {
      assert.equal(calendarKey(parseCalendarDate(value)),value);
      assert.equal(parseCalendarDate(value).toLocaleDateString('en-CA',{timeZone:'UTC'}),value);
    }
    const day=calendarDate(2011,11,29);day.setUTCDate(day.getUTCDate()+1);assert.equal(calendarKey(day),'2011-12-30');
    assert.equal(calendarKey(calendarDate(1,0,1)),'0001-01-01');
  `
  for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Apia', 'Pacific/Kiritimati']) {
    await command(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { ...process.env, TZ: zone })
  }
})

it('pins ORM/raw SQL to UTC on every connection regardless of server and process timezone', async () => {
  const url = new URL(process.env.DATABASE_URL!)
  url.searchParams.set('options', '-c timezone=Asia/Tokyo')
  const pool = new Pool({ connectionString: utcDatabaseUrl(url.toString()), max: 3 })
  const client = new PrismaClient({ adapter: new SequentialPrismaPg(pool, { disposeExternalPool: true }) })
  let id: string | undefined
  try {
    const connections = await Promise.all(Array.from({ length: 3 }, () => pool.connect()))
    try {
      for (const connection of connections) assert.equal((await connection.query('SHOW TIME ZONE')).rows[0].TimeZone, 'UTC')
    } finally { connections.forEach(connection => connection.release()) }
    await checkTimeModel(pool)
    const instant = new Date('2026-07-01T06:07:08.123Z')
    const row = await client.user.create({ data: { email: `utc-${randomUUID()}@example.test`, emailVerifiedAt: instant } }); id = row.id
    const native = (await pool.query('SELECT email_verified_at,created_at FROM users WHERE id=$1', [id])).rows[0]
    assert.equal(native.email_verified_at.toISOString(), instant.toISOString())
    assert.equal(row.emailVerifiedAt!.toISOString(), instant.toISOString())
    assert.ok(Math.abs(+row.createdAt - Date.now()) < 2000)
    assert.equal(native.created_at.toISOString(), row.createdAt.toISOString())
    const sql = await client.$queryRaw<Array<{ at: Date }>>`SELECT ${instant}::timestamptz AS at`
    assert.equal(sql[0].at.toISOString(), instant.toISOString())
    const fresh = await client.$transaction(tx => tx.user.findFirstOrThrow({ where: { id, emailVerifiedAt: { gte: instant, lt: new Date(+instant + 1) } } }))
    assert.equal(fresh.id, id)
  } finally { if (id) await client.user.delete({ where: { id } }); await client.$disconnect() }
})

it('converts a restored legacy copy atomically, preserves business dates/JSON and SQL-clock state, and rejects stale plans or a second conversion',
  { skip: process.env.ISOLATED_TEST_CLUSTER !== 'true', timeout: 60000 }, async () => {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  const name = 'staffly_dates_' + randomUUID().replaceAll('-', '')
  const copy = name + '_copy', directory = await mkdtemp(path.join(tmpdir(), 'staffly-dates-'))
  const url = new URL(process.env.DATABASE_URL!); url.pathname = '/' + name
  const copyUrl = new URL(url); copyUrl.pathname = '/' + copy
  let old: PrismaClient | undefined, canonical: PrismaClient | undefined
  let source: Pool | undefined, target: Pool | undefined
  try {
    await admin.query(`CREATE DATABASE ${name}`)
    const config = path.join(directory, 'prisma.config.mjs')
    await writeFile(config, `export default ${JSON.stringify({ schema: path.resolve('prisma/schema.prisma'), migrations: { path: path.resolve('prisma/migrations') }, datasource: { url: url.toString() } })}`)
    await command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config])
    await admin.query(`ALTER DATABASE ${name} SET timezone='Europe/Kiev'`)
    source = new Pool({ connectionString: url.toString(), max: 1 })
    await source.query("UPDATE app_time_model SET version='legacy-v0',source_timezone='Europe/Kiev',converted_at=NULL")
    old = new PrismaClient({ adapter: new SequentialPrismaPg(source, { disposeExternalPool: false }) })
    const user = await old.user.create({ data: { email: 'legacy@example.test', emailVerifiedAt: new Date('2026-07-01T06:07:08.123Z'), emailNotificationsEnabled: false } })
    const org = await old.organization.create({ data: { name: 'Date migration', timezone: 'Asia/Vladivostok', createdByUserId: user.id } })
    const member = await old.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'OWNER' } })
    const location = await old.organizationLocation.create({ data: { organizationId: org.id, name: 'Point', city: 'Test', address: 'Test', timezone: 'Asia/Vladivostok' } })
    for (const [start, end] of [['2026-07-01T06:00:00Z', '2026-07-01T14:00:00Z'], ['2026-07-01T14:00:00Z', '2026-07-01T22:00:00Z'], ['2026-12-01T06:00:00Z', '2026-12-01T14:00:00Z']]) {
      await old.workShift.create({ data: { organizationId: org.id, locationId: location.id, memberId: member.id, createdByMemberId: member.id, scheduledStartAt: new Date(start), scheduledEndAt: new Date(end) } })
    }
    const type = await old.requestType.create({ data: { organizationId: org.id, name: 'Vacation', dateMode: 'RANGE', systemCode: 'VACATION' } })
    await old.organizationRequest.create({ data: { organizationId: org.id, locationId: location.id, createdByMemberId: member.id, requestTypeId: type.id,
      typeNameSnapshot: 'Vacation', startDate: new Date('2026-12-10'), endDate: new Date('2026-12-12'), dueAt: new Date('2026-12-01T14:05:06.789Z'),
      answers: { start_at: 'keep opaque JSON', date: '2026-12-10' } } })
    await old.authSession.create({ data: { userId: user.id, refreshTokenHash: 'legacy-hash', idleExpiresAt: new Date('2030-01-01T00:00:00Z'), absoluteExpiresAt: new Date('2031-01-01T00:00:00Z') } })
    const before = { users: await old.user.findMany(), shifts: await old.workShift.findMany({ orderBy: { id: 'asc' } }), requests: await old.organizationRequest.findMany(), sessions: await old.authSession.findMany() }
    const observed = (await source.query('SELECT email_verified_at FROM users WHERE id=$1', [user.id])).rows[0].email_verified_at
    assert.notEqual(observed.toISOString(), user.emailVerifiedAt!.toISOString(), 'The fixture must reproduce the actual legacy adapter bug')
    await source.query("INSERT INTO api_rate_limits(key,hits,reset_at) VALUES ('test',3,'2030-01-01T12:00:00Z')")
    await old.$disconnect(); old = undefined
    const dump = path.join(directory, 'legacy.dump')
    await createDatabaseBackup({ databaseUrl: url.toString(), pgBin: process.env.PG_BIN, file: dump })
    await admin.query(`CREATE DATABASE ${copy}`)
    const { libpqEnvironment } = await import('../../scripts/database-backup.ts')
    await command(path.join(process.env.PG_BIN!, 'pg_restore'), ['--dbname', copy, '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', dump], { ...process.env, ...libpqEnvironment(copyUrl.toString()) })
    target = new Pool({ connectionString: copyUrl.toString(), max: 1 })
    // An old pre-model backup restored on a UTC server has unknown provenance.
    // Only an explicit original zone may unlock planning; target UTC is no proof.
    await target.query('ALTER TABLE app_time_model DROP CONSTRAINT app_time_model_ready_provenance')
    await target.query("UPDATE app_time_model SET version='utc-v1',source_timezone='UTC',converted_at=now()")
    await target.query(await readFile('prisma/migrations/20261029073000_time_model_provenance/migration.sql', 'utf8'))
    assert.deepEqual((await target.query('SELECT version,source_timezone FROM app_time_model')).rows[0], { version: 'legacy-v0', source_timezone: null })
    await assert.rejects(planTimeMigration(target), /source timezone is unknown/)
    const plan = await planTimeMigration(target, 'Europe/Kiev')
    await assert.rejects(checkTimeModel(target))
    await target.query("UPDATE users SET first_name='stale-plan-test'")
    await assert.rejects(applyTimeMigration(target, plan, dump), /Data changed/)
    assert.equal((await target.query('SELECT version FROM app_time_model')).rows[0].version, 'legacy-v0')
    await target.query('UPDATE users SET first_name=NULL')
    const corrupt = structuredClone(plan); corrupt.tables.find(table => table.name === 'work_shifts')!.after = 'invalid'
    await assert.rejects(applyTimeMigration(target, corrupt, dump), /Post-conversion verification failed/)
    assert.equal((await target.query('SELECT version FROM app_time_model')).rows[0].version, 'legacy-v0')
    const converted = await applyTimeMigration(target, plan, dump)
    assert.equal(converted.sourceTimezone, 'Europe/Kiev')
    await assert.rejects(applyTimeMigration(target, plan, dump), /must not be repeated/)
    const triggers = (await target.query("SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D'")).rows[0].count
    assert.equal(triggers, 0)
    assert.equal((await target.query('SELECT reset_at FROM api_rate_limits')).rows[0].reset_at.toISOString(), '2030-01-01T12:00:00.000Z')
    await target.end(); target = undefined
    target = new Pool({ connectionString: utcDatabaseUrl(copyUrl.toString()), max: 1 })
    await checkTimeModel(target)
    canonical = new PrismaClient({ adapter: new SequentialPrismaPg(target, { disposeExternalPool: false }) })
    const after = { users: await canonical.user.findMany(), shifts: await canonical.workShift.findMany({ orderBy: { id: 'asc' } }), requests: await canonical.organizationRequest.findMany(), sessions: await canonical.authSession.findMany() }
    assert.deepEqual(after, before)
    assert.equal((await target.query('SELECT email_verified_at FROM users WHERE id=$1', [user.id])).rows[0].email_verified_at.toISOString(), user.emailVerifiedAt!.toISOString())
    assert.equal((await source.query('SELECT version FROM app_time_model')).rows[0].version, 'legacy-v0', 'The source database remains untouched')
  } finally {
    await old?.$disconnect(); await canonical?.$disconnect(); await source?.end(); await target?.end()
    for (const db of [copy, name]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await admin.end(); await rm(directory, { recursive: true, force: true })
  }
})
