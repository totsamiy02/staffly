ALTER TABLE "stored_files"
ADD COLUMN "pending_deletion_at" TIMESTAMPTZ(3),
ADD COLUMN "deletion_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_deletion_error" VARCHAR(500);

CREATE INDEX "stored_files_pending_deletion_at_idx" ON "stored_files"("pending_deletion_at");
