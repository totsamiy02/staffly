ALTER TYPE "AccountNotificationType" ADD VALUE 'SHIFT_ASSIGNED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'SHIFT_CHANGED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'SHIFT_CANCELLED';
ALTER TABLE "account_notifications" ADD COLUMN "shift_id" UUID, ADD COLUMN "email_attempted_at" TIMESTAMPTZ(3);
ALTER TABLE "organization_invites" ADD COLUMN "read_at" TIMESTAMPTZ(3);
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "work_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "account_notifications_user_id_created_at_id_idx" ON "account_notifications"("user_id", "created_at", "id");
CREATE INDEX "account_notifications_shift_id_idx" ON "account_notifications"("shift_id");
CREATE INDEX "account_notifications_user_id_organization_id_email_attempted_idx" ON "account_notifications"("user_id", "organization_id", "email_attempted_at");
CREATE INDEX "organization_invites_invited_email_created_at_id_idx" ON "organization_invites"("invited_email", "created_at", "id");
-- Preserve existing assignment notifications and their read state. Earlier edits cannot be reconstructed.
INSERT INTO "account_notifications" ("id", "user_id", "organization_id", "shift_id", "type", "title", "message", "read_at", "created_at")
SELECT gen_random_uuid(), m."user_id", s."organization_id", s."id", 'SHIFT_ASSIGNED', 'Назначена смена',
  to_char(s."scheduled_start_at" AT TIME ZONE o."timezone", 'DD.MM.YYYY HH24:MI') || ' — ' || to_char(s."scheduled_end_at" AT TIME ZONE o."timezone", 'DD.MM.YYYY HH24:MI'),
  s."assignment_read_at", s."created_at"
FROM "work_shifts" s JOIN "organization_members" m ON m."id" = s."member_id" JOIN "organizations" o ON o."id" = s."organization_id";
UPDATE "organization_invites" SET "read_at" = COALESCE("accepted_at", "rejected_at") WHERE "accepted_at" IS NOT NULL OR "rejected_at" IS NOT NULL;
