ALTER TABLE "users"
  DROP CONSTRAINT "users_phone_check",
  ADD CONSTRAINT "users_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^[+]7[0-9]{10}$');

ALTER TABLE "organizations"
  DROP CONSTRAINT "organizations_phone_check",
  ADD CONSTRAINT "organizations_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^[+]7[0-9]{10}$');
