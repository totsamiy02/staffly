BEGIN;
ALTER TABLE "organizations"
  ADD COLUMN "coverage_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "discussion_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Preserve features enabled at any active location. Plans stay location-specific.
UPDATE "organizations" AS organization
SET "coverage_enabled" = existing.coverage_enabled,
    "discussion_enabled" = existing.discussion_enabled
FROM (
  SELECT "organization_id", bool_or("coverage_enabled") AS coverage_enabled,
         bool_or("discussion_enabled") AS discussion_enabled
  FROM "organization_locations"
  WHERE "archived_at" IS NULL
  GROUP BY "organization_id"
) AS existing
WHERE organization."id" = existing."organization_id";
COMMIT;
