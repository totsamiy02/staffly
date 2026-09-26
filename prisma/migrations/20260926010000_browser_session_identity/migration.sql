ALTER TABLE "auth_sessions" ADD COLUMN "browser_token_hash" VARCHAR(64);
CREATE INDEX "auth_sessions_browser_token_hash_revoked_at_idx" ON "auth_sessions"("browser_token_hash", "revoked_at");
