import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/server/db.ts';
import { createBusinessOrganization } from '../support/business-organization.ts';
import { getMembership } from '../../src/server/organizations/access/permissions.ts';
import { reviewTransferCandidates, transferReview } from '../../src/server/requests/reviewer-transfer.ts';
import { getRequest } from '../../src/server/requests/request-queries.ts';
import { resolveRequest } from '../../src/server/requests/request-transitions.ts';
import { stageReviewers } from '../../src/server/requests/reviewers.ts';
import { notifyStage } from '../../src/server/requests/request-notifications.ts';
import { maintainAttention } from '../../src/server/attention/reminders.ts';
import { attentionQuery, listAttention } from '../../src/server/attention/service.ts';
import { buildDeliveryContent } from '../../src/server/mail/email-content.ts';
import { definitionOf } from '../../src/shared/request-workflow.ts';
import type { Prisma } from '../../src/generated/prisma/client.ts';

const users: string[] = [], organizations: string[] = [];
let org: string, point: string, second: string, owner: string, ownerMember: string, role: string, typeId: string;
const people: Record<string, { id: string; userId: string }> = {};
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
async function person(name: string, locationId = point, patch: { left?: boolean; deleted?: boolean } = {}) {
  const user = await prisma.user.create({ data: { email: `review-transfer-${randomUUID()}@example.test`, firstName: name, passwordHash: 'test', emailVerifiedAt: new Date(), emailNotificationCategories: { actionDigest: true }, deletedAt: patch.deleted ? new Date() : null } });
  users.push(user.id);
  const member = await prisma.organizationMember.create({ data: { organizationId: org, userId: user.id, joinedAt: new Date(Date.now() - 86400000), accessConfigured: true, leftAt: patch.left ? new Date() : null } });
  await prisma.locationMember.create({ data: { organizationId: org, locationId, memberId: member.id } });
  await prisma.accessAssignment.create({ data: { organizationId: org, locationId, memberId: member.id, roleId: role } });
  people[name] = { id: member.id, userId: user.id };
}
async function request(patch: Partial<Prisma.OrganizationRequestUncheckedCreateInput> = {}) {
  return prisma.organizationRequest.create({ data: {
    organizationId: org, locationId: point, createdByMemberId: people.author.id, requestTypeId: typeId,
    typeNameSnapshot: 'Согласование обращения', dueAt: new Date(Date.now() - 3600000),
    formSnapshot: { version: 1, visibility: 'REVIEWERS', stages: [{ name: 'Проверка', memberId: people.first.id }, { name: 'Итог', memberId: ownerMember }] }, ...patch,
  } });
}
const body = (row: { updatedAt: Date }, memberId: string) => ({ memberId, updatedAt: row.updatedAt.toISOString(), comment: 'Коллега ведёт этот вопрос' });

before(async () => {
  owner = (await prisma.user.create({ data: { email: `review-owner-${randomUUID()}@example.test`, passwordHash: 'test', emailVerifiedAt: new Date(), emailNotificationCategories: { actionDigest: true } } })).id;
  users.push(owner);
  const organization = await createBusinessOrganization(owner, { name: 'Передача согласования', description: null, timezone: 'Europe/Moscow', locations: [{ name: 'Другая точка', timezone: 'Europe/Moscow', city: 'Тест', address: 'Тест' }] });
  org = organization.id; organizations.push(org); [point, second] = organization.locations.map(location => location.id);
  ownerMember = (await getMembership(owner, org)).id;
  role = (await prisma.accessRole.create({ data: { organizationId: org, name: 'Рассмотрение', permissions: ['requests.own', 'requests.view', 'requests.resolve', 'vacations.resolve', 'vacations.view'] } })).id;
  typeId = (await prisma.requestType.create({ data: { organizationId: org, name: 'Передача', dateMode: 'NONE', definition: { stages: [{ name: 'Проверка', memberId: ownerMember }] } } })).id;
  for (const name of ['author', 'first', 'next', 'unassigned']) await person(name);
  await person('elsewhere', second); await person('left', point, { left: true }); await person('deleted', point, { deleted: true });
  const foreign = await createBusinessOrganization(owner, { name: 'Другой контур', description: null, timezone: 'Europe/Moscow' });
  organizations.push(foreign.id); people.foreign = { id: (await getMembership(owner, foreign.id)).id, userId: owner };
});
after(async () => {
  try {
    await prisma.emailDelivery.deleteMany({ where: { organizationId: { in: organizations } } });
    await prisma.accountNotification.deleteMany({ where: { organizationId: { in: organizations } } });
    await prisma.organizationRequest.deleteMany({ where: { organizationId: { in: organizations } } });
    await prisma.documentFolder.deleteMany({ where: { organizationId: { in: organizations } } });
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } finally { await prisma.$disconnect(); }
});

