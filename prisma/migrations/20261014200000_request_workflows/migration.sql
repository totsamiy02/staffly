-- CreateEnum
CREATE TYPE "ShiftAttendance" AS ENUM ('UNCONFIRMED', 'WORKED', 'PARTIAL', 'NO_SHOW');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RequestEventType" ADD VALUE 'SUBMITTED';
ALTER TYPE "RequestEventType" ADD VALUE 'RETURNED';
ALTER TYPE "RequestEventType" ADD VALUE 'STAGE_APPROVED';
ALTER TYPE "RequestEventType" ADD VALUE 'CHANGED';
ALTER TYPE "RequestEventType" ADD VALUE 'EXPIRED';
ALTER TYPE "RequestEventType" ADD VALUE 'INVALID';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RequestStatus" ADD VALUE 'DRAFT';
ALTER TYPE "RequestStatus" ADD VALUE 'RETURNED';
ALTER TYPE "RequestStatus" ADD VALUE 'REGISTERED';
ALTER TYPE "RequestStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "RequestStatus" ADD VALUE 'INVALID';





-- DropIndex
DROP INDEX "requests_staffing_request_id_created_by_member_id_key";


-- AlterTable
ALTER TABLE "request_events" ADD COLUMN     "changes" JSONB;

-- AlterTable
ALTER TABLE "request_types" ADD COLUMN     "definition" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "answers" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "approval_step" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "author_member_id" UUID,
ADD COLUMN     "campaign_id" UUID,
ADD COLUMN     "due_at" TIMESTAMPTZ(3),
ADD COLUMN     "form_snapshot" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "outcome" JSONB,
ADD COLUMN     "reminded_at" TIMESTAMPTZ(3),
ADD COLUMN     "submission_key" VARCHAR(100);

-- AlterTable
ALTER TABLE "work_shifts" ADD COLUMN     "attendance" "ShiftAttendance" NOT NULL DEFAULT 'UNCONFIRMED',
ADD COLUMN     "attendance_reason" VARCHAR(500);

-- CreateTable
CREATE TABLE "vacation_campaigns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "created_by_member_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "year" INTEGER NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "member_ids" UUID[],
    "standard_days" INTEGER NOT NULL DEFAULT 28,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vacation_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vacation_campaigns_organization_id_year_idx" ON "vacation_campaigns"("organization_id", "year");

-- CreateIndex
CREATE INDEX "requests_staffing_request_id_created_by_member_id_idx" ON "requests"("staffing_request_id", "created_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "requests_organization_id_submission_key_key" ON "requests"("organization_id", "submission_key");




-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "vacation_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vacation_campaigns" ADD CONSTRAINT "vacation_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Only one live response per employee; withdrawn responses remain in history.
CREATE UNIQUE INDEX requests_active_staffing_response_key ON requests (staffing_request_id, created_by_member_id) WHERE staffing_request_id IS NOT NULL AND status IN ('PENDING','APPROVED');
ALTER TABLE requests ADD CONSTRAINT requests_author_tenant_fkey FOREIGN KEY (organization_id, author_member_id) REFERENCES organization_members(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE vacation_campaigns ADD CONSTRAINT vacation_campaign_location_tenant_fkey FOREIGN KEY (organization_id,location_id) REFERENCES organization_locations(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE vacation_campaigns ADD CONSTRAINT vacation_campaign_author_tenant_fkey FOREIGN KEY (organization_id,created_by_member_id) REFERENCES organization_members(organization_id,id) ON DELETE RESTRICT;

ALTER TABLE requests ADD COLUMN amendment_of_id UUID;
ALTER TABLE requests ADD CONSTRAINT request_amendment_tenant_fkey FOREIGN KEY (organization_id,amendment_of_id) REFERENCES requests(organization_id,id) ON DELETE RESTRICT;
