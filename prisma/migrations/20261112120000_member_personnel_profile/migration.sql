ALTER TABLE "organization_members"
  ADD COLUMN "personnel_first_name" VARCHAR(80),
  ADD COLUMN "personnel_last_name" VARCHAR(80),
  ADD COLUMN "personnel_middle_name" VARCHAR(80),
  ADD COLUMN "work_email" VARCHAR(254),
  ADD COLUMN "work_phone" VARCHAR(12),
  ADD COLUMN "personnel_revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "organization_members" ADD CONSTRAINT "member_personnel_revision_positive" CHECK (personnel_revision > 0);
-- Names, contacts and unknown employment dates are deliberately not copied from accounts.
-- Reuse the existing organization audit, indexed for the fixed personnel history stream.
CREATE INDEX "access_audit_personnel_member_created" ON "access_audit"
  ("organization_id", ("details"->>'memberId'), "created_at" DESC, "id" DESC)
  WHERE "action" = 'PERSONNEL_UPDATED';
