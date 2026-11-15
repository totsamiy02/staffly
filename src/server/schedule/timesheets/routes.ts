import { auditSensitiveAccess } from '../../security/journal.ts';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, assertActiveSession, type AuthenticatedRequest } from '../../auth.ts';
import { accountRateLimit } from '../../security/rate-limit.ts';
import { readTimesheet, actOnTimesheet, actionBody, monthSchema, readTimesheetVersion } from './service.ts';
import { timesheetWorkbook } from './workbook.ts';
const router = Router();
router.use(requireAuth);
const limiter = accountRateLimit('timesheet', 30, 60000);
const base = '/organizations/:organizationId/schedule/timesheets/:month';
const params = z.object({ organizationId: z.uuid(), month: monthSchema });
router.get(base, async (request, response) => {
  const { organizationId, month } = params.parse(request.params);
  const eventPage = z.coerce.number().int().min(1).max(1000000).default(1).parse(request.query.eventPage);
  const userId = (request as AuthenticatedRequest).auth!.userId;
  response.json(await auditSensitiveAccess({ action: 'REPORT_PREVIEW', userId, organizationId }, () => readTimesheet(userId, organizationId, month, eventPage)));
});
router.post(base + '/action', limiter, async (request, response) => {
  const { organizationId, month } = params.parse(request.params);
  response.json(await actOnTimesheet((request as AuthenticatedRequest).auth!.userId, organizationId, month, actionBody.parse(request.body)));
});
router.get(base + '/versions/:version/content', limiter, async (request, response) => {
  const { organizationId, month, version } = params.extend({ version: z.coerce.number().int().positive() }).parse(request.params);
  const auth = (request as AuthenticatedRequest).auth!;
  const record = await auditSensitiveAccess({ action: 'EXPORT_DOWNLOAD', userId: auth.userId, organizationId }, () => readTimesheetVersion(auth.userId, organizationId, month, version));
  const bytes = await timesheetWorkbook(record.snapshot, record);
  // Generation can take time: recheck both live access and session before delivery.
  await assertActiveSession(auth);
  await readTimesheetVersion(auth.userId, organizationId, month, version);
  response.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="Staffly-${month}-v${version}.xlsx"`, 'Cache-Control': 'private, no-store'
  }).send(bytes);
});
export default router;