it('offers only active eligible people at the same point, preserving self-review restrictions', async () => {
  const row = await request();
  const candidates = await reviewTransferCandidates(people.first.userId, org, row.id);
  assert.deepEqual(candidates.members.map(member => member.id).sort(), [people.next.id, people.unassigned.id, ownerMember].sort());
  const detail = await getRequest(people.first.userId, org, row.id);
  assert.equal(detail.request.canTransferReview, true);
  await assert.rejects(reviewTransferCandidates(people.author.userId, org, row.id), code('WRONG_REVIEWER'));
  const original = await prisma.accessRole.findUniqueOrThrow({ where: { id: role } });
  try {
    await prisma.accessRole.update({ where: { id: role }, data: { permissions: [...original.permissions.filter(permission => permission !== 'requests.own'), 'requests.selfResolve'] } });
    const withoutOwnRead = await reviewTransferCandidates(people.first.userId, org, row.id);
    assert.ok(!withoutOwnRead.members.some(member => member.id === people.author.id));
  } finally {
    await prisma.accessRole.update({ where: { id: role }, data: { permissions: original.permissions } });
  }
});

it('transfers only the current stage, records the actor/reason/route and invalidates old mail and queue actions', async () => {
  const row = await request();
  await notifyStage(prisma, row);
  await maintainAttention(org);
  assert.equal((await prisma.organizationRequest.findUniqueOrThrow({where:{id:row.id}})).updatedAt.toISOString(), row.updatedAt.toISOString(), 'A reminder must not invalidate an open business form');
  const oldNotices = await prisma.accountNotification.findMany({ where: { requestId: row.id, userId: people.first.userId } });
  assert.ok(oldNotices.length >= 2);
  const oldJobs = await prisma.emailDelivery.findMany({ where: { sourceId: { in: oldNotices.map(n => n.id) } } });
  assert.ok(oldJobs.length >= 2);
  const changed = await transferReview(people.first.userId, org, row.id, body(row, people.next.id));
  assert.equal(changed.status, 'PENDING'); assert.equal(changed.approvalStep, 0); assert.equal(+changed.dueAt!, +row.dueAt!);
  const stages = definitionOf(changed.formSnapshot).stages;
  assert.equal(stages[0].memberId, people.next.id); assert.deepEqual(stages[1], definitionOf(row.formSnapshot).stages[1]);
  assert.equal(definitionOf((await prisma.requestType.findUniqueOrThrow({ where: { id: typeId } })).definition).stages[0].memberId, ownerMember);
  assert.deepEqual((await stageReviewers(prisma, changed)).map(member => member.id), [people.next.id]);
  const event = await prisma.requestEvent.findFirstOrThrow({ where: { requestId: row.id, type: 'CHANGED' } });
  assert.equal(event.actorMemberId, people.first.id);
  assert.equal((event.changes as { action: string }).action, 'REVIEWER_TRANSFERRED');
  assert.match(event.comment!, /first → next/); assert.match(event.comment!, /Коллега ведёт/);
  await assert.rejects(resolveRequest(people.first.userId, org, row.id, 'APPROVED', null), code('WRONG_REVIEWER'));
  await assert.rejects(getRequest(people.first.userId, org, row.id), code('REQUEST_NOT_FOUND'));
  const nextQueue = await listAttention(people.next.userId, org, attentionQuery.parse({ pageSize: 30 }));
  assert.ok(nextQueue.items.some(item => item.sourceId === row.id && item.scope === 'mine'));
  for (const job of oldJobs) {
    assert.equal((await prisma.emailDelivery.findUniqueOrThrow({ where: { id: job.id } })).status, 'SKIPPED');
    assert.equal(await buildDeliveryContent(job, new Date()), null);
  }
  assert.equal((await getRequest(people.next.userId, org, row.id)).request.canReview, true);
  await resolveRequest(people.next.userId, org, row.id, 'APPROVED', null);
  const advanced = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(advanced.approvalStep, 1); assert.deepEqual((await stageReviewers(prisma, advanced)).map(member => member.id), [ownerMember]);
});

it('lets the owner recover a blocked route without resolving or approving the request', async () => {
  const row = await request({ formSnapshot: { version: 1, stages: [{ name: 'Проверка', memberId: randomUUID() }] } });
  const changed = await transferReview(owner, org, row.id, body(row, people.next.id));
  assert.equal(changed.status, 'PENDING'); assert.equal(changed.resolvedAt, null);
  assert.equal(await prisma.requestEvent.count({ where: { requestId: row.id, type: 'APPROVED' } }), 0);
  await assert.rejects(resolveRequest(owner, org, row.id, 'APPROVED', null), code('WRONG_REVIEWER'));
});

it('rejects unauthorized, cross-point, cross-tenant, departed and self-review targets without mutations', async () => {
  const row = await request({ formSnapshot: { version: 1, visibility: 'TEAM', stages: [{ name: 'Проверка', memberId: people.first.id }] } });
  await assert.rejects(transferReview(people.unassigned.userId, org, row.id, body(row, people.next.id)), code('WRONG_REVIEWER'));
  for (const id of [people.author.id, people.elsewhere.id, people.foreign.id, people.left.id, people.deleted.id, people.first.id]) {
    await assert.rejects(transferReview(people.first.userId, org, row.id, body(row, id)), code('REVIEWER_UNAVAILABLE'));
  }
  assert.equal(await prisma.requestEvent.count({ where: { requestId: row.id } }), 0);
  assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: row.id } })).updatedAt.toISOString(), row.updatedAt.toISOString());
});

