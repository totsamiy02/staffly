// Explicit rehearsal only; deliberately excluded from the normal *.test.ts suite.
// Run through load-test.mjs with --tests=only --test-file=tests/operations/database-time.rehearsal.ts --legacy-backup=...
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import ExcelJS from 'exceljs'
import { Prisma, PrismaClient } from '../../src/generated/prisma/client.ts'
import { SequentialPrismaPg } from '../../src/server/prisma-pg.ts'
import { utcDatabaseUrl, checkTimeModel } from '../../src/server/database-time.ts'
import { planTimeMigration, applyTimeMigration } from '../../scripts/database-time-migration.ts'
import { createDatabaseBackup, libpqEnvironment } from '../../scripts/database-backup.ts'
import { buildReport, previewReport, reportWorkbook } from '../../src/server/schedule/reports/report-service.ts'
import { defaultReportConfig, type ReportInput } from '../../src/app/schedule/reports/reporting.ts'
import { zonedDateTimeToUtc } from '../../src/server/schedule/timezone.ts'

const zone = 'Europe/Kiev' // Confirmed original provenance; never inferred from the restored server.
const fixedNow = new Date('2026-10-29T06:53:18.979Z')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v)).digest('hex')
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
type Client = InstanceType<typeof PrismaClient>
type Case = { label: string; user: string; org: string; input: ReportInput; minutes?: number }
const input = (from: string, to: string, locationIds: string[] = []): ReportInput => ({ from, to, locationIds, memberIds: [], includeFormer: true, config: defaultReportConfig() })

async function command(binary: string, args: string[], env = process.env) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', part => { log += part }); child.stderr.on('data', part => { log += part })
  const [code] = await once(child, 'exit')
  // Restore errors can contain original personal data. Keep those out of test artifacts.
  assert.equal(code, 0, `${path.basename(binary)} failed; inspect the private backup locally`)
  return log
}
async function snapshot(client: Client) {
  const result: Record<string, { rows: number; sha256: string }> = {}
  for (const name of Object.values(Prisma.ModelName)) {
    if (['DatabaseTimeModel', 'ApiRateLimit', 'EmailDelivery', 'OrganizationResourceBudget'].includes(name)) continue
    const delegate = (client as unknown as Record<string, { findMany(): Promise<unknown[]> }>)[name[0].toLowerCase() + name.slice(1)]
    const rows = await delegate.findMany()
    result[name] = { rows: rows.length, sha256: digest(rows.map(row => digest(row)).sort()) }
  }
  return result
}
async function reports(client: Client, cases: Case[]) {
  const result: Record<string, unknown> = {}
  for (const c of cases) {
    let report
    try { report = await buildReport(c.user, c.org, c.input, fixedNow, 'reports.preview', client) }
    catch (error) {
      if (c.minutes !== undefined) throw error
      const code = (error as { code?: string }).code
      if (code !== 'SUBSCRIPTION_FEATURE_REQUIRED') throw error
      result[c.label] = { unavailable: code }; continue
    }
    if (c.minutes !== undefined) assert.equal(report.metrics.minutes, c.minutes, `${c.label}: independent expected elapsed time`)
    if (c.label.endsWith('/year-night-vacation')) {
      assert.equal(report.rows.absences.length, 1)
      assert.equal(report.rows.absences[0].days, 1)
      assert.equal((report.rows.absences[0].start as Date).toISOString().slice(0, 10), '2026-12-30')
      assert.equal((report.rows.absences[0].end as Date).toISOString().slice(0, 10), '2027-01-02')
    }
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await reportWorkbook(report)).buffer)
    const sheets = workbook.worksheets.map(sheet => ({ name: sheet.name, values: sheet.getSheetValues(), columns: sheet.columns.map(column => column.width), views: sheet.views }))
    result[c.label] = { metrics: report.metrics, rows: digest(report.rows), preview: digest(previewReport(report)), workbook: digest(sheets), sheets: sheets.length }
  }
  return result
}

