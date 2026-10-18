-- A manager may record arrival before departure is known, or departure with
-- the planned arrival. Unrecorded endpoints continue to use the schedule.
ALTER TABLE "work_shifts"
  DROP CONSTRAINT "work_shifts_actual_pair_check",
  DROP CONSTRAINT "work_shifts_actual_range_check",
  DROP CONSTRAINT "work_shifts_actual_break_check";

ALTER TABLE "work_shifts"
  ADD CONSTRAINT "work_shifts_actual_range_check" CHECK (
    COALESCE("actual_end_at", "scheduled_end_at") > COALESCE("actual_start_at", "scheduled_start_at")
  ),
  ADD CONSTRAINT "work_shifts_actual_break_check" CHECK (
    "actual_break_minutes" IS NULL OR (
      "actual_break_minutes" >= 0
      AND ("actual_start_at" IS NOT NULL OR "actual_end_at" IS NOT NULL)
      AND "actual_break_minutes" * 60000 < EXTRACT(EPOCH FROM (
        COALESCE("actual_end_at", "scheduled_end_at") - COALESCE("actual_start_at", "scheduled_start_at")
      )) * 1000
    )
  );
