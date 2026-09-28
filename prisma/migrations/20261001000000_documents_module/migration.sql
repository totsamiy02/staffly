-- CreateEnum
CREATE TYPE "DocumentVisibility" AS ENUM ('ORGANIZATION', 'ADMINS', 'PRIVATE_MEMBER');

-- AlterEnum
ALTER TYPE "AccountNotificationType" ADD VALUE 'DOCUMENT_ASSIGNED';

-- AlterEnum
ALTER TYPE "StoredFilePurpose" ADD VALUE 'DOCUMENT';

-- AlterTable
ALTER TABLE "account_notifications" ADD COLUMN     "document_id" UUID;

-- CreateTable
CREATE TABLE "document_folders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "stored_file_id" UUID NOT NULL,
    "folder_id" UUID,
    "display_name" VARCHAR(255) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "visibility" "DocumentVisibility" NOT NULL,
    "uploaded_by_member_id" UUID NOT NULL,
    "target_member_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_acknowledgements" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "assigned_by_member_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "deadline" DATE,
    "comment" VARCHAR(1000),

    CONSTRAINT "document_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_folders_organization_id_parent_id_idx" ON "document_folders"("organization_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_stored_file_id_key" ON "documents"("stored_file_id");

-- CreateIndex
CREATE INDEX "documents_organization_id_deleted_at_folder_id_created_at_idx" ON "documents"("organization_id", "deleted_at", "folder_id", "created_at");

-- CreateIndex
CREATE INDEX "documents_organization_id_target_member_id_deleted_at_idx" ON "documents"("organization_id", "target_member_id", "deleted_at");

-- CreateIndex
CREATE INDEX "document_acknowledgements_member_id_acknowledged_at_cancell_idx" ON "document_acknowledgements"("member_id", "acknowledged_at", "cancelled_at");

-- CreateIndex
CREATE INDEX "document_acknowledgements_document_id_cancelled_at_acknowle_idx" ON "document_acknowledgements"("document_id", "cancelled_at", "acknowledged_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_acknowledgements_document_id_member_id_key" ON "document_acknowledgements"("document_id", "member_id");

-- CreateIndex
CREATE INDEX "account_notifications_document_id_idx" ON "account_notifications"("document_id");

-- AddForeignKey
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "document_folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "document_folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_member_id_fkey" FOREIGN KEY ("uploaded_by_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_target_member_id_fkey" FOREIGN KEY ("target_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_assigned_by_member_id_fkey" FOREIGN KEY ("assigned_by_member_id") REFERENCES "organization_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