async function fixtures(client: Client): Promise<Case[]> {
  const user = await client.user.create({ data: { email: 'rehearsal@example.test', emailVerifiedAt: fixedNow, emailNotificationsEnabled: false } })
  await client.authSession.create({ data: { userId: user.id, refreshTokenHash: 'rehearsal-only', idleExpiresAt: new Date('2030-01-01'), absoluteExpiresAt: new Date('2031-01-01') } })
  const org = await client.organization.create({ data: { name: 'Synthetic time rehearsal', timezone: 'Europe/Moscow', createdByUserId: user.id } })
  await client.organizationSubscription.update({ where: { organizationId: org.id }, data: { plan: 'BUSINESS', periodStart: new Date('2025-01-01'), periodEnd: new Date('2030-01-01') } })
  const owner = await client.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'OWNER', joinedAt: new Date('2025-01-01') } })
  const cases: Case[] = []
  for (const timezone of ['Europe/Kaliningrad', 'Europe/Moscow', 'Asia/Vladivostok', 'America/New_York']) {
    const employee = await client.user.create({ data: { email: randomUUID() + '@example.test', emailVerifiedAt: fixedNow, emailNotificationsEnabled: false } })
    const member = await client.organizationMember.create({ data: { organizationId: org.id, userId: employee.id, role: 'MEMBER', joinedAt: new Date('2025-01-01') } })
    await client.employeeAbsence.create({ data: { organizationId: org.id, memberId: member.id, type: 'VACATION', startDate: new Date('2026-12-30'), endDate: new Date('2027-01-02') } })
    const location = await client.organizationLocation.create({ data: { organizationId: org.id, name: timezone, timezone, city: 'Test', address: 'Test' } })
    await client.locationMember.create({ data: { organizationId: org.id, locationId: location.id, memberId: member.id, joinedAt: new Date('2025-01-01') } })
    const add = async (day: string, endDay: string, start: string, end: string, patch: object = {}) => client.workShift.create({ data: {
      organizationId: org.id, locationId: location.id, memberId: member.id, createdByMemberId: owner.id,
      scheduledStartAt: zonedDateTimeToUtc(day, start, timezone), scheduledEndAt: zonedDateTimeToUtc(endDay, end, timezone), breakMinutes: 30, ...patch,
    } })
    await add('2026-10-31', '2026-11-01', '22:00', '06:00')
    await add('2026-12-31', '2027-01-01', '22:00', '06:00')
    await add('2026-10-15', '2026-10-15', '09:00', '17:00', { attendance: 'PARTIAL', actualStartAt: zonedDateTimeToUtc('2026-10-15', '10:00', timezone), actualEndAt: zonedDateTimeToUtc('2026-10-15', '15:00', timezone), actualBreakMinutes: 120 })
    await add('2026-10-16', '2026-10-16', '09:00', '17:00', { attendance: 'NO_SHOW' })
    for (const [label, from, to, minutes] of [
      ['month-night', '2026-10-31', '2026-10-31', timezone === 'America/New_York' ? 540 : 480],
      ['year-night-vacation', '2026-12-31', '2026-12-31', 480],
      ['actual-with-paid-break', '2026-10-15', '2026-10-15', 300],
      ['no-show', '2026-10-16', '2026-10-16', 0],
      ['next-month-excludes-prior-night', '2026-11-01', '2026-11-01', 0],
    ] as const) cases.push({ label: timezone + '/' + label, user: user.id, org: org.id, input: input(from, to, [location.id]), minutes })
    if (timezone === 'America/New_York') {
      await add('2026-03-07', '2026-03-08', '22:00', '06:00')
      cases.push({ label: timezone + '/spring-DST-night', user: user.id, org: org.id, input: input('2026-03-07', '2026-03-07', [location.id]), minutes: 420 })
    }
  }
  const type = await client.requestType.create({ data: { organizationId: org.id, name: 'Vacation', dateMode: 'RANGE', systemCode: 'VACATION' } })
  const location = await client.organizationLocation.findFirstOrThrow({ where: { organizationId: org.id } })
  await client.organizationRequest.create({ data: { organizationId: org.id, locationId: location.id, createdByMemberId: owner.id, requestTypeId: type.id, typeNameSnapshot: 'Vacation', startDate: new Date('2026-12-30'), endDate: new Date('2027-01-02'), answers: { date: '2026-12-30', opaque: '2026-12-31T22:00:00+03:00' } } })
  return cases
}

