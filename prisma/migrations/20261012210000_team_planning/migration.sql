-- CreateEnum
CREATE TYPE "ScheduleDraftStatus" AS ENUM ('PREPARING', 'OPEN', 'CLOSED', 'APPLIED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AccountNotificationType" ADD VALUE 'SCHEDULE_DISCUSSION';

-- AlterTable
ALTER TABLE "account_notifications" ADD COLUMN     "schedule_draft_id" UUID;

-- AlterTable
ALTER TABLE "organization_locations" ADD COLUMN     "coverage_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "discussion_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "discussion_hours" INTEGER NOT NULL DEFAULT 24;

-- CreateTable
CREATE TABLE "demand_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "days" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demand_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demand_exceptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "intervals" JSONB NOT NULL,

    CONSTRAINT "demand_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_drafts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "author_member_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "status" "ScheduleDraftStatus" NOT NULL DEFAULT 'PREPARING',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "deadline" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "finished_by_member_id" UUID,
    "appliedSnapshot" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_shifts" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "source_shift_id" UUID,
    "source" JSONB,
    "proposed" JSONB NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "revision" INTEGER NOT NULL,
    "applied_shift_id" UUID,

    CONSTRAINT "draft_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_recipients" (
    "draft_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "required_revision" INTEGER NOT NULL,
    "response" VARCHAR(20),
    "responded_revision" INTEGER,
    "responded_at" TIMESTAMPTZ(3),

    CONSTRAINT "draft_recipients_pkey" PRIMARY KEY ("draft_id","member_id")
);

-- CreateTable
CREATE TABLE "draft_comments" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "proposal_id" UUID,
    "date" DATE,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "decision" VARCHAR(2000),
    "decided_by_member_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "actor_member_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "demand_versions_location_id_effective_from_created_at_idx" ON "demand_versions"("location_id", "effective_from", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "demand_exceptions_location_id_date_key" ON "demand_exceptions"("location_id", "date");

-- CreateIndex
CREATE INDEX "schedule_drafts_location_id_status_from_date_to_date_idx" ON "schedule_drafts"("location_id", "status", "from_date", "to_date");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_drafts_organization_id_id_key" ON "schedule_drafts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "draft_shifts_draft_id_source_shift_id_key" ON "draft_shifts"("draft_id", "source_shift_id");

-- CreateIndex
CREATE INDEX "draft_comments_draft_id_created_at_idx" ON "draft_comments"("draft_id", "created_at");

-- CreateIndex
CREATE INDEX "draft_history_draft_id_created_at_idx" ON "draft_history"("draft_id", "created_at");

-- AddForeignKey
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_organization_id_schedule_draft_id_fkey" FOREIGN KEY ("organization_id", "schedule_draft_id") REFERENCES "schedule_drafts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demand_versions" ADD CONSTRAINT "demand_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demand_versions" ADD CONSTRAINT "demand_versions_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demand_exceptions" ADD CONSTRAINT "demand_exceptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demand_exceptions" ADD CONSTRAINT "demand_exceptions_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_drafts" ADD CONSTRAINT "schedule_drafts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_drafts" ADD CONSTRAINT "schedule_drafts_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_drafts" ADD CONSTRAINT "schedule_drafts_organization_id_author_member_id_fkey" FOREIGN KEY ("organization_id", "author_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_shifts" ADD CONSTRAINT "draft_shifts_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "schedule_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_recipients" ADD CONSTRAINT "draft_recipients_organization_id_draft_id_fkey" FOREIGN KEY ("organization_id", "draft_id") REFERENCES "schedule_drafts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_recipients" ADD CONSTRAINT "draft_recipients_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_comments" ADD CONSTRAINT "draft_comments_organization_id_draft_id_fkey" FOREIGN KEY ("organization_id", "draft_id") REFERENCES "schedule_drafts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_comments" ADD CONSTRAINT "draft_comments_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_history" ADD CONSTRAINT "draft_history_organization_id_draft_id_fkey" FOREIGN KEY ("organization_id", "draft_id") REFERENCES "schedule_drafts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_history" ADD CONSTRAINT "draft_history_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Upgrade only the untouched recommended administrator preset. Customised roles keep their grants.
UPDATE access_roles SET permissions = permissions || ARRAY['coverage.view','coverage.manage','drafts.view','drafts.edit','drafts.discuss','drafts.resolve','drafts.apply']::text[], revision = revision + 1
WHERE system_code = 'ADMIN' AND permissions @> ARRAY['members.view','members.contacts','members.personnel.view','members.personnel.edit','members.invite','members.invites.revoke','members.positions','members.assign','members.remove','schedule.own','schedule.view','schedule.history','schedule.create','schedule.edit','schedule.cancel','schedule.actual','schedule.templates','schedule.settings','absences.own','absences.view','absences.details','absences.edit','absences.cancel','requests.own','requests.create','requests.edit','requests.view','requests.resolve','requests.attachments','staffing.create','staffing.respond','staffing.resolve','offers.transfer','offers.swap','offers.accept','offers.approve','statistics.own','statistics.view','reports.preview','reports.export','reports.templates','documents.view','documents.download','documents.upload','documents.folders','documents.edit','documents.delete','documents.access','documents.assign','documents.control','documents.personal.view','documents.personal.edit','events.view','events.create','events.edit','events.cancel','dashboard.view','locations.edit','locations.browse']::text[] AND permissions <@ ARRAY['members.view','members.contacts','members.personnel.view','members.personnel.edit','members.invite','members.invites.revoke','members.positions','members.assign','members.remove','schedule.own','schedule.view','schedule.history','schedule.create','schedule.edit','schedule.cancel','schedule.actual','schedule.templates','schedule.settings','absences.own','absences.view','absences.details','absences.edit','absences.cancel','requests.own','requests.create','requests.edit','requests.view','requests.resolve','requests.attachments','staffing.create','staffing.respond','staffing.resolve','offers.transfer','offers.swap','offers.accept','offers.approve','statistics.own','statistics.view','reports.preview','reports.export','reports.templates','documents.view','documents.download','documents.upload','documents.folders','documents.edit','documents.delete','documents.access','documents.assign','documents.control','documents.personal.view','documents.personal.edit','events.view','events.create','events.edit','events.cancel','dashboard.view','locations.edit','locations.browse']::text[];

ALTER TABLE organization_locations ADD CONSTRAINT location_discussion_hours_check CHECK (discussion_hours BETWEEN 1 AND 720);
ALTER TABLE schedule_drafts ADD CONSTRAINT schedule_draft_period_check CHECK (to_date >= from_date AND to_date - from_date < 62);
CREATE INDEX account_notifications_schedule_draft_id_idx ON account_notifications(schedule_draft_id);
