ALTER TABLE "users" ADD COLUMN "security_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "oauth_attempts" ADD COLUMN "purpose" VARCHAR(24) NOT NULL DEFAULT 'LOGIN', ADD COLUMN "security_version" INTEGER;
-- A pre-upgrade handshake did not require step-up authentication. Expire it safely.
UPDATE "oauth_attempts" SET "expires_at" = LEAST("expires_at", CURRENT_TIMESTAMP);
ALTER TABLE "email_deliveries" ADD COLUMN "recipient_email" VARCHAR(254);
CREATE TABLE "email_change_tokens" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "code_hash" VARCHAR(64) NOT NULL,
  "security_version" INTEGER NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_change_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_change_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "email_change_tokens_user_id_used_at_idx" ON "email_change_tokens"("user_id", "used_at");
CREATE INDEX "email_change_tokens_expires_at_idx" ON "email_change_tokens"("expires_at");
