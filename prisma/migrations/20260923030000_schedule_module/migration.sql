CREATE TYPE "WorkShiftStatus" AS ENUM ('SCHEDULED', 'CANCELLED');

ALTER TABLE "organization_members"
  ADD COLUMN "left_at" TIMESTAMPTZ(3);

CREATE TABLE "work_shifts" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "created_by_member_id" UUID NOT NULL,
  "scheduled_start_at" TIMESTAMPTZ(3) NOT NULL,
  "scheduled_end_at" TIMESTAMPTZ(3) NOT NULL,
  "break_minutes" INTEGER NOT NULL DEFAULT 0,
  "actual_start_at" TIMESTAMPTZ(3),
  "actual_end_at" TIMESTAMPTZ(3),
  "actual_break_minutes" INTEGER,
  "description" VARCHAR(500),
  "status" "WorkShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
  "cancelled_at" TIMESTAMPTZ(3),
  "cancelled_by_member_id" UUID,
  "cancellation_reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_shifts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_shifts_schedule_range_check" CHECK ("scheduled_end_at" > "scheduled_start_at"),
  CONSTRAINT "work_shifts_break_check" CHECK ("break_minutes" >= 0 AND "break_minutes" * 60000 < EXTRACT(EPOCH FROM ("scheduled_end_at" - "scheduled_start_at")) * 1000),
  CONSTRAINT "work_shifts_actual_pair_check" CHECK (("actual_start_at" IS NULL) = ("actual_end_at" IS NULL)),
  CONSTRAINT "work_shifts_actual_range_check" CHECK ("actual_start_at" IS NULL OR "actual_end_at" > "actual_start_at"),
  CONSTRAINT "work_shifts_actual_break_check" CHECK ("actual_break_minutes" IS NULL OR ("actual_break_minutes" >= 0 AND "actual_start_at" IS NOT NULL AND "actual_break_minutes" * 60000 < EXTRACT(EPOCH FROM ("actual_end_at" - "actual_start_at")) * 1000)),
  CONSTRAINT "work_shifts_description_check" CHECK ("description" IS NULL OR ("description" = btrim("description") AND char_length("description") BETWEEN 1 AND 500)),
  CONSTRAINT "work_shifts_cancellation_check" CHECK (("status" = 'SCHEDULED' AND "cancelled_at" IS NULL AND "cancelled_by_member_id" IS NULL AND "cancellation_reason" IS NULL) OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL)),
  CONSTRAINT "work_shifts_cancellation_reason_check" CHECK ("cancellation_reason" IS NULL OR ("cancellation_reason" = btrim("cancellation_reason") AND char_length("cancellation_reason") BETWEEN 3 AND 500))
);

CREATE TABLE "work_shift_adjustments" (
  "id" UUID NOT NULL,
  "shift_id" UUID NOT NULL,
  "changed_by_member_id" UUID NOT NULL,
  "previous_start_at" TIMESTAMPTZ(3) NOT NULL,
  "previous_end_at" TIMESTAMPTZ(3) NOT NULL,
  "previous_break_minutes" INTEGER NOT NULL,
  "new_start_at" TIMESTAMPTZ(3) NOT NULL,
  "new_end_at" TIMESTAMPTZ(3) NOT NULL,
  "new_break_minutes" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_shift_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_shift_adjustments_previous_range_check" CHECK ("previous_end_at" > "previous_start_at" AND "previous_break_minutes" >= 0),
  CONSTRAINT "work_shift_adjustments_new_range_check" CHECK ("new_end_at" > "new_start_at" AND "new_break_minutes" >= 0 AND "new_break_minutes" * 60000 < EXTRACT(EPOCH FROM ("new_end_at" - "new_start_at")) * 1000),
  CONSTRAINT "work_shift_adjustments_reason_check" CHECK ("reason" = btrim("reason") AND char_length("reason") BETWEEN 3 AND 500)
);

CREATE INDEX "organization_members_organization_id_left_at_idx" ON "organization_members"("organization_id", "left_at");
CREATE INDEX "work_shifts_organization_id_scheduled_start_at_idx" ON "work_shifts"("organization_id", "scheduled_start_at");
CREATE INDEX "work_shifts_organization_id_scheduled_end_at_idx" ON "work_shifts"("organization_id", "scheduled_end_at");
CREATE INDEX "work_shifts_organization_id_member_id_scheduled_start_at_idx" ON "work_shifts"("organization_id", "member_id", "scheduled_start_at");
CREATE INDEX "work_shifts_member_id_scheduled_start_at_idx" ON "work_shifts"("member_id", "scheduled_start_at");
CREATE INDEX "work_shift_adjustments_shift_id_created_at_idx" ON "work_shift_adjustments"("shift_id", "created_at");
CREATE INDEX "work_shift_adjustments_changed_by_member_id_idx" ON "work_shift_adjustments"("changed_by_member_id");

CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "work_shifts" ADD CONSTRAINT "work_shifts_no_overlap" EXCLUDE USING gist (
  "member_id" WITH =,
  tstzrange("scheduled_start_at", "scheduled_end_at", '[)') WITH &&
) WHERE ("status" = 'SCHEDULED');

ALTER TABLE "work_shifts" ADD CONSTRAINT "work_shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_shifts" ADD CONSTRAINT "work_shifts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_shifts" ADD CONSTRAINT "work_shifts_created_by_member_id_fkey" FOREIGN KEY ("created_by_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_shifts" ADD CONSTRAINT "work_shifts_cancelled_by_member_id_fkey" FOREIGN KEY ("cancelled_by_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_shift_adjustments" ADD CONSTRAINT "work_shift_adjustments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "work_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_shift_adjustments" ADD CONSTRAINT "work_shift_adjustments_changed_by_member_id_fkey" FOREIGN KEY ("changed_by_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