it('rehearses real legacy restore, business/Excel equivalence, multi-zone edge cases and rollback without touching a working database', { timeout: 180000 }, async t => {
  assert.equal(process.env.ISOLATED_TEST_CLUSTER, 'true')
  assert.ok(process.env.TIME_REHEARSAL_BACKUP, 'Pass --legacy-backup explicitly')
  const original = process.env.TIME_REHEARSAL_BACKUP!, originalHash = digest(await readFile(original))
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, 'staffly_test')
  const directory = await mkdtemp(path.join(tmpdir(), 'staffly-time-rehearsal-')), databases: string[] = []
  const summary: Record<string, unknown> = { formatVersion: 1, originalBackup: path.basename(original), sourceTimezone: zone, workingDatabaseTouched: false }
  const make = async (backup?: string) => {
    const name = 'staffly_rehearsal_' + randomUUID().replaceAll('-', ''); databases.push(name)
    await admin.query(`CREATE DATABASE ${name}`)
    const url = new URL(process.env.DATABASE_URL!); url.pathname = '/' + name
    if (backup) await command(path.join(process.env.PG_BIN!, 'pg_restore'), ['--dbname', name, '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', backup], libpqEnvironment(url.toString()))
    const config = path.join(directory, name + '.mjs')
    await writeFile(config, `export default ${JSON.stringify({ schema: path.resolve('prisma/schema.prisma'), migrations: { path: path.resolve('prisma/migrations') }, datasource: { url: url.toString() } })}`, { mode: 0o600 })
    await command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config])
    return url
  }
  const open = (url: URL, timezone: string) => {
    const connection = new URL(url); connection.searchParams.set('options', '-c timezone=' + timezone)
    const pool = new Pool({ connectionString: connection.toString(), max: 1 })
    const client = new PrismaClient({ adapter: new SequentialPrismaPg(pool, { disposeExternalPool: true }) })
    return { pool, client, close: () => client.$disconnect() }
  }
  try {
    for (const scenario of ['restored-original', 'restored-report-check', 'synthetic-boundaries']) {
      const url = await make(scenario === 'synthetic-boundaries' ? undefined : original)
      let db = open(url, 'UTC')
      try {
        let cases: Case[]
        if (scenario === 'synthetic-boundaries') {
          await db.pool.query("UPDATE app_time_model SET version='legacy-v0',source_timezone='Europe/Kiev',converted_at=NULL")
          cases = await fixtures(db.client)
          // Encode the independently chosen business values in the actual old wall-clock representation.
          const encoding = await planTimeMigration(db.pool, zone)
          for (const table of encoding.tables) {
            const columns = table.columns.filter(column => column.mode === 'legacy-wall')
            if (columns.length) await db.pool.query(`UPDATE ${quote(table.name)} SET ${columns.map(column => `${quote(column.name)}=(${quote(column.name)} AT TIME ZONE 'UTC') AT TIME ZONE $1`).join(',')}`, [zone])
          }
        } else {
          assert.equal((await db.pool.query('SELECT version FROM app_time_model')).rows[0].version, 'legacy-v0')
          if (scenario === 'restored-report-check') {
            // A separate throwaway copy enables reports for existing business rows.
            // The untouched-entitlement scenario above still proves real plan/access behavior.
            await db.client.organizationSubscription.updateMany({ data: { plan: 'BUSINESS', periodStart: new Date('2025-01-01'), periodEnd: new Date('2030-01-01'), trialEndsAt: null, nextPlan: null, nextStartsAt: null, nextEndsAt: null } })
          }
          const owners = await db.client.organizationMember.findMany({ where: { role: 'OWNER', leftAt: null, user: { deletedAt: null }, organization: { deletedAt: null } } })
          cases = owners.map((owner, index) => ({ label: 'original-org-' + index, user: owner.userId, org: owner.organizationId, input: input('2026-01-01', '2026-12-31') }))
          assert.ok(cases.length, 'Real backup must contain an accessible organization')
        }
        await db.close(); db = open(url, zone)
        // Match the old application's date, without rewriting source subscriptions or report permissions.
        t.mock.timers.enable({ apis: ['Date'], now: fixedNow })
        let beforeReports
        try { beforeReports = await reports(db.client, cases) } finally { t.mock.timers.reset() }
        if (scenario === 'restored-report-check') assert.ok(Object.values(beforeReports).every(value => value && typeof value === 'object' && 'workbook' in value), 'Real business data must produce an Excel report on the explicitly enabled copy')
        const before = await snapshot(db.client)
        await db.close()
        const backup = path.join(directory, scenario + '.dump')
        await createDatabaseBackup({ databaseUrl: url.toString(), pgBin: process.env.PG_BIN, file: backup })
        const pool = new Pool({ connectionString: utcDatabaseUrl(url.toString()), max: 1 })
        let plan
        try {
          plan = await planTimeMigration(pool, zone)
          await applyTimeMigration(pool, plan, backup)
          await assert.rejects(applyTimeMigration(pool, plan, backup), /must not be repeated/)
          await assert.rejects(planTimeMigration(pool, zone), /already|utc-v1|must not/i)
          await checkTimeModel(pool)
        } finally { await pool.end() }
        db = open(url, 'UTC')
        assert.equal(digest(await snapshot(db.client)), digest(before), scenario + ': all business ORM values')
        t.mock.timers.enable({ apis: ['Date'], now: fixedNow })
        try { assert.equal(digest(await reports(db.client, cases)), digest(beforeReports), scenario + ': reports, previews, Excel and totals') } finally { t.mock.timers.reset() }
        await db.close()
        // Restore the exact pre-conversion checkpoint: this is the tested rollback path.
        const rollback = open(await make(backup), zone)
        try {
          assert.equal(digest(await snapshot(rollback.client)), digest(before), scenario + ': rollback restored values')
          assert.equal((await rollback.pool.query('SELECT version FROM app_time_model')).rows[0].version, 'legacy-v0')
        } finally { await rollback.close() }
        // Also prove a converted backup can be restored without a second time conversion.
        const convertedBackup = path.join(directory, scenario + '-utc.dump')
        await createDatabaseBackup({ databaseUrl: url.toString(), pgBin: process.env.PG_BIN, file: convertedBackup })
        const restored = open(await make(convertedBackup), 'UTC')
        try {
          await checkTimeModel(restored.pool)
          assert.equal(digest(await snapshot(restored.client)), digest(before), scenario + ': UTC backup round trip')
          // Execute the documented emergency procedure only on this disposable restored database.
          const runbook = await readFile('docs/CODEX_PROJECT_CONTEXT.md', 'utf8')
          const sql = runbook.match(/```sql\n(BEGIN;\nWITH revoked AS \([\s\S]*?COMMIT;)\n```/)?.[1]
          assert.ok(sql, 'Canonical incident procedure must be present')
          const active = (await restored.pool.query('SELECT count(*)::int AS count FROM auth_sessions WHERE revoked_at IS NULL')).rows[0].count
          if (scenario === 'synthetic-boundaries') assert.ok(active > 0)
          await restored.pool.query(sql)
          assert.equal((await restored.pool.query('SELECT count(*)::int AS count FROM auth_sessions WHERE revoked_at IS NULL')).rows[0].count, 0)
          assert.equal((await restored.pool.query("SELECT count FROM security_events WHERE reason_code='INCIDENT_CONTAINMENT' ORDER BY created_at DESC LIMIT 1")).rows[0].count, active)
        } finally { await restored.close() }
        summary[scenario] = { tables: plan!.tables.length, sqlRows: plan!.tables.reduce((sum, table) => sum + table.rows, 0), business: before, reports: beforeReports, rollback: 'passed', utcRestore: 'passed', secondConversion: 'refused', incidentSessionRevocation: 'passed' }
      } finally { await db.close() }
    }
    assert.equal(digest(await readFile(original)), originalHash)
    summary.status = 'passed'
    await writeFile(path.join(process.env.TIME_REHEARSAL_OUTPUT!, 'time-rehearsal.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 })
  } finally {
    t.mock.timers.reset()
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end(); await rm(directory, { recursive: true, force: true })
  }
})
