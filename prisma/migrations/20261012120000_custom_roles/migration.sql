-- AlterEnum
ALTER TYPE "DocumentVisibility" ADD VALUE 'SELECTED';

-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "access_configured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "access_role_id" UUID;

-- AlterTable
ALTER TABLE "document_folders" ADD COLUMN     "audience_member_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "audience_role_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "inherit_access" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "audience_member_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "audience_role_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "inherit_access" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "organization_events" ADD COLUMN     "audience_access_role_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "access_roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "system_code" "OrganizationRole",
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_assignments" (
    "organization_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "access_assignments_pkey" PRIMARY KEY ("member_id","location_id")
);

-- CreateTable
CREATE TABLE "access_audit" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_member_id" UUID NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_roles_organization_id_id_key" ON "access_roles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "access_roles_organization_id_system_code_key" ON "access_roles"("organization_id", "system_code");

-- CreateIndex
CREATE INDEX "access_assignments_organization_id_role_id_idx" ON "access_assignments"("organization_id", "role_id");

-- CreateIndex
CREATE INDEX "access_audit_organization_id_created_at_idx" ON "access_audit"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_access_role_id_fkey" FOREIGN KEY ("organization_id", "access_role_id") REFERENCES "access_roles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_assignments" ADD CONSTRAINT "access_assignments_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_assignments" ADD CONSTRAINT "access_assignments_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_assignments" ADD CONSTRAINT "access_assignments_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "access_roles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_audit" ADD CONSTRAINT "access_audit_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed independent organization role catalogues, retaining legacy memberships.
INSERT INTO access_roles (id, organization_id, name, system_code, permissions)
SELECT gen_random_uuid(), id, 'Владелец', 'OWNER'::"OrganizationRole", ARRAY['members.view','members.contacts','members.personnel.view','members.personnel.edit','members.invite','members.invites.revoke','members.positions','members.assign','members.remove','members.exclude','schedule.own','schedule.view','schedule.history','schedule.create','schedule.edit','schedule.cancel','schedule.actual','schedule.templates','schedule.settings','absences.own','absences.view','absences.details','absences.edit','absences.cancel','requests.own','requests.create','requests.edit','requests.view','requests.resolve','requests.attachments','staffing.create','staffing.respond','staffing.resolve','offers.transfer','offers.swap','offers.accept','offers.approve','offers.settings','statistics.own','statistics.view','reports.preview','reports.export','reports.templates','reports.templates.all','documents.view','documents.download','documents.upload','documents.folders','documents.edit','documents.delete','documents.access','documents.assign','documents.control','documents.personal.view','documents.personal.edit','documents.shared','events.view','events.create','events.edit','events.cancel','events.shared','dashboard.view','locations.browse','locations.edit','locations.create','organization.edit','positions.manage','requestTypes.manage']::text[] FROM organizations
UNION ALL
SELECT gen_random_uuid(), id, 'Администратор', 'ADMIN'::"OrganizationRole", ARRAY['members.view','members.contacts','members.personnel.view','members.personnel.edit','members.invite','members.invites.revoke','members.positions','members.assign','members.remove','schedule.own','schedule.view','schedule.history','schedule.create','schedule.edit','schedule.cancel','schedule.actual','schedule.templates','schedule.settings','absences.own','absences.view','absences.details','absences.edit','absences.cancel','requests.own','requests.create','requests.edit','requests.view','requests.resolve','requests.attachments','staffing.create','staffing.respond','staffing.resolve','offers.transfer','offers.swap','offers.accept','offers.approve','statistics.own','statistics.view','reports.preview','reports.export','reports.templates','documents.view','documents.download','documents.upload','documents.folders','documents.edit','documents.delete','documents.access','documents.assign','documents.control','documents.personal.view','documents.personal.edit','events.view','events.create','events.edit','events.cancel','dashboard.view','locations.edit','locations.browse']::text[] FROM organizations
UNION ALL
SELECT gen_random_uuid(), id, 'Пользователь', 'MEMBER'::"OrganizationRole", ARRAY['members.view','members.contacts','schedule.own','schedule.view','absences.own','requests.own','requests.create','requests.edit','staffing.respond','offers.transfer','offers.swap','offers.accept','statistics.own','documents.view','documents.download','events.view','locations.browse','dashboard.view']::text[] FROM organizations;
INSERT INTO access_assignments (organization_id, member_id, location_id, role_id) SELECT lm.organization_id, lm.member_id, lm.location_id, r.id FROM location_members lm JOIN organization_members m ON m.id = lm.member_id JOIN access_roles r ON r.organization_id = lm.organization_id AND r.system_code::text = lm.role::text WHERE lm.left_at IS NULL AND m.left_at IS NULL AND m.role <> 'OWNER';
