import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { prisma } from '../db.ts';
import { ApiError } from '../api-error.ts';
import type { Actor } from '../access/request-policy.ts';
import { getMembership } from '../organizations/access/permissions.ts';
import { hasPermission } from '../organizations/access/access.ts';
import { loadReviewerContext, type ReviewerContext } from '../requests/reviewers.ts';
import { actionReviewers, actionVersion, calendarDueAt, reminderPhase, taskOutcome } from './policy.ts';
import { requestActions, documentActions, type RequestAction, type DocumentAction } from './sources.ts';

const reminderContext = z.object({
  kind: z.enum(['REQUEST', 'TASK', 'DOCUMENT', 'BLOCKED_REQUEST', 'BLOCKED_TASK']),
  sourceId: z.uuid(), version: z.string().regex(/^[a-f0-9]{24}$/), phase: z.enum(['SOON', 'OVERDUE', 'BLOCKED']),
  deadline: z.string().nullable().optional(), assignedAt: z.iso.datetime().optional(),
});
type Reminder = z.infer<typeof reminderContext>;

function requestState(row: RequestAction, context: ReviewerContext) {
  const task = row.status === 'APPROVED' ? taskOutcome(row.outcome) : null;
  const kind = task ? 'TASK' as const : 'REQUEST' as const;
  const recipients = task ? context.members.filter(m => task.assignees.includes(m.id) && hasPermission(m, 'requests.own', row.locationId)) : actionReviewers(context, row);
  const deadline = task ? task.deadline ?? null : row.dueAt?.toISOString() ?? null;
  const version = actionVersion({ kind, deadline, stage: task ? undefined : row.approvalStep,
    snapshot: task ? undefined : row.formSnapshot, assignees: task?.assignees, assignedAt: task?.createdAt });
  return { kind, recipients, version, due: task ? calendarDueAt(deadline, row.timezone) : row.dueAt };
}
function documentState(row: DocumentAction) {
  return { due: calendarDueAt(row.deadline, row.timezone), version: actionVersion({ kind: 'DOCUMENT', deadline: row.deadline, assignedAt: row.assignedAt.toISOString() }) };
}

/** The same eligibility check runs at creation and immediately before SMTP delivery. */
export async function resolveAttentionReminder(db: Prisma.TransactionClient, actor: Actor, value: unknown, now: Date, suppliedContext?: ReviewerContext, requireRead = true) {
  const parsed = reminderContext.safeParse(value);
  if (!parsed.success) return null;
  const meta = parsed.data;
  const base = `/app/organizations/${actor.organizationId}`;
  if (meta.kind === 'DOCUMENT') {
    for await (const row of documentActions(db, actor.organizationId, { actor, id: meta.sourceId })) {
      const state = documentState(row);
      if (row.memberId !== actor.id || state.version !== meta.version || reminderPhase(state.due, row.timezone, now) !== meta.phase) return null;
      return { title: meta.phase === 'SOON' ? 'Завтра срок ознакомления' : 'Срок ознакомления прошёл',
        message: row.title, due: state.due, timezone: row.timezone, locationName: row.locationName,
        path: `${base}/documents?section=acknowledgements&document=${row.documentId}${row.locationId ? `&location=${row.locationId}` : ''}`,
        label: 'Ознакомиться' };
    }
    return null;
  }
  const context = suppliedContext ?? await loadReviewerContext(db, actor.organizationId);
  for await (const row of requestActions(db, actor.organizationId, { actor: requireRead ? actor : undefined, roles: context.roles, id: meta.sourceId })) {
    const state = requestState(row, context);
    const blocked = meta.kind.startsWith('BLOCKED_');
    if (state.version !== meta.version || (blocked ? meta.kind !== `BLOCKED_${state.kind}` || !actor.owner || state.recipients.length > 0 || meta.phase !== 'BLOCKED'
      : meta.kind !== state.kind || !state.recipients.some(m => m.id === actor.id) || reminderPhase(state.due, row.timezone, now) !== meta.phase)) return null;
    return { title: blocked ? state.kind === 'TASK' ? 'У задачи нет доступного исполнителя' : 'У заявки нет доступного согласующего'
      : state.kind === 'TASK' ? meta.phase === 'SOON' ? 'Завтра срок выполнения задачи' : 'Задача просрочена'
        : meta.phase === 'SOON' ? 'Завтра срок рассмотрения заявки' : 'Заявка просрочена',
      message: row.typeNameSnapshot, due: state.due, timezone: row.timezone, locationName: row.locationName,
      path: `${base}/requests?tab=${state.kind === 'TASK' ? 'mine' : 'incoming'}&request=${row.id}&location=${row.locationId}`,
      label: state.kind === 'TASK' ? 'Открыть задачу' : 'Открыть заявку' };
  }
  return null;
}

