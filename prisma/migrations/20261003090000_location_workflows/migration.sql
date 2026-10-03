-- AlterEnum
ALTER TYPE "SensitiveActionType" ADD VALUE 'ARCHIVE_LOCATION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RequestSystemCode" ADD VALUE 'STAFFING';
ALTER TYPE "RequestSystemCode" ADD VALUE 'STAFFING_RESPONSE';

-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "staffing_position_id" UUID,
ADD COLUMN     "staffing_position_name" VARCHAR(120),
ADD COLUMN     "staffing_request_id" UUID;

-- AlterTable
ALTER TABLE "sensitive_action_tokens" ADD COLUMN     "target_location_id" UUID;

-- AlterTable
ALTER TABLE "document_folders" ADD COLUMN     "visibility" "DocumentVisibility" NOT NULL DEFAULT 'ORGANIZATION';

-- CreateIndex
CREATE UNIQUE INDEX "requests_organization_id_id_key" ON "requests"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "requests_staffing_request_id_created_by_member_id_key" ON "requests"("staffing_request_id", "created_by_member_id");

-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_organization_id_staffing_request_id_fkey" FOREIGN KEY ("organization_id", "staffing_request_id") REFERENCES "requests"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Keep the organization role consistent across every already assigned point.
UPDATE organization_members m SET role = 'ADMIN'
WHERE m.role = 'MEMBER' AND m.left_at IS NULL
AND EXISTS (SELECT 1 FROM location_members lm WHERE lm.member_id = m.id AND lm.left_at IS NULL AND lm.role = 'ADMIN');
UPDATE location_members lm SET role = 'ADMIN'
FROM organization_members m WHERE m.id = lm.member_id AND m.role = 'ADMIN' AND lm.left_at IS NULL;
