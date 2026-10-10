ALTER TABLE "organization_members" ADD COLUMN "personnel_number" VARCHAR(32);
CREATE UNIQUE INDEX "organization_members_organization_id_personnel_number_key" ON "organization_members"("organization_id", "personnel_number");
ALTER TABLE "organization_members" ADD CONSTRAINT "personnel_number_nonempty" CHECK ("personnel_number" IS NULL OR (length(trim("personnel_number")) > 0 AND "personnel_number" = trim("personnel_number")));
CREATE TABLE "report_templates" (
  "id" UUID PRIMARY KEY,
  "organization_id" UUID NOT NULL,
  "created_by_member_id" UUID NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "config" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "report_templates_creator_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE CASCADE
);
CREATE INDEX "report_templates_organization_id_idx" ON "report_templates"("organization_id");
