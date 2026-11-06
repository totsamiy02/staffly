import assert from 'node:assert/strict'
import { hash } from 'argon2'

// Mounted only into the disposable audit containers. Never loads a host .env.
assert.equal(process.env.PRODUCTION_AUDIT, 'true')
assert.equal(new URL(process.env.DATABASE_URL!).hostname, 'postgres')
assert.equal(new URL(process.env.DATABASE_URL!).username, 'staffly_app')
// Check the target before importing any module that can open a DB connection.
const { prisma, databasePool } = await import('../../src/server/db.ts')
const { createOrganization } = await import('../../src/server/organizations/organization-service.ts')
const { deliverEmail } = await import('../../src/server/mail/transport.ts')
try {
  const action = process.argv[2]
  if (action === 'seed') {
    const passwordHash = await hash(process.env.AUDIT_PASSWORD!)
    const owner = await prisma.user.create({ data: { email: 'owner@example.test', firstName: 'ПродакшенАудит', passwordHash, emailVerifiedAt: new Date() } })
    const employee = await prisma.user.create({ data: { email: 'employee@example.test', firstName: 'ПолучательАудита', passwordHash, emailVerifiedAt: new Date() } })
    const org = await createOrganization(owner.id, { name: 'Production audit', description: null, timezone: 'Europe/Moscow', initialPlan: 'TRIAL' })
    const member = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } })
    const recipient = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: employee.id } })
    await prisma.locationMember.create({ data: { organizationId: org.id, locationId: org.locationId!, memberId: recipient.id } })
    const date = new Date().toISOString().slice(0, 7) + '-02'
    await prisma.workShift.create({ data: { organizationId: org.id, locationId: org.locationId!, memberId: member.id, createdByMemberId: member.id, scheduledStartAt: new Date(date + 'T06:00:00Z'), scheduledEndAt: new Date(date + 'T14:00:00Z'), actualStartAt: new Date(date + 'T06:00:00Z'), actualEndAt: new Date(date + 'T14:00:00Z') } })
    await deliverEmail('owner@example.test', { title: 'Production audit', intro: 'Synthetic local delivery only.' })
    console.log(JSON.stringify({ organizationId: org.id, locationId: org.locationId, memberId: member.id, employeeId: recipient.id, date }))
  } else if (action === 'permissions') {
    const role = (await databasePool.query('SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    assert.equal(role.name, 'staffly_app')
    assert.equal(role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolbypassrls, false)
    for (const sql of ['CREATE TABLE public.audit_forbidden (id int)', 'ALTER TABLE public.users ADD COLUMN audit_forbidden int', 'CREATE ROLE audit_forbidden', 'SET ROLE staffly_migrator', 'DELETE FROM public._prisma_migrations', 'UPDATE public.security_events SET reason_code=NULL', 'UPDATE public.organization_resource_budgets SET storage_limit_bytes=1']) {
      await assert.rejects(databasePool.query(sql), { code: '42501' })
    }
    console.log(JSON.stringify({ runtimeRole: role.name, deniedOperations: 7 }))
  } else if (action === 'revoke') {
    const fixture = JSON.parse(process.env.AUDIT_FIXTURE!)
    await prisma.locationMember.updateMany({ where: { memberId: fixture.employeeId }, data: { leftAt: new Date() } })
    await prisma.organizationMember.update({ where: { id: fixture.employeeId }, data: { leftAt: new Date() } })
    console.log(JSON.stringify({ revoked: true }))
  } else if (action === 'export-count') {
    console.log(JSON.stringify({ count: await prisma.reportExport.count() }))
  } else throw new Error('Unknown audit fixture action')
} finally {
  await prisma.$disconnect()
}
