-- AlterEnum
ALTER TYPE "RequestSystemCode" ADD VALUE 'SHIFT_PROPOSAL';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "monthly_work_minutes" INTEGER;

-- AlterTable
ALTER TABLE "work_shifts" ADD COLUMN     "position_id" UUID,
ADD COLUMN     "position_name_snapshot" VARCHAR(120);

-- CreateTable
CREATE TABLE "organization_positions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "organization_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_positions" (
    "member_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,

    CONSTRAINT "member_positions_pkey" PRIMARY KEY ("member_id","position_id")
);

-- CreateTable
CREATE TABLE "shift_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "position_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,
    "end_day_offset" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_positions_organization_id_name_key" ON "organization_positions"("organization_id", "name");

-- CreateIndex
CREATE INDEX "shift_templates_organization_id_is_active_idx" ON "shift_templates"("organization_id", "is_active");

-- AddForeignKey
ALTER TABLE "work_shifts" ADD CONSTRAINT "work_shifts_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "organization_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_positions" ADD CONSTRAINT "organization_positions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_positions" ADD CONSTRAINT "member_positions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "organization_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_positions" ADD CONSTRAINT "member_positions_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "organization_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "organization_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE organizations ADD CONSTRAINT organizations_monthly_work_minutes_check CHECK (monthly_work_minutes IS NULL OR monthly_work_minutes BETWEEN 60 AND 44640);
ALTER TABLE shift_templates ADD CONSTRAINT shift_templates_time_check CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND end_day_offset IN (0,1) AND (end_day_offset = 1 OR end_time > start_time));
