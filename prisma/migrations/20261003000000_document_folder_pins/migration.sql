CREATE TABLE "document_folder_pins" (
  "user_id" UUID NOT NULL,
  "folder_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_folder_pins_pkey" PRIMARY KEY ("user_id", "folder_id")
);
CREATE INDEX "document_folder_pins_folder_id_idx" ON "document_folder_pins"("folder_id");
ALTER TABLE "document_folder_pins" ADD CONSTRAINT "document_folder_pins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_folder_pins" ADD CONSTRAINT "document_folder_pins_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "document_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
