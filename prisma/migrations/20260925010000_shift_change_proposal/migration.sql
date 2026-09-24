ALTER TABLE "requests"
  ADD COLUMN "original_start_at" TIMESTAMPTZ(3),
  ADD COLUMN "original_end_at" TIMESTAMPTZ(3),
  ADD COLUMN "proposed_start_at" TIMESTAMPTZ(3),
  ADD COLUMN "proposed_end_at" TIMESTAMPTZ(3);
