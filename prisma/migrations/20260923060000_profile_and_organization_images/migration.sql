CREATE TYPE "StoredFilePurpose" AS ENUM ('USER_AVATAR', 'ORGANIZATION_LOGO');

CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "object_key" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "purpose" "StoredFilePurpose" NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "organization_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "users" ADD COLUMN "avatar_file_id" UUID;
ALTER TABLE "organizations" ADD COLUMN "logo_file_id" UUID;

CREATE UNIQUE INDEX "stored_files_object_key_key" ON "stored_files"("object_key");
CREATE INDEX "stored_files_uploaded_by_user_id_idx" ON "stored_files"("uploaded_by_user_id");
CREATE INDEX "stored_files_organization_id_idx" ON "stored_files"("organization_id");
CREATE UNIQUE INDEX "users_avatar_file_id_key" ON "users"("avatar_file_id");
CREATE UNIQUE INDEX "organizations_logo_file_id_key" ON "organizations"("logo_file_id");

ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_file_id_fkey" FOREIGN KEY ("avatar_file_id") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_logo_file_id_fkey" FOREIGN KEY ("logo_file_id") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
