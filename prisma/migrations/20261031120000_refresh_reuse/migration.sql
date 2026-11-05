ALTER TABLE "auth_sessions" ADD COLUMN "refresh_reuse_detected_at" TIMESTAMPTZ(3);
CREATE TABLE "refresh_token_uses" (
  "token_hash" VARCHAR(64) PRIMARY KEY,
  "session_id" UUID NOT NULL REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
  "consumed_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "refresh_token_uses_session_id_idx" ON "refresh_token_uses"("session_id");
CREATE INDEX "refresh_token_uses_expires_at_idx" ON "refresh_token_uses"("expires_at");
