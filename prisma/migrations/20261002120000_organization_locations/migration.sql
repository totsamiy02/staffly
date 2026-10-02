BEGIN;
-- CreateEnum
CREATE TYPE "LocationRole" AS ENUM ('ADMIN', 'MEMBER');

-- AlterTable
ALTER TABLE "work_shifts" ADD COLUMN     "location_id" UUID;

-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "location_id" UUID;

-- AlterTable
ALTER TABLE "organization_invites" ADD COLUMN     "location_id" UUID;

-- AlterTable
ALTER TABLE "shift_templates" ADD COLUMN     "location_id" UUID;

-- AlterTable
ALTER TABLE "document_folders" ADD COLUMN     "location_id" UUID;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "location_id" UUID;

-- CreateTable
CREATE TABLE "organization_locations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "monthly_work_minutes" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "organization_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_members" (
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "role" "LocationRole" NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),

    CONSTRAINT "location_members_pkey" PRIMARY KEY ("location_id","member_id")
);

-- CreateTable
CREATE TABLE "location_teams" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,

    CONSTRAINT "location_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_team_members" (
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,

    CONSTRAINT "location_team_members_pkey" PRIMARY KEY ("team_id","member_id")
);

-- CreateTable
CREATE TABLE "location_transfers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "created_by_member_id" UUID NOT NULL,
    "from_location_id" UUID NOT NULL,
    "to_location_id" UUID NOT NULL,
    "temporary" BOOLEAN NOT NULL DEFAULT false,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_locations_organization_id_archived_at_idx" ON "organization_locations"("organization_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "organization_locations_organization_id_id_key" ON "organization_locations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "location_members_member_id_left_at_idx" ON "location_members"("member_id", "left_at");

-- CreateIndex
CREATE UNIQUE INDEX "location_teams_organization_id_id_key" ON "location_teams"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "location_teams_location_id_name_key" ON "location_teams"("location_id", "name");

-- CreateIndex
CREATE INDEX "location_transfers_organization_id_to_location_id_member_id_idx" ON "location_transfers"("organization_id", "to_location_id", "member_id", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_id_key" ON "organization_members"("organization_id", "id");

-- CreateIndex
CREATE INDEX "work_shifts_organization_id_location_id_idx" ON "work_shifts"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "requests_organization_id_location_id_idx" ON "requests"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "organization_invites_organization_id_location_id_idx" ON "organization_invites"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "shift_templates_organization_id_location_id_idx" ON "shift_templates"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "document_folders_organization_id_location_id_idx" ON "document_folders"("organization_id", "location_id");

-- CreateIndex
CREATE INDEX "documents_organization_id_location_id_idx" ON "documents"("organization_id", "location_id");

-- AddForeignKey
ALTER TABLE "work_shifts" ADD CONSTRAINT "work_shifts_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_locations" ADD CONSTRAINT "organization_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_members" ADD CONSTRAINT "location_members_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_members" ADD CONSTRAINT "location_members_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_teams" ADD CONSTRAINT "location_teams_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_team_members" ADD CONSTRAINT "location_team_members_organization_id_team_id_fkey" FOREIGN KEY ("organization_id", "team_id") REFERENCES "location_teams"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_team_members" ADD CONSTRAINT "location_team_members_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_transfers" ADD CONSTRAINT "location_transfers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_transfers" ADD CONSTRAINT "location_transfers_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_transfers" ADD CONSTRAINT "location_transfers_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_transfers" ADD CONSTRAINT "location_transfers_organization_id_from_location_id_fkey" FOREIGN KEY ("organization_id", "from_location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_transfers" ADD CONSTRAINT "location_transfers_organization_id_to_location_id_fkey" FOREIGN KEY ("organization_id", "to_location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill before enforcing point ownership. Existing documents remain organization-wide.
INSERT INTO organization_locations (id, organization_id, name, city, address, timezone, monthly_work_minutes, created_at)
SELECT gen_random_uuid(), id, 'Основная точка', '', COALESCE(address, ''), timezone, monthly_work_minutes, created_at FROM organizations;
INSERT INTO location_members (organization_id, location_id, member_id, role, joined_at, left_at)
SELECT m.organization_id, l.id, m.id, CASE WHEN m.role = 'ADMIN' THEN 'ADMIN'::"LocationRole" ELSE 'MEMBER'::"LocationRole" END, m.joined_at, m.left_at
FROM organization_members m JOIN organization_locations l ON l.organization_id = m.organization_id;
UPDATE work_shifts s SET location_id = l.id FROM organization_locations l WHERE l.organization_id = s.organization_id;
UPDATE requests r SET location_id = l.id FROM organization_locations l WHERE l.organization_id = r.organization_id;
UPDATE shift_templates t SET location_id = l.id FROM organization_locations l WHERE l.organization_id = t.organization_id;
UPDATE organization_invites i SET location_id = l.id FROM organization_locations l WHERE l.organization_id = i.organization_id;
UPDATE organization_members SET role = 'MEMBER' WHERE role = 'ADMIN';
ALTER TABLE work_shifts ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE requests ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE shift_templates ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE location_transfers ADD CONSTRAINT location_transfers_period_check CHECK (from_location_id <> to_location_id AND ((temporary AND end_at > start_at) OR (NOT temporary AND end_at IS NULL)));
COMMIT;
