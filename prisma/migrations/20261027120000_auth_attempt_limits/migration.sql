CREATE TABLE "auth_attempt_limits" (
    "key" VARCHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "auth_attempt_limits_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "auth_attempt_limits_expires_at_idx" ON "auth_attempt_limits"("expires_at");
