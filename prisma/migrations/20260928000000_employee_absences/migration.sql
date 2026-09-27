ALTER TYPE "RequestSystemCode" ADD VALUE IF NOT EXISTS 'SICK';
ALTER TYPE "AccountNotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_REPORTED';
ALTER TYPE "AccountNotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_CHANGED';
ALTER TYPE "AccountNotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_CANCELLED';
ALTER TABLE employee_absences ALTER COLUMN source_request_id DROP NOT NULL;
ALTER TABLE employee_absences ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN updated_by_member_id uuid, ADD COLUMN cancelled_by_member_id uuid, ADD COLUMN cancellation_reason varchar(500);
ALTER TABLE employee_absences DROP CONSTRAINT employee_absences_type_check;
ALTER TABLE employee_absences ADD CONSTRAINT employee_absences_type_check CHECK (type::text IN ('VACATION', 'DAY_OFF', 'SICK', 'SICK_LEAVE', 'ABSENCE'));
UPDATE employee_absences SET type = 'SICK' WHERE type = 'SICK_LEAVE';
ALTER TABLE account_notifications ADD COLUMN absence_id uuid REFERENCES employee_absences(id) ON DELETE SET NULL;
CREATE INDEX account_notifications_absence_id_idx ON account_notifications(absence_id);
UPDATE request_types SET is_active = false, allows_attachments = false WHERE system_code = 'SICK_LEAVE';
