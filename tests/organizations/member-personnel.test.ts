import { listAccessRoles } from '../../src/server/organizations/access/access-service.ts';
import { listFormerMembers } from '../../src/server/organizations/member-archive.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/server/db.ts';
import { createOrganization, listMembersPage } from '../../src/server/organizations/organization-service.ts';
import { createBusinessOrganization } from '../support/business-organization.ts';
import { getMemberPersonnel, updateMemberPersonnel } from '../../src/server/organizations/member-personnel-service.ts';
import { personnelBody } from '../../src/shared/member-personnel.ts';
import { locationContext } from '../../src/server/organizations/location-context.ts';
import { adminOrganizationPersonnel, adminPersonnelHistory } from '../../src/server/admin/personnel.ts';
import { memberProfile } from '../../src/server/organizations/member-profile-service.ts';
import { saveLocation } from '../../src/server/organizations/location-service.ts';
import { locationBody } from '../../src/server/organizations/schemas.ts';
const code = (value: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === value;
const body = (patch: Record<string, unknown> = {}) => personnelBody.parse({
    mode: 'personnel',
    revision: 1,
    personnelFirstName: 'Иван',
    personnelLastName: 'Тестовый',
    personnelMiddleName: '',
    personnelNumber: 'A-01',
    workEmail: 'work@example.test',
    workPhone: '+7 (999) 123-45-67',
    ...patch
});
async function fixture() {
    const owner = await prisma.user.create({ data: {
            email: randomUUID() + '@example.test',
            emailVerifiedAt: new Date(),
            firstName: 'Владелец'
        } }), employee = await prisma.user.create({ data: {
            email: randomUUID() + '@example.test',
            firstName: 'Личное',
            lastName: 'Имя',
            phone: '+79990000000',
            emailVerifiedAt: new Date()
        } });
    const org = await createOrganization(owner.id, {
        name: 'Personnel fixture',
        description: null,
        timezone: 'Europe/Moscow'
    }), member = await prisma.organizationMember.create({ data: {
            organizationId: org.id,
            userId: employee.id
        } });
    await prisma.locationMember.create({ data: {
            organizationId: org.id,
            locationId: org.locationId,
            memberId: member.id
        } });
    const run = <T>(fn: () => Promise<T>) => locationContext.run({
        organizationId: org.id,
        locationId: org.locationId
    }, fn);
    return {
        owner,
        employee,
        org,
        member,
        run
    };
}
after(() => prisma.$disconnect());
test('an empty employee profile keeps the login nickname without publishing private contacts', async () => {
    const { owner, employee, org, member, run } = await fixture();
    await prisma.user.update({
        where: { id: employee.id },
        data: {
            firstName: null,
            lastName: null,
            middleName: null
        }
    });
    const nickname = employee.email.split('@')[0];
    const profile = await run(() => memberProfile(owner.id, org.id, member.id, {
        month: '2026-11',
        page: 1,
        section: 'overview',
        kind: 'personal',
        requestState: 'all'
    }));
    assert.equal(profile.member.displayName, nickname);
    assert.equal(profile.member.email, '');
    assert.equal(profile.member.phone, null);
    const list = await run(() => listMembersPage(owner.id, org.id, {}));
    assert.equal(list.members.find(m => m.id === member.id)?.displayName, nickname);
    await prisma.organizationMember.update({
        where: { id: member.id },
        data: { leftAt: new Date() }
    });
    const archive = await run(() => listFormerMembers(owner.id, org.id, {
        page: 1,
        pageSize: 20
    }));
    assert.equal(archive.members[0].displayName, nickname);
    assert.equal(archive.members[0].email, '');
});
test('fixed fields validate names and contacts; unknown keys and self personnel escalation are rejected', async () => {
    assert(!personnelBody.safeParse({
        ...body(),
        personnelFirstName: ''
    }).success);
    assert(!personnelBody.safeParse({
        ...body(),
        arbitraryField: 'x'
    }).success);
    assert(!personnelBody.safeParse({
        ...body(),
        workPhone: '+1 234'
    }).success);
    assert(!personnelBody.safeParse({
        ...body(),
        workEmail: 'invalid'
    }).success);
    const { owner, employee, org, member, run } = await fixture();
    await assert.rejects(run(() => updateMemberPersonnel(employee.id, org.id, member.id, body())), code('INSUFFICIENT_PERMISSIONS'));
    const ownerRole = await prisma.accessRole.findFirstOrThrow({ where: {
            organizationId: org.id,
            systemCode: 'OWNER'
        } });
    await prisma.accessRole.update({
        where: { id: ownerRole.id },
        data: { permissions: ownerRole.permissions.filter(p => !p.startsWith('members.personnel.')) }
    });
    const roles = (await listAccessRoles(owner.id, org.id)).roles;
    assert(roles.find(r => r.systemCode === 'OWNER')!.permissions.includes('members.personnel.edit'));
    assert(roles.filter(r => r.systemCode !== 'OWNER').every(r => !r.permissions.some(p => p.startsWith('members.personnel.'))));
    const read = await run(() => getMemberPersonnel(employee.id, org.id, member.id));
    assert.equal(read.record?.personnelFirstName, null);
    assert.equal(read.capabilities.contacts, true);
    assert.equal(read.capabilities.edit, false);
});
test('organizational names and contacts never overwrite the account and differ between organizations', async () => {
    const { owner, employee, org, member, run } = await fixture();
    await run(() => updateMemberPersonnel(owner.id, org.id, member.id, body()));
    const user = await prisma.user.findUniqueOrThrow({ where: { id: employee.id } });
    assert.equal(user.firstName, 'Личное');
    assert.equal(user.phone, '+79990000000');
    assert.equal(user.email, employee.email);
    const other = await createOrganization(owner.id, {
        name: 'Other personnel',
        description: null,
        timezone: 'Europe/Moscow'
    }), second = await prisma.organizationMember.create({ data: {
            organizationId: other.id,
            userId: employee.id
        } });
    await assert.rejects(run(() => getMemberPersonnel(owner.id, org.id, second.id)), code('MEMBER_NOT_FOUND'));
    assert.equal(second.personnelFirstName, null);
    assert.equal(second.workEmail, null);
    const profile = await run(() => memberProfile(owner.id, org.id, member.id, {
        month: '2026-11',
        page: 1,
        section: 'overview',
        kind: 'personal',
        requestState: 'all'
    }));
    assert.equal(profile.member.email, 'work@example.test');
    assert.equal(profile.member.phone, '+79991234567');
});
test('employee can change only own working contacts even before personnel names are completed', async () => {
    const { employee, org, member, run } = await fixture(), input = personnelBody.parse({
        mode: 'contacts',
        revision: 1,
        workEmail: 'Employee@Example.test',
        workPhone: ''
    });
    await run(() => updateMemberPersonnel(employee.id, org.id, member.id, input));
    const saved = await prisma.organizationMember.findUniqueOrThrow({ where: { id: member.id } });
    assert.equal(saved.workEmail, 'employee@example.test');
    assert.equal(saved.personnelFirstName, null);
    const own = (await run(() => getMemberPersonnel(employee.id, org.id, member.id)));
    assert.equal(own.record?.workEmail, 'employee@example.test');
    await assert.rejects(run(() => getMemberPersonnel(employee.id, org.id, member.id, 1)), code('INSUFFICIENT_PERMISSIONS'));
    const ownerMember = await prisma.organizationMember.findFirstOrThrow({ where: {
            organizationId: org.id,
            userId: org.createdByUserId
        } });
    await assert.rejects(run(() => updateMemberPersonnel(employee.id, org.id, ownerMember.id, input)), code('INSUFFICIENT_PERMISSIONS'));
});
test('retry creates one audit event, conflicting revisions fail and personnel numbers remain unique per organization', async () => {
    const { owner, employee, org, member, run } = await fixture(), input = body();
    const [a, b] = await Promise.all([run(() => updateMemberPersonnel(owner.id, org.id, member.id, input)), run(() => updateMemberPersonnel(owner.id, org.id, member.id, input))]);
    assert.equal(a.record.personnelRevision, 2);
    assert.equal(b.record.personnelRevision, 2);
    assert.equal(await prisma.accessAudit.count({ where: {
            organizationId: org.id,
            action: 'PERSONNEL_UPDATED'
        } }), 1);
    await assert.rejects(run(() => updateMemberPersonnel(employee.id, org.id, member.id, personnelBody.parse({
        mode: 'contacts',
        revision: 1,
        workEmail: 'later@example.test',
        workPhone: ''
    }))), code('PERSONNEL_CHANGED'));
    const self = await prisma.organizationMember.findFirstOrThrow({ where: {
            organizationId: org.id,
            userId: owner.id
        } });
    await assert.rejects(run(() => updateMemberPersonnel(owner.id, org.id, self.id, body())), code('PERSONNEL_NUMBER_EXISTS'));
    const history = await run(() => getMemberPersonnel(owner.id, org.id, member.id, 1));
    assert.equal(history.history?.total, 1);
    assert(history.history?.items[0].changes.some(c => c.field === 'personnelFirstName' && c.before === null && c.after === 'Иван'));
});
test('directory contacts are working contacts and cannot search another person by private login email', async () => {
    const { owner, employee, org, member, run } = await fixture();
    await run(() => updateMemberPersonnel(owner.id, org.id, member.id, body()));
    const list = await run(() => listMembersPage(employee.id, org.id, {}));
    assert.equal(list.members.find(m => m.id === member.id)?.email, 'work@example.test');
    assert.equal((await run(() => listMembersPage(employee.id, org.id, { search: owner.email }))).pagination.total, 0);
});
test('personnel permissions are explicit, scoped to current placements, revoked on every request, and history is separate', async () => {
    const { owner, employee, org, member, run } = await fixture();
    const role = await prisma.accessRole.create({ data: {
            organizationId: org.id,
            name: 'Personnel reader',
            permissions: ['members.view', 'members.personnel.view']
        } });
    const manager = await prisma.user.create({ data: { email: randomUUID() + '@example.test' } }), managerMember = await prisma.organizationMember.create({ data: {
            organizationId: org.id,
            userId: manager.id,
            accessConfigured: true
        } });
    await prisma.accessAssignment.create({ data: {
            organizationId: org.id,
            memberId: managerMember.id,
            locationId: org.locationId,
            roleId: role.id
        } });
    assert.equal((await run(() => getMemberPersonnel(manager.id, org.id, member.id))).capabilities.view, true);
    await assert.rejects(run(() => getMemberPersonnel(manager.id, org.id, member.id, 1)), code('INSUFFICIENT_PERMISSIONS'));
    await assert.rejects(run(() => updateMemberPersonnel(manager.id, org.id, member.id, body())), code('INSUFFICIENT_PERMISSIONS'));
    await prisma.accessRole.update({
        where: { id: role.id },
        data: { permissions: ['members.view'] }
    });
    assert.equal((await run(() => getMemberPersonnel(manager.id, org.id, member.id))).record, null);
    const business = await createBusinessOrganization(owner.id, {
        name: 'Point personnel',
        description: null,
        timezone: 'Europe/Moscow'
    }), second = await saveLocation(owner.id, business.id, null, locationBody.parse({
        name: 'Other point',
        kind: 'REMOTE',
        timezone: 'Europe/Moscow'
    }));
    const target = await prisma.organizationMember.create({ data: {
            organizationId: business.id,
            userId: employee.id
        } }), reader = await prisma.organizationMember.create({ data: {
            organizationId: business.id,
            userId: manager.id,
            accessConfigured: true
        } }), localRole = await prisma.accessRole.create({ data: {
            organizationId: business.id,
            name: 'Local personnel',
            permissions: ['members.view', 'members.personnel.view']
        } });
    await prisma.locationMember.create({ data: {
            organizationId: business.id,
            memberId: target.id,
            locationId: second.id
        } });
    await prisma.accessAssignment.create({ data: {
            organizationId: business.id,
            memberId: reader.id,
            locationId: business.locationId,
            roleId: localRole.id
        } });
    await assert.rejects(locationContext.run({
        organizationId: business.id,
        locationId: business.locationId
    }, () => getMemberPersonnel(manager.id, business.id, target.id)), code('MEMBER_NOT_FOUND'));
});
test('archive disables editing, rehire retains identity and history; admin sees organization data separately from account', async () => {
    const { owner, org, member, run } = await fixture();
    await run(() => updateMemberPersonnel(owner.id, org.id, member.id, body()));
    await prisma.organizationMember.update({
        where: { id: member.id },
        data: { leftAt: new Date() }
    });
    assert.equal((await run(() => getMemberPersonnel(owner.id, org.id, member.id))).capabilities.edit, false);
    await assert.rejects(run(() => updateMemberPersonnel(owner.id, org.id, member.id, body({
        revision: 2,
        personnelNumber: 'A-02'
    }))), code('INSUFFICIENT_PERMISSIONS'));
    const admin = await adminOrganizationPersonnel(org.id, {}), record = admin.items.find(m => m.id === member.id)!;
    assert.equal(record.record.personnelFirstName, 'Иван');
    assert.equal(record.accountName, 'Имя Личное');
    assert(record.leftAt);
    assert.equal((await adminPersonnelHistory(org.id, member.id, {})).total, 1);
    assert.equal((await adminOrganizationPersonnel(org.id, { search: 'Тестовый Иван' })).total, 1);
    await prisma.organizationMember.update({
        where: { id: member.id },
        data: { leftAt: null }
    });
    assert.equal((await run(() => getMemberPersonnel(owner.id, org.id, member.id, 1))).history?.total, 1);
});
