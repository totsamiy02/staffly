ALTER TABLE "users"
  ADD COLUMN "first_name" VARCHAR(80),
  ADD COLUMN "last_name" VARCHAR(80),
  ADD COLUMN "middle_name" VARCHAR(80),
  ADD COLUMN "phone" VARCHAR(12),
  ADD COLUMN "bio" VARCHAR(500),
  ADD COLUMN "last_seen_at" TIMESTAMPTZ(3);

ALTER TABLE "organizations"
  ADD COLUMN "contact_email" VARCHAR(254),
  ADD COLUMN "phone" VARCHAR(12),
  ADD COLUMN "website" VARCHAR(2048),
  ADD COLUMN "address" VARCHAR(300);

ALTER TABLE "users"
  ADD CONSTRAINT "users_first_name_check" CHECK ("first_name" IS NULL OR ("first_name" = btrim("first_name") AND char_length("first_name") BETWEEN 1 AND 80)),
  ADD CONSTRAINT "users_last_name_check" CHECK ("last_name" IS NULL OR ("last_name" = btrim("last_name") AND char_length("last_name") BETWEEN 1 AND 80)),
  ADD CONSTRAINT "users_middle_name_check" CHECK ("middle_name" IS NULL OR ("middle_name" = btrim("middle_name") AND char_length("middle_name") BETWEEN 1 AND 80)),
  ADD CONSTRAINT "users_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^\\+7[0-9]{10}$'),
  ADD CONSTRAINT "users_bio_check" CHECK ("bio" IS NULL OR ("bio" = btrim("bio") AND char_length("bio") <= 500));

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_contact_email_check" CHECK ("contact_email" IS NULL OR "contact_email" = lower(btrim("contact_email"))),
  ADD CONSTRAINT "organizations_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^\\+7[0-9]{10}$'),
  ADD CONSTRAINT "organizations_website_check" CHECK ("website" IS NULL OR "website" ~ '^https?://'),
  ADD CONSTRAINT "organizations_address_check" CHECK ("address" IS NULL OR ("address" = btrim("address") AND char_length("address") <= 300));

CREATE INDEX "users_last_seen_at_idx" ON "users"("last_seen_at");
