-- A populated pre-model backup can be restored into a server configured as UTC.
-- The target server's setting is NOT evidence of the source data's time model.
-- Require an explicit, reviewed source zone for that adoption. Fresh databases
-- and conversions already verified from a named legacy zone remain ready.
ALTER TABLE app_time_model ALTER COLUMN source_timezone DROP NOT NULL;
UPDATE app_time_model SET version='legacy-v0', source_timezone=NULL, converted_at=NULL
WHERE version='utc-v1' AND source_timezone IN ('UTC','Etc/UTC') AND EXISTS (SELECT 1 FROM users);
ALTER TABLE app_time_model ADD CONSTRAINT app_time_model_ready_provenance
CHECK (version='legacy-v0' OR (source_timezone IS NOT NULL AND converted_at IS NOT NULL));
