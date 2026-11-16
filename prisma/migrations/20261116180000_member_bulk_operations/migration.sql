CREATE TABLE "member_bulk_operations" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "actor_member_id" UUID NOT NULL,
  "request_key" UUID NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_bulk_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_bulk_operations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_bulk_operations_actor_member_id_fkey" FOREIGN KEY ("actor_member_id") REFERENCES "organization_members"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "member_bulk_operation_request_key"
  ON "member_bulk_operations"("organization_id", "actor_member_id", "request_key");
CREATE INDEX "member_bulk_operations_organization_id_created_at_idx"
  ON "member_bulk_operations"("organization_id", "created_at");
