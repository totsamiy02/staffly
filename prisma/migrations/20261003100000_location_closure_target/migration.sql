ALTER TABLE "sensitive_action_tokens" DROP CONSTRAINT "sensitive_action_target_check";
ALTER TABLE "sensitive_action_tokens" ADD CONSTRAINT "sensitive_action_target_check" CHECK (
  ("action" = 'TRANSFER_OWNERSHIP' AND "target_user_id" IS NOT NULL AND "target_location_id" IS NULL)
  OR ("action" = 'DELETE_ORGANIZATION' AND "target_user_id" IS NULL AND "target_location_id" IS NULL)
  OR ("action" = 'ARCHIVE_LOCATION' AND "target_user_id" IS NULL AND "target_location_id" IS NOT NULL)
);
