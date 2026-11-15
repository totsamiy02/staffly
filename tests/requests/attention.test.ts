import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/server/db.ts';
import { createBusinessOrganization } from '../support/business-organization.ts';
import { getMembership } from '../../src/server/organizations/access/permissions.ts';
import { attentionQuery, listAttention } from '../../src/server/attention/service.ts';
import { maintainAttention } from '../../src/server/attention/reminders.ts';
import { calendarDueAt, localDay, reminderPhase } from '../../src/server/attention/policy.ts';
import { buildDeliveryContent } from '../../src/server/mail/email-content.ts';
import { completeRequestTask, resolveRequest } from '../../src/server/requests/request-transitions.ts';

let typeId: string;
let org: string, point: string, second: string, owner: string, ownerMember: string, employee: string, employeeMember: string, reviewer: string, reviewerMember: string, role: string;
const users: string[] = [];
const now = new Date('2035-04-12T08:00:00Z');
const options = (patch: object = {}) => attentionQuery.parse(patch);
async function request(patch: object = {}) {
  return prisma.organizationRequest.create({ data: { organizationId: org, locationId: point, createdByMemberId: employeeMember,
    requestTypeId: typeId, typeNameSnapshot: 'Заявка для очереди', formSnapshot: { version: 1, stages: [{ name: 'Рассмотрение', memberId: reviewerMember }] },
    dueAt: new Date('2035-04-11T12:00:00Z'), ...patch } });
}
async function document(deadline = '2035-04-11', patch: object = {}) {
  const file = await prisma.storedFile.create({ data: { objectKey: 'attention/' + randomUUID(), mimeType: 'text/plain', size: 0, checksumSha256: '0'.repeat(64), purpose: 'DOCUMENT', uploadedByUserId: owner, organizationId: org } });
  const doc = await prisma.document.create({ data: { organizationId: org, locationId: point, storedFileId: file.id, displayName: 'Инструкция для очереди', fileName: 'instruction.txt', visibility: 'ORGANIZATION', uploadedByMemberId: ownerMember, ...patch } });
  const ack = await prisma.documentAcknowledgement.create({ data: { documentId: doc.id, memberId: employeeMember, assignedByMemberId: ownerMember, deadline: new Date(deadline) } });
  return { doc, ack };
}
before(async () => {
  for (let i = 0; i < 3; i++) users.push((await prisma.user.create({ data: { email: `attention-${randomUUID()}@example.test`, passwordHash: 'test', emailVerifiedAt: new Date(), emailNotificationCategories: { actionDigest: true, documents: true } } })).id);
  [owner, employee, reviewer] = users;
  const organization = await createBusinessOrganization(owner, { name: 'Очередь действий', timezone: 'Europe/Moscow', description: null, locations: [{ name: 'Другая точка', timezone: 'Asia/Vladivostok', city: 'Тест', address: 'Тест' }] });
  org = organization.id; [point, second] = organization.locations.map(l => l.id); ownerMember = (await getMembership(owner, org)).id;
  typeId = (await prisma.requestType.create({ data: { organizationId: org, name: 'Внутренняя заявка', dateMode: 'NONE' } })).id;
  const ownRole = await prisma.accessRole.create({ data: { organizationId: org, name: 'Исполнители', permissions: ['requests.own', 'documents.view'] } });
  role = (await prisma.accessRole.create({ data: { organizationId: org, name: 'Согласующие', permissions: ['requests.own', 'requests.view', 'requests.resolve', 'documents.view', 'documents.control'] } })).id;
  for (const [userId, roleId] of [[employee, ownRole.id], [reviewer, role]]) {
    const member = await prisma.organizationMember.create({ data: { organizationId: org, userId, role: 'MEMBER', accessConfigured: true } });
    await prisma.locationMember.create({ data: { organizationId: org, locationId: point, memberId: member.id, role: 'MEMBER' } });
    await prisma.accessAssignment.create({ data: { organizationId: org, locationId: point, memberId: member.id, roleId } });
    if (userId === employee) employeeMember = member.id; else reviewerMember = member.id;
  }
});
after(async () => {
  try {
    await prisma.emailDelivery.deleteMany({ where: { organizationId: org } });
    await prisma.accountNotification.deleteMany({ where: { organizationId: org } });
    await prisma.organizationRequest.deleteMany({ where: { organizationId: org } });
    await prisma.documentAcknowledgement.deleteMany({ where: { document: { organizationId: org } } });
    await prisma.document.deleteMany({ where: { organizationId: org } });
    await prisma.storedFile.deleteMany({ where: { organizationId: org } });
    await prisma.documentFolder.deleteMany({ where: { organizationId: org } });
    await prisma.organization.delete({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } finally { await prisma.$disconnect(); }
});

it('uses inclusive local calendar deadlines across DST and exact instants for review', () => {
  const due = calendarDueAt('2035-03-11', 'America/New_York')!;
  assert.equal(localDay(due, 'America/New_York'), '2035-03-11');
  assert.equal(localDay(new Date(+due + 1), 'America/New_York'), '2035-03-12');
  assert.equal(reminderPhase(due, 'America/New_York', new Date('2035-03-10T12:00:00Z')), 'SOON');
  assert.equal(reminderPhase(due, 'America/New_York', new Date('2035-03-11T12:00:00Z')), null);
  assert.equal(reminderPhase(due, 'America/New_York', new Date(+due + 1)), 'OVERDUE');
  assert.equal(reminderPhase(null, 'Europe/Moscow', now), null);
});
it('isolates current reviewers, unreadable/private sources, points and tenant counts before pagination', async () => {
  const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => request({ typeNameSnapshot: `Очередь ${i}` })));
  const future = await request({ typeNameSnapshot: 'Другой этап', approvalStep: 1, formSnapshot: { version: 1, stages: [{ name: 'Первый', memberId: reviewerMember }, { name: 'Второй', memberId: ownerMember }] } });
  const secret = await request({ locationId: second, typeNameSnapshot: 'Секрет другой точки' });
  const { doc } = await document();
  const privateDoc = await document('2035-04-11', { visibility: 'PRIVATE_MEMBER', targetMemberId: ownerMember });
  const first = await listAttention(reviewer, org, options({ pageSize: 3 }), now);
  assert.equal(first.counts.mine, 8); assert.equal(first.pagination.total, 8); assert.equal(first.pagination.pages, 3);
  assert.equal(first.counts.control, 2); // readable other-stage request + aggregated document
  const pages = await Promise.all([1, 2, 3].map(page => listAttention(reviewer, org, options({ page, pageSize: 3 }), now)));
  assert.equal(new Set(pages.flatMap(p => p.items.map(i => i.id))).size, 8);
  assert.ok(pages.flatMap(p => p.items).every(i => rows.some(r => r.id === i.sourceId)));
  const control = await listAttention(reviewer, org, options({ scope: 'control' }), now);
  assert.ok(control.items.some(i => i.sourceId === future.id)); assert.ok(control.items.some(i => i.sourceId === doc.id));
  assert.ok(!control.items.some(i => [secret.id, privateDoc.doc.id].includes(i.sourceId)));
  const otherPoint = await listAttention(reviewer, org, options({ pointId: second }), now);
  assert.equal(otherPoint.counts.total, 0);
  const own = await listAttention(employee, org, options(), now);
  assert.equal(own.counts.mine, 1); assert.equal(own.items[0].sourceId, doc.id);
  await assert.rejects(listAttention(employee, randomUUID(), options(), now));
  await prisma.organizationRequest.updateMany({ where: { id: { in: [...rows.map(r => r.id), future.id, secret.id] } }, data: { status: 'CANCELLED' } });
  await prisma.documentAcknowledgement.updateMany({ where: { documentId: { in: [doc.id, privateDoc.doc.id] } }, data: { cancelledAt: now } });
});
it('creates a separate task deadline on approval and completes once under concurrent clicks', async () => {
  const row = await request({ formSnapshot: { version: 1, action: 'TASK', taskDeadlineDays: 3, recipientMemberIds: [employeeMember], stages: [{ name: 'Решение', memberId: ownerMember }] } });
  await resolveRequest(owner, org, row.id, 'APPROVED', null);
  const stored = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: row.id } });
  const outcome = stored.outcome as { deadline: string; createdAt: string };
  const expected = new Date(localDay(new Date(outcome.createdAt), 'Europe/Moscow') + 'T12:00:00Z'); expected.setUTCDate(expected.getUTCDate() + 3);
  assert.equal(outcome.deadline, expected.toISOString().slice(0, 10));
  const queue = await listAttention(employee, org, options(), now);
  assert.ok(queue.items.some(i => i.sourceId === row.id && i.kind === 'TASK'));
  await Promise.all([completeRequestTask(employee, org, row.id), completeRequestTask(employee, org, row.id)]);
  assert.equal(await prisma.requestEvent.count({ where: { requestId: row.id, comment: 'Задача выполнена.' } }), 1);
  assert.ok(!(await listAttention(employee, org, options(), now)).items.some(i => i.sourceId === row.id));
  const old = await request({ status: 'APPROVED', outcome: { kind: 'TASK', status: 'OPEN', text: 'Старая задача', assignees: [employeeMember] } });
  const oldItem = (await listAttention(employee, org, options(), now)).items.find(i => i.sourceId === old.id)!;
  assert.equal(oldItem.dueAt, null); assert.equal(oldItem.overdue, false);
  await prisma.organizationRequest.update({ where: { id: old.id }, data: { status: 'CANCELLED' } });
  await assert.rejects(completeRequestTask(employee, org, old.id));
});
it('deduplicates both reminder phases and suppresses stale deadlines, stages, assignees and completed work before mail', async () => {
  const row = await request({ dueAt: new Date('2035-04-13T12:00:00Z') });
  const task = await request({ status: 'APPROVED', outcome: { kind: 'TASK', status: 'OPEN', text: 'Работа', deadline: '2035-04-13', assignees: [employeeMember] } });
  const { doc, ack } = await document('2035-04-13');
  await Promise.all([maintainAttention(org, now), maintainAttention(org, now)]);
  const notices = await prisma.accountNotification.findMany({ where: { OR: [{ requestId: { in: [row.id, task.id] } }, { documentId: doc.id }], type: { in: ['REQUEST_REMINDER', 'REQUEST_TASK_REMINDER', 'DOCUMENT_REMINDER'] } } });
  assert.equal(notices.length, 3);
  const jobs = await prisma.emailDelivery.findMany({ where: { OR: [{ sourceId: { in: notices.map(n => n.id) } }, { sourceKind: 'DOCUMENT_REMINDER', sourceId: ack.id }] } });
  assert.equal(jobs.length, 3);
  for (const job of jobs) assert.ok(await buildDeliveryContent(job, now));
  await prisma.organizationRequest.update({ where: { id: row.id }, data: { approvalStep: 1, formSnapshot: { version: 1, stages: [{ name: 'Первый', memberId: reviewerMember }, { name: 'Следующий', memberId: ownerMember }] } } });
  await prisma.organizationRequest.update({ where: { id: task.id }, data: { outcome: { kind: 'TASK', status: 'OPEN', text: 'Работа', deadline: '2035-04-13', assignees: [ownerMember] } } });
  await prisma.documentAcknowledgement.update({ where: { id: ack.id }, data: { deadline: new Date('2035-04-20') } });
  for (const job of jobs) assert.equal(await buildDeliveryContent(job, now), null);
  const overdue = new Date('2035-04-14T12:00:00Z');
  await maintainAttention(org, overdue); await maintainAttention(org, overdue);
  assert.equal(await prisma.accountNotification.count({ where: { requestId: row.id, type: 'REQUEST_REMINDER' } }), 2);
  assert.equal(await prisma.accountNotification.count({ where: { requestId: task.id, type: 'REQUEST_TASK_REMINDER' } }), 2);
  await completeRequestTask(owner, org, task.id);
  await prisma.organizationRequest.update({ where: { id: row.id }, data: { status: 'REJECTED' } });
  await prisma.documentAcknowledgement.update({ where: { id: ack.id }, data: { acknowledgedAt: now } });
  const allJobs = await prisma.emailDelivery.findMany({ where: { sourceId: { in: (await prisma.accountNotification.findMany({ where: { requestId: { in: [row.id, task.id] } } })).map(n => n.id) } } });
  for (const job of allJobs) assert.equal(await buildDeliveryContent(job, overdue), null);
});
it('shows a missing reviewer under control, alerts the owner once, and does not lose the eventual overdue reminder', async () => {
  const missingMember = randomUUID();
  const row = await request({ formSnapshot: { version: 1, stages: [{ name: 'Ответственный', memberId: missingMember }] } });
  await maintainAttention(org, now); await maintainAttention(org, now);
  const stored = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(stored.remindedAt, null);
  assert.equal(await prisma.accountNotification.count({ where: { requestId: row.id, type: 'REQUEST_BLOCKED', userId: owner } }), 1);
  assert.equal(await prisma.accountNotification.count({ where: { requestId: row.id, type: 'REQUEST_REMINDER' } }), 0);
  const blocked = await listAttention(owner, org, options({ scope: 'control', filter: 'blocked' }), now);
  assert.ok(blocked.items.some(i => i.sourceId === row.id && i.blocked));
  await prisma.organizationRequest.update({ where: { id: row.id }, data: { formSnapshot: { version: 1, stages: [{ name: 'Ответственный', memberId: reviewerMember }] } } });
  await maintainAttention(org, now);
  assert.equal(await prisma.accountNotification.count({ where: { requestId: row.id, type: 'REQUEST_REMINDER', userId: reviewer } }), 1);
  assert.ok((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: row.id } })).remindedAt);
  const notice = await prisma.accountNotification.findFirstOrThrow({ where: { requestId: row.id, type: 'REQUEST_REMINDER' } });
  const job = await prisma.emailDelivery.findFirstOrThrow({ where: { sourceId: notice.id } });
  await prisma.accessAssignment.deleteMany({ where: { memberId: reviewerMember, roleId: role } });
  assert.equal(await buildDeliveryContent(job, now), null);
  assert.equal((await listAttention(reviewer, org, options(), now)).counts.total, 0);
});
