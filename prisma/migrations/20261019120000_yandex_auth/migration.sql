ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" TIMESTAMPTZ(3), ADD COLUMN "data_consent_at" TIMESTAMPTZ(3);
CREATE TABLE "auth_identities" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" VARCHAR(24) NOT NULL,
  "subject" VARCHAR(128) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_login_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "auth_identities_provider_subject_key" ON "auth_identities"("provider", "subject");
CREATE UNIQUE INDEX "auth_identities_user_id_provider_key" ON "auth_identities"("user_id", "provider");
CREATE TABLE "oauth_attempts" (
  "id" UUID NOT NULL,
  "state_hash" VARCHAR(64) NOT NULL,
  "browser_hash" VARCHAR(64) NOT NULL,
  "code_verifier" VARCHAR(128),
  "stage" VARCHAR(20) NOT NULL DEFAULT 'STARTED',
  "return_to" VARCHAR(2048) NOT NULL,
  "user_id" UUID,
  "session_id" UUID,
  "profile" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oauth_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "oauth_attempts_state_hash_key" ON "oauth_attempts"("state_hash");
CREATE INDEX "oauth_attempts_expires_at_idx" ON "oauth_attempts"("expires_at");
