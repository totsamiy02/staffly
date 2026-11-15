import { z } from 'zod';
import { prisma } from '../db.ts';
import { getMembership } from '../organizations/access/permissions.ts';
import { hasPermission } from '../organizations/access/access.ts';
import { docPermission } from '../access/document-policy.ts';
import { loadReviewerContext } from '../requests/reviewers.ts';
import { reconcileShiftRequests } from '../requests/shift-conflicts.ts';
import { AttentionCollector } from './collector.ts';
import { actionReviewers, calendarDueAt, taskOutcome } from './policy.ts';
import { documentActions, requestActions, type DocumentAction } from './sources.ts';

export const attentionQuery = z.object({
  scope: z.enum(['mine', 'control']).default('mine'), filter: z.enum(['all', 'overdue', 'blocked']).default('all'),
  pointId: z.union([z.literal('all'), z.uuid()]).default('all'),
  page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(30).default(5),
});
export async function listAttention(userId: string, organizationId: string, options: z.infer<typeof attentionQuery>, now = new Date()) {
  const actor = await getMembership(userId, organizationId);
  await reconcileShiftRequests(organizationId);
  return prisma.$transaction(async db => {
    const context = await loadReviewerContext(db, organizationId);
    const result = new AttentionCollector(options);
    const pointId = options.pointId === 'all' ? undefined : options.pointId;
    const base = `/app/organizations/${organizationId}`;
    for await (const row of requestActions(db, organizationId, { actor, roles: context.roles, pointId })) {
      const task = row.status === 'APPROVED' ? taskOutcome(row.outcome) : null;
      const assignees = task ? context.members.filter(m => task.assignees?.includes(m.id) && hasPermission(m, 'requests.own', row.locationId)) : [];
      const reviewers = task ? assignees : actionReviewers(context, row);
      const mine = reviewers.some(m => m.id === actor.id);
      // Authors can track their pending request; a task belongs under control only for process managers.
      if (task && !mine && !hasPermission(actor, 'requests.resolve', row.locationId)) continue;
      const due = task ? calendarDueAt(task.deadline, row.timezone) : row.dueAt;
      const blocked = !reviewers.length;
      const scope = mine ? 'mine' : 'control';
      result.add({ id: `${task ? 'task' : 'request'}:${row.id}`, sourceId: row.id, kind: task ? 'TASK' : 'REQUEST', scope,
        title: row.typeNameSnapshot, subtitle: row.person, locationId: row.locationId, locationName: row.locationName,
        timezone: row.timezone, dueAt: due?.toISOString() ?? null, deadlineDay: task?.deadline ?? null,
        overdue: !!due && now > due, blocked,
        reason: blocked ? task ? 'Нет доступного исполнителя' : 'Нет доступного согласующего'
          : task ? mine ? 'Назначена вам' : 'Ожидает выполнения' : mine ? 'Ожидает вашего решения' : 'Ожидает решения согласующего',
        action: task ? 'Открыть задачу' : blocked ? 'Открыть заявку' : mine ? 'Рассмотреть' : 'Открыть заявку',
        href: `${base}/requests?tab=${mine && !task ? 'incoming' : 'mine'}&request=${row.id}&location=${row.locationId}`,
      });
    }
    // Aggregate only readable documents. Completed/cancelled/departed recipients never enter the counts.
    const control = new Map<string, { row: DocumentAction; count: number; due: Date | null }>();
    for await (const row of documentActions(db, organizationId, { actor, pointId })) {
      const due = calendarDueAt(row.deadline, row.timezone);
      const common = { sourceId: row.documentId, kind: 'DOCUMENT' as const, title: row.title, locationId: row.locationId,
        locationName: row.locationName, timezone: row.timezone, blocked: false };
      if (row.memberId === actor.id) result.add({ ...common, id: `document:${row.id}`, scope: 'mine', subtitle: 'Ознакомление с документом',
        dueAt: due?.toISOString() ?? null, deadlineDay: row.deadline, overdue: !!due && now > due,
        reason: 'Вы ещё не подтвердили ознакомление', action: 'Ознакомиться',
        href: `${base}/documents?section=acknowledgements&document=${row.documentId}${row.locationId ? `&location=${row.locationId}` : ''}` });
      else if (docPermission(actor, 'documents.control', row.locationId)) {
        const group = control.get(row.documentId);
        if (!group) control.set(row.documentId, { row, count: 1, due });
        else { group.count++; if (due && (!group.due || due < group.due)) { group.due = due; group.row = row; } }
      }
    }
    for (const { row, count, due } of control.values()) result.add({ id: `document-control:${row.documentId}`, sourceId: row.documentId,
      kind: 'DOCUMENT', scope: 'control', title: row.title, subtitle: 'Контроль ознакомлений', locationId: row.locationId,
      locationName: row.locationName, timezone: row.timezone, dueAt: due?.toISOString() ?? null, deadlineDay: row.deadline,
      overdue: !!due && now > due, blocked: false, reason: `Не ознакомились: ${count}`, action: 'Проверить',
      href: `${base}/documents?section=control&document=${row.documentId}${row.locationId ? `&location=${row.locationId}` : ''}` });
    return result.result();
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 });
}
