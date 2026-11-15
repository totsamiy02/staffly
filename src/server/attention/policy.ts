import { createHash } from 'node:crypto';
import { definitionOf, requestOutcome } from '../../shared/request-workflow.ts';
import { reviewersFromContext, type ReviewerContext, type ReviewerItem } from '../requests/reviewers.ts';
import { addCalendarDays, startOfZonedDate, zonedParts } from '../schedule/timezone.ts';

export function localDay(now: Date, timezone: string) {
  const parts = zonedParts(now, timezone);
  return String(parts.year) + '-' + String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0');
}

export function calendarDueAt(day: string | null | undefined, timezone: string) {
  return day ? new Date(+startOfZonedDate(addCalendarDays(day, 1), timezone) - 1) : null;
}

export function reminderPhase(dueAt: Date | null, timezone: string, now: Date) {
  if (!dueAt) return null;
  if (now >= dueAt) return 'OVERDUE' as const;
  if (localDay(now, timezone) === addCalendarDays(localDay(dueAt, timezone), -1)) return 'SOON' as const;
  return null;
}

export function actionReviewers(context: ReviewerContext, item: ReviewerItem) {
  return reviewersFromContext(context, item);
}

export function taskOutcome(value: unknown) {
  const parsed = requestOutcome.safeParse(value);
  return parsed.success && parsed.data.kind === 'TASK' && parsed.data.status === 'OPEN' ? parsed.data : null;
}

export function actionVersion(item: {
  kind: 'REQUEST' | 'TASK' | 'DOCUMENT' | 'BLOCKED';
  deadline: string | null;
  stage?: number;
  snapshot?: unknown;
  assignees?: string[];
  assignedAt?: string;
}) {
  const stage = item.snapshot ? definitionOf(item.snapshot).stages[item.stage ?? 0] : null;
  return createHash('sha256').update(JSON.stringify({
    kind: item.kind,
    deadline: item.deadline,
    stage: item.stage,
    route: stage ?? null,
    assignees: item.assignees ? [...item.assignees].sort() : undefined,
    assignedAt: item.assignedAt,
  })).digest('hex').slice(0, 24);
}
