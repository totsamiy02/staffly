ALTER TABLE "work_shifts"
  ADD COLUMN "assignment_read_at" TIMESTAMPTZ(3);

CREATE INDEX "work_shifts_member_id_assignment_read_at_idx"
  ON "work_shifts"("member_id", "assignment_read_at");
