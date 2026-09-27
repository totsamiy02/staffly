BEGIN;
-- Informational absences share the request history without requiring approval.
INSERT INTO request_types (id, organization_id, name, description, system_code, date_mode, requires_comment, allows_attachments, is_active, updated_at)
SELECT gen_random_uuid(), id, 'Сообщить об отсутствии', 'Сообщение без согласования. Смены сохраняются, запись остаётся в истории заявок.', 'SICK', 'RANGE', false, false, true, now()
FROM organizations
ON CONFLICT (organization_id, system_code) DO NOTHING;
UPDATE request_types SET is_active = true WHERE system_code = 'SICK';

CREATE TEMP TABLE absence_request_links ON COMMIT DROP AS
SELECT id AS absence_id, gen_random_uuid() AS request_id FROM employee_absences
WHERE source_request_id IS NULL AND type IN ('SICK', 'ABSENCE');

INSERT INTO requests (id, organization_id, created_by_member_id, request_type_id, type_name_snapshot, system_code_snapshot, status, start_date, end_date, comment, resolved_at, cancelled_at, resolution_comment, created_at, updated_at)
SELECT l.request_id, a.organization_id, a.member_id, t.id, t.name, 'SICK',
       CASE WHEN a.cancelled_at IS NULL THEN 'APPROVED'::"RequestStatus" ELSE 'CANCELLED'::"RequestStatus" END,
       a.start_date, a.end_date, a.comment, a.created_at, a.cancelled_at, a.cancellation_reason, a.created_at, a.updated_at
FROM employee_absences a JOIN absence_request_links l ON a.id = l.absence_id
JOIN request_types t ON t.organization_id = a.organization_id AND t.system_code = 'SICK';

INSERT INTO request_events (id, request_id, actor_member_id, type, created_at)
SELECT gen_random_uuid(), l.request_id, a.member_id, 'CREATED', a.created_at
FROM employee_absences a JOIN absence_request_links l ON a.id = l.absence_id;
INSERT INTO request_events (id, request_id, actor_member_id, type, comment, created_at)
SELECT gen_random_uuid(), l.request_id, COALESCE(a.cancelled_by_member_id, a.member_id), 'CANCELLED', a.cancellation_reason, a.cancelled_at
FROM employee_absences a JOIN absence_request_links l ON a.id = l.absence_id WHERE a.cancelled_at IS NOT NULL;
UPDATE employee_absences a SET source_request_id = l.request_id, reason = COALESCE(a.reason, CASE WHEN a.type = 'SICK' THEN 'SICK' ELSE 'OTHER' END)
FROM absence_request_links l WHERE a.id = l.absence_id;
UPDATE account_notifications n SET request_id = a.source_request_id
FROM employee_absences a WHERE n.absence_id = a.id AND a.source_request_id IS NOT NULL;

COMMIT;
