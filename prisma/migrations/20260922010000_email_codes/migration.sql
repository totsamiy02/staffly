ALTER TABLE "users" ADD COLUMN "last_security_email_at" TIMESTAMPTZ(3);
ALTER TABLE "email_verification_tokens" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "password_reset_tokens" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