it('serializes simultaneous transfers and rejects stale cards or resolved requests', async () => {
  const row = await request();
  const attempts = await Promise.allSettled([transferReview(owner, org, row.id, body(row, people.next.id)), transferReview(owner, org, row.id, body(row, ownerMember))]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find(result => result.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && code('REQUEST_CHANGED')(rejected.reason));
  assert.equal(await prisma.requestEvent.count({ where: { requestId: row.id, type: 'CHANGED' } }), 1);
  for (const status of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
    const closed = await request({ status });
    await assert.rejects(transferReview(owner, org, closed.id, body(closed, people.next.id)), code('REVIEW_TRANSFER_UNAVAILABLE'));
  }
  const system = await request({ systemCodeSnapshot: 'STAFFING' });
  await assert.rejects(transferReview(owner, org, system.id, body(system, people.next.id)), code('REVIEW_TRANSFER_UNAVAILABLE'));
  const archived = await request({ locationId: second, createdByMemberId: people.elsewhere.id });
  try {
    await prisma.organizationLocation.update({ where: { id: second }, data: { archivedAt: new Date() } });
    assert.equal((await getRequest(owner, org, archived.id)).request.canTransferReview, false);
    await assert.rejects(reviewTransferCandidates(owner, org, archived.id), code('REVIEW_TRANSFER_UNAVAILABLE'));
    await assert.rejects(transferReview(owner, org, archived.id, body(archived, ownerMember)), code('REQUEST_NOT_FOUND'));
  } finally {
    await prisma.organizationLocation.update({ where: { id: second }, data: { archivedAt: null } });
  }
});

it('enforces an explicitly transferred reviewer for a system request with one decision step', async () => {
  const row = await request({ systemCodeSnapshot: 'OTHER', formSnapshot: {} });
  await notifyStage(prisma, row);
  const oldNotice = await prisma.accountNotification.findFirstOrThrow({ where: { requestId: row.id, userId: people.first.userId } });
  const oldJob = await prisma.emailDelivery.findFirstOrThrow({ where: { sourceId: oldNotice.id } });
  const changed = await transferReview(people.first.userId, org, row.id, body(row, people.next.id));
  assert.equal(definitionOf(changed.formSnapshot).stages.length, 1);
  assert.deepEqual((await stageReviewers(prisma, changed)).map(member => member.id), [people.next.id]);
  assert.equal((await getRequest(people.first.userId, org, row.id)).request.canReview, false);
  assert.equal(await buildDeliveryContent(oldJob, new Date()), null);
  await assert.rejects(resolveRequest(people.first.userId, org, row.id, 'APPROVED', null), code('WRONG_REVIEWER'));
  await resolveRequest(people.next.userId, org, row.id, 'APPROVED', null);
  assert.equal((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: row.id } })).status, 'APPROVED');
});

it('does not send transferred review mail after read permission alone is revoked', async () => {
  const row = await request();
  await transferReview(people.first.userId, org, row.id, body(row, people.next.id));
  const notice = await prisma.accountNotification.findFirstOrThrow({ where: { requestId: row.id, userId: people.next.userId } });
  const job = await prisma.emailDelivery.findFirstOrThrow({ where: { sourceId: notice.id } });
  const original = await prisma.accessRole.findUniqueOrThrow({ where: { id: role } });
  try {
    await prisma.accessRole.update({ where: { id: role }, data: { permissions: original.permissions.filter(permission => permission !== 'requests.view') } });
    await assert.rejects(getRequest(people.next.userId, org, row.id), code('REQUEST_NOT_FOUND'));
    assert.equal(await buildDeliveryContent(job, new Date()), null);
  } finally {
    await prisma.accessRole.update({ where: { id: role }, data: { permissions: original.permissions } });
  }
});

it('rechecks target and actor permissions after the chooser was opened', async () => {
  const row = await request();
  assert.ok((await reviewTransferCandidates(people.first.userId, org, row.id)).members.some(member => member.id === people.next.id));
  const assignment = await prisma.accessAssignment.findFirstOrThrow({ where: { memberId: people.next.id } });
  await prisma.accessAssignment.deleteMany({ where: { memberId: assignment.memberId, locationId: assignment.locationId, roleId: assignment.roleId } });
  await assert.rejects(transferReview(people.first.userId, org, row.id, body(row, people.next.id)), code('REVIEWER_UNAVAILABLE'));
  await prisma.accessRole.update({ where: { id: role }, data: { permissions: ['requests.own', 'requests.view'] } });
  await assert.rejects(transferReview(people.first.userId, org, row.id, body(row, ownerMember)), code('WRONG_REVIEWER'));
  assert.equal(await prisma.requestEvent.count({ where: { requestId: row.id } }), 0);
});