export async function maintainAttention(organizationId: string, now = new Date(), shouldContinue = () => true, sources: 'all' | 'documents' | 'requests' = 'all') {
  const actors = new Map<string, Actor | null>();
  const actorFor = async (userId: string) => {
    if (!actors.has(userId)) {
      try { actors.set(userId, await getMembership(userId, organizationId)); }
      catch (e) { if (e instanceof ApiError && [403, 404].includes(e.status)) actors.set(userId, null); else throw e; }
    }
    return actors.get(userId)!;
  };
  // Page the sources outside a long write transaction. A fresh source/rights check is
  // performed for each notice; the unique key makes overlapping workers harmless.
  const context = sources === 'documents' ? undefined : await loadReviewerContext(prisma, organizationId);
  const publish = async (userId: string, meta: Reminder) => {
    const attentionDeliveryKey = `attention:${meta.kind}:${meta.sourceId}:${meta.version}:${meta.phase}:${userId}`;
    if (await prisma.accountNotification.findUnique({ where: { attentionDeliveryKey }, select: { id: true } })) return false;
    const actor = await actorFor(userId);
    if (!actor || !shouldContinue()) return false;
    return prisma.$transaction(async db => {
      // Resolution-only legacy roles retain internal notices. History applies its
      // own read policy; optional mail always requires a readable source.
      const content = await resolveAttentionReminder(db, actor, meta, now, context, false);
      if (!content) return false;
      const blocked = meta.phase === 'BLOCKED';
      await db.accountNotification.createMany({ skipDuplicates: true, data: [{
        userId, organizationId, createdAt: now, ...(meta.kind === 'DOCUMENT' ? { documentId: (await db.documentAcknowledgement.findUniqueOrThrow({ where: { id: meta.sourceId }, select: { documentId: true } })).documentId } : { requestId: meta.sourceId }),
        type: blocked ? 'REQUEST_BLOCKED' : meta.kind === 'DOCUMENT' ? 'DOCUMENT_REMINDER' : meta.kind === 'TASK' ? 'REQUEST_TASK_REMINDER' : 'REQUEST_REMINDER',
        title: content.title, message: content.message, emailContext: { attention: meta },
        attentionDeliveryKey,
      }] });
      if (meta.kind === 'REQUEST' && meta.phase === 'OVERDUE') {
        // Delivery bookkeeping is not a new business revision of the request.
        await db.$executeRaw`UPDATE requests SET reminded_at=${now}
          WHERE id=${meta.sourceId}::uuid AND status='PENDING' AND reminded_at IS NULL`;
      }
      return true;
    });
  };
  if (sources !== 'documents') for await (const row of requestActions(prisma, organizationId)) {
    if (!shouldContinue()) return;
    const state = requestState(row, context!);
    if (!state.recipients.length) {
      for (const owner of context!.members.filter(m => m.owner)) await publish(owner.userId, { kind: `BLOCKED_${state.kind}` as Reminder['kind'], sourceId: row.id, version: state.version, phase: 'BLOCKED' });
    } else {
      const phase = reminderPhase(state.due, row.timezone, now);
      if (phase) for (const member of state.recipients) await publish(member.userId, { kind: state.kind, sourceId: row.id, version: state.version, phase });
    }
  }
  if (sources !== 'requests') for await (const row of documentActions(prisma, organizationId, { remindersAt: now })) {
    if (!shouldContinue()) return;
    const state = documentState(row), phase = reminderPhase(state.due, row.timezone, now);
    if (phase) await publish(row.userId, { kind: 'DOCUMENT', sourceId: row.id, version: state.version, phase, deadline: row.deadline, assignedAt: row.assignedAt.toISOString() });
  }
}
