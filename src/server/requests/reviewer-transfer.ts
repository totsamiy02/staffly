import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.ts';
import { definitionOf } from '../../shared/request-workflow.ts';
import { ApiError } from '../api-error.ts';
import { prisma } from '../db.ts';
import { requestReadSql } from '../access/request-policy.ts';
import { getMembership } from '../organizations/access/permissions.ts';
import { hasPermission } from '../organizations/access/access.ts';
import { requestForAccess } from './request-access.ts';
import { lockRequest } from './request-lock.ts';
import { loadReviewerContext, reviewPermission, reviewersFromContext, type ReviewerContext, type ReviewerItem } from './reviewers.ts';
import { markRequestNoticesRead, notifyStage } from './request-notifications.ts';
import type { RequestActor } from './request-model.ts';

export const transferReviewBody = z.object({
  memberId: z.uuid(),
  updatedAt: z.iso.datetime(),
  comment: z.string().trim().max(500).optional(),
}).strict();

export function supportsReviewTransfer(item: { status: string; systemCodeSnapshot: string | null }) {
  return item.status === 'PENDING' && !['SICK', 'SICK_LEAVE', 'STAFFING'].includes(item.systemCodeSnapshot ?? '');
}

function requireTransfer(actor: RequestActor, item: ReviewerItem & { status: string }, context: ReviewerContext) {
  if (!supportsReviewTransfer(item)) throw new ApiError(409, 'REVIEW_TRANSFER_UNAVAILABLE', 'Передача доступна для заявки, ожидающей согласования.');
  if (!actor.owner && !reviewersFromContext(context, item).some(member => member.id === actor.id)) {
    throw new ApiError(403, 'WRONG_REVIEWER', 'Передать согласование может текущий согласующий или владелец.');
  }
}

function eligibleMembers(actor: RequestActor, item: ReviewerItem, context: ReviewerContext) {
  const stage = definitionOf(item.formSnapshot).stages[item.approvalStep];
  const permission = reviewPermission(item.systemCodeSnapshot);
  const current = reviewersFromContext(context, item);
  return context.members.filter(member => {
    if (member.id === stage?.memberId || member.id === actor.id && current.some(person => person.id === actor.id)) return false;
    if (!hasPermission(member, permission, item.locationId)) return false;
    if (member.id === item.createdByMemberId && (!hasPermission(member, 'requests.selfResolve', item.locationId)
      || !hasPermission(member, 'requests.own', item.locationId))) return false;
    // Naming someone on a stage grants no permission: the target must be able to
    // read the request as well as resolve it at this point.
    return hasPermission(member, 'requests.view', item.locationId)
      || item.systemCodeSnapshot === 'VACATION' && hasPermission(member, 'vacations.view', item.locationId);
  });
}

async function names(db: Prisma.TransactionClient, ids: string[]) {
  const members = await db.organizationMember.findMany({
    where: { id: { in: ids } },
    select: { id: true, user: { select: { firstName: true, lastName: true, middleName: true, email: true } } },
  });
  return new Map(members.map(member => [member.id, [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || member.user.email.split('@')[0]]));
}

export async function reviewTransferCandidates(userId: string, organizationId: string, requestId: string) {
  const { actor, item } = await requestForAccess(userId, organizationId, requestId);
  if (item.location.archivedAt) throw new ApiError(409, 'REVIEW_TRANSFER_UNAVAILABLE', 'Точка заявки находится в архиве.');
  return prisma.$transaction(async db => {
    const context = await loadReviewerContext(db, organizationId);
    requireTransfer(actor, item, context);
    const candidates = eligibleMembers(actor, item, context);
    const labels = await names(db, candidates.map(member => member.id));
    return { members: candidates.map(member => ({ id: member.id, name: labels.get(member.id)! }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.id.localeCompare(right.id)) };
  });
}

export async function transferReview(userId: string, organizationId: string, requestId: string, input: z.infer<typeof transferReviewBody>) {
  await requestForAccess(userId, organizationId, requestId);
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`;
    await lockRequest(db, requestId);
    const actor = await getMembership(userId, organizationId, db);
    const context = await loadReviewerContext(db, organizationId);
    const [item] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT r.id FROM requests r JOIN organization_locations l ON l.id=r.location_id
      WHERE r.id=${requestId}::uuid AND l.archived_at IS NULL AND ${requestReadSql(actor, context.roles)}`);
    if (!item) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка не найдена.');
    const current = await db.organizationRequest.findUniqueOrThrow({ where: { id: requestId } });
    requireTransfer(actor, current, context);
    if (current.updatedAt.toISOString() !== input.updatedAt) throw new ApiError(409, 'REQUEST_CHANGED', 'Заявка изменилась. Обновите карточку и повторите действие.');
    const target = eligibleMembers(actor, current, context).find(member => member.id === input.memberId);
    if (!target) throw new ApiError(409, 'REVIEWER_UNAVAILABLE', 'Этот сотрудник больше недоступен для согласования в данной точке.');

    const definition = definitionOf(current.formSnapshot);
    const previous = definition.stages[current.approvalStep];
    if (definition.stages.length && !previous) throw new ApiError(409, 'REQUEST_CHANGED', 'Проверьте текущий этап заявки.');
    const nextStage = { name: previous?.name ?? 'Согласование', memberId: target.id };
    const stages = [...definition.stages];
    stages[current.approvalStep] = nextStage;
    const labels = await names(db, [...new Set([target.id, ...(previous?.memberId ? [previous.memberId] : [])])]);
    const from = previous?.memberId ? labels.get(previous.memberId) ?? 'Предыдущий согласующий'
      : context.roles.find(role => role.id === previous?.roleId)?.name ?? 'По правам роли';
    const to = labels.get(target.id)!;
    const next = await db.organizationRequest.update({
      where: { id: requestId },
      data: { formSnapshot: { ...definition, stages }, remindedAt: null },
    });
    await db.requestEvent.create({ data: {
      requestId, actorMemberId: actor.id, type: 'CHANGED',
      comment: `Согласование передано: ${from} → ${to}.${input.comment ? ` ${input.comment}` : ''}`.slice(0, 1000),
      changes: { action: 'REVIEWER_TRANSFERRED', step: current.approvalStep, before: previous ?? null,
        after: nextStage, fromName: from, toName: to, reason: input.comment ?? null },
    } });
    await markRequestNoticesRead(db, { requestId, readAt: null }, new Date());
    // Old queued review mail must not revive if the request is later transferred back.
    await db.$executeRaw`UPDATE email_deliveries e SET status='SKIPPED', locked_until=NULL
      WHERE e.status='PENDING' AND e.source_kind='NOTIFICATION' AND EXISTS (
        SELECT 1 FROM account_notifications n WHERE n.id=e.source_id AND n.request_id=${requestId}::uuid
          AND n.type::text IN ('REQUEST_CREATED','REQUEST_REMINDER','REQUEST_BLOCKED'))`;
    await db.requestRead.deleteMany({ where: { requestId } });
    await notifyStage(db, next, [{ id: target.id, userId: target.userId }]);
    return next;
  });
}
