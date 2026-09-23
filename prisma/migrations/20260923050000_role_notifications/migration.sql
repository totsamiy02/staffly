CREATE TYPE "AccountNotificationType" AS ENUM ('ROLE_CHANGED');

CREATE TABLE "account_notifications" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "type" "AccountNotificationType" NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "message" VARCHAR(500) NOT NULL,
  "read_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_notifications_user_id_read_at_created_at_idx" ON "account_notifications"("user_id", "read_at", "created_at");
CREATE INDEX "account_notifications_organization_id_idx" ON "account_notifications"("organization_id");
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
