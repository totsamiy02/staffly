-- Keep referenced definitions for the history and processing of existing requests.
-- Unused custom definitions can be physically deleted.
ALTER TABLE "request_types" ADD COLUMN "deleted_at" TIMESTAMPTZ(3);
