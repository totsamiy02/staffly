ALTER TYPE "StoredFilePurpose" ADD VALUE 'REQUEST_ATTACHMENT';
ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_CREATED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_APPROVED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_REJECTED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_CANCELLED';

CREATE TYPE "RequestSystemCode" AS ENUM ('VACATION', 'DAY_OFF', 'SICK_LEAVE', 'ABSENCE', 'SHIFT_CHANGE', 'OTHER');
CREATE TYPE "RequestDateMode" AS ENUM ('NONE', 'SINGLE', 'RANGE');
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "RequestEventType" AS ENUM ('CREATED', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "request_types" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "description" VARCHAR(500),
  "system_code" "RequestSystemCode",
  "date_mode" "RequestDateMode" NOT NULL,
  "requires_comment" BOOLEAN NOT NULL DEFAULT false,
  "allows_attachments" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "requests" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "created_by_member_id" UUID NOT NULL,
  "request_type_id" UUID NOT NULL,
  "type_name_snapshot" VARCHAR(100) NOT NULL,
  "system_code_snapshot" "RequestSystemCode",
  "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
  "start_date" DATE,
  "end_date" DATE,
  "comment" VARCHAR(2000),
  "related_shift_id" UUID,
  "resolved_at" TIMESTAMPTZ(3),
  "resolved_by_member_id" UUID,
  "resolution_comment" VARCHAR(1000),
  "cancelled_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "requests_date_order_check" CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "start_date" <= "end_date")
);

CREATE TABLE "request_reads" (
  "request_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_reads_pkey" PRIMARY KEY ("request_id", "member_id")
);

CREATE TABLE "request_attachments" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "stored_file_id" UUID NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_attachments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "request_events" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "actor_member_id" UUID NOT NULL,
  "type" "RequestEventType" NOT NULL,
  "comment" VARCHAR(1000),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "employee_absences" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "source_request_id" UUID NOT NULL,
  "type" "RequestSystemCode" NOT NULL,
  "start_date" DATE NOT NULL,
  "end_date" DATE NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelled_at" TIMESTAMPTZ(3),
  CONSTRAINT "employee_absences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_absences_date_order_check" CHECK ("start_date" <= "end_date"),
  CONSTRAINT "employee_absences_type_check" CHECK ("type" IN ('VACATION', 'DAY_OFF', 'SICK_LEAVE', 'ABSENCE'))
);

ALTER TABLE "account_notifications" ADD COLUMN "request_id" UUID;

CREATE UNIQUE INDEX "request_types_organization_id_system_code_key" ON "request_types"("organization_id", "system_code");
CREATE INDEX "request_types_organization_id_is_active_idx" ON "request_types"("organization_id", "is_active");
CREATE INDEX "requests_organization_id_status_created_at_idx" ON "requests"("organization_id", "status", "created_at");
CREATE INDEX "requests_created_by_member_id_status_created_at_idx" ON "requests"("created_by_member_id", "status", "created_at");
CREATE INDEX "requests_request_type_id_created_at_idx" ON "requests"("request_type_id", "created_at");
CREATE INDEX "requests_resolved_at_idx" ON "requests"("resolved_at");
CREATE INDEX "request_reads_member_id_read_at_idx" ON "request_reads"("member_id", "read_at");
CREATE UNIQUE INDEX "request_attachments_stored_file_id_key" ON "request_attachments"("stored_file_id");
CREATE INDEX "request_attachments_request_id_created_at_idx" ON "request_attachments"("request_id", "created_at");
CREATE INDEX "request_events_request_id_created_at_idx" ON "request_events"("request_id", "created_at");
CREATE UNIQUE INDEX "employee_absences_source_request_id_key" ON "employee_absences"("source_request_id");
CREATE INDEX "employee_absences_organization_id_start_date_end_date_idx" ON "employee_absences"("organization_id", "start_date", "end_date");
CREATE INDEX "employee_absences_member_id_start_date_end_date_idx" ON "employee_absences"("member_id", "start_date", "end_date");
CREATE INDEX "account_notifications_request_id_idx" ON "account_notifications"("request_id");

ALTER TABLE "request_types" ADD CONSTRAINT "request_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_created_by_member_id_fkey" FOREIGN KEY ("created_by_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_request_type_id_fkey" FOREIGN KEY ("request_type_id") REFERENCES "request_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_related_shift_id_fkey" FOREIGN KEY ("related_shift_id") REFERENCES "work_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_resolved_by_member_id_fkey" FOREIGN KEY ("resolved_by_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "request_reads" ADD CONSTRAINT "request_reads_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_reads" ADD CONSTRAINT "request_reads_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "organization_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_actor_member_id_fkey" FOREIGN KEY ("actor_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_absences" ADD CONSTRAINT "employee_absences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_absences" ADD CONSTRAINT "employee_absences_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_absences" ADD CONSTRAINT "employee_absences_source_request_id_fkey" FOREIGN KEY ("source_request_id") REFERENCES "requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "request_types" ("id", "organization_id", "name", "description", "system_code", "date_mode", "requires_comment", "allows_attachments")
SELECT gen_random_uuid(), o."id", seed.name, seed.description, seed.code::"RequestSystemCode", seed.mode::"RequestDateMode", seed.requires_comment, seed.allows_attachments
FROM "organizations" o
CROSS JOIN (VALUES
  ('Отпуск', 'Плановый период отсутствия', 'VACATION', 'RANGE', false, true),
  ('Отгул', 'Отсутствие в течение одного дня', 'DAY_OFF', 'SINGLE', false, true),
  ('Больничный', 'Отсутствие по болезни', 'SICK_LEAVE', 'RANGE', false, true),
  ('Отсутствие', 'Другое запланированное отсутствие', 'ABSENCE', 'RANGE', true, true),
  ('Изменение смены', 'Запрос на изменение назначенной смены', 'SHIFT_CHANGE', 'NONE', true, false),
  ('Другое', 'Организационный запрос в свободной форме', 'OTHER', 'NONE', true, true)
) AS seed(name, description, code, mode, requires_comment, allows_attachments)
WHERE o."deleted_at" IS NULL;
