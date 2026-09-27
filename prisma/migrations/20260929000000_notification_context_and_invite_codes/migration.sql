ALTER TABLE "organization_invites" ADD COLUMN "code_ciphertext" TEXT, ADD COLUMN "notification_hidden_at" TIMESTAMPTZ(3);
ALTER TABLE "account_notifications" ADD COLUMN "hidden_at" TIMESTAMPTZ(3);
ALTER TABLE "employee_absences" ADD COLUMN "reason" VARCHAR(32), ADD COLUMN "comment" VARCHAR(500);
