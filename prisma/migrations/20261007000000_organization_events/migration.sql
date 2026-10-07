-- CreateEnum
CREATE TYPE "EventAudienceMode" AS ENUM ('ALL', 'ROLES', 'SELECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccountNotificationType" ADD VALUE 'EVENT_PUBLISHED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'EVENT_CHANGED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'EVENT_CANCELLED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'EVENT_STARTED';

-- AlterTable
ALTER TABLE "account_notifications" ADD COLUMN     "event_delivery_key" VARCHAR(200),
ADD COLUMN     "event_id" UUID;

-- CreateTable
CREATE TABLE "organization_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(4000),
    "type_label" VARCHAR(80),
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3),
    "timezone" VARCHAR(64) NOT NULL,
    "place" VARCHAR(300),
    "meeting_url" VARCHAR(2048),
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "audience_mode" "EventAudienceMode" NOT NULL,
    "audience_roles" "LocationRole"[] DEFAULT ARRAY[]::"LocationRole"[],
    "created_by_member_id" UUID NOT NULL,
    "updated_by_member_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),
    "start_notified_at" TIMESTAMPTZ(3),

    CONSTRAINT "organization_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_locations" (
    "organization_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,

    CONSTRAINT "event_locations_pkey" PRIMARY KEY ("event_id","location_id")
);

-- CreateTable
CREATE TABLE "event_recipients" (
    "organization_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "event_recipients_pkey" PRIMARY KEY ("event_id","member_id")
);

-- CreateTable
CREATE TABLE "event_changes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_events_organization_id_start_at_id_idx" ON "organization_events"("organization_id", "start_at", "id");

-- CreateIndex
CREATE INDEX "organization_events_cancelled_at_start_notified_at_start_at_idx" ON "organization_events"("cancelled_at", "start_notified_at", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "organization_events_organization_id_id_key" ON "organization_events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "event_locations_organization_id_location_id_idx" ON "event_locations"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "event_recipients_member_id_removed_at_idx" ON "event_recipients"("member_id", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "event_changes_event_id_revision_key" ON "event_changes"("event_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "account_notifications_event_delivery_key_key" ON "account_notifications"("event_delivery_key");

-- CreateIndex
CREATE INDEX "account_notifications_event_id_idx" ON "account_notifications"("event_id");

-- AddForeignKey
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_organization_id_event_id_fkey" FOREIGN KEY ("organization_id", "event_id") REFERENCES "organization_events"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_events" ADD CONSTRAINT "organization_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_events" ADD CONSTRAINT "organization_events_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_events" ADD CONSTRAINT "organization_events_organization_id_updated_by_member_id_fkey" FOREIGN KEY ("organization_id", "updated_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_locations" ADD CONSTRAINT "event_locations_organization_id_event_id_fkey" FOREIGN KEY ("organization_id", "event_id") REFERENCES "organization_events"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_locations" ADD CONSTRAINT "event_locations_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_recipients" ADD CONSTRAINT "event_recipients_organization_id_event_id_fkey" FOREIGN KEY ("organization_id", "event_id") REFERENCES "organization_events"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_recipients" ADD CONSTRAINT "event_recipients_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_changes" ADD CONSTRAINT "event_changes_organization_id_event_id_fkey" FOREIGN KEY ("organization_id", "event_id") REFERENCES "organization_events"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_changes" ADD CONSTRAINT "event_changes_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Keep invalid periods and non-web meeting links out of the event records.
ALTER TABLE "organization_events" ADD CONSTRAINT "organization_events_period_check" CHECK (end_at IS NULL OR end_at > start_at);
ALTER TABLE "organization_events" ADD CONSTRAINT "organization_events_revision_check" CHECK (revision > 0);
ALTER TABLE "organization_events" ADD CONSTRAINT "organization_events_meeting_url_check" CHECK (meeting_url IS NULL OR meeting_url ~* '^https?://');
