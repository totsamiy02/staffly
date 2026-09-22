CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "OrganizationInviteType" AS ENUM ('EMAIL', 'CODE');
CREATE TYPE "SensitiveActionType" AS ENUM ('TRANSFER_OWNERSHIP', 'DELETE_ORGANIZATION');

CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "timezone" VARCHAR(64) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizations_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 2 AND 120),
    CONSTRAINT "organizations_description_check" CHECK ("description" IS NULL OR ("description" = btrim("description") AND char_length("description") <= 1000)),
    CONSTRAINT "organizations_timezone_check" CHECK ("timezone" = btrim("timezone") AND char_length("timezone") BETWEEN 1 AND 64)
);

CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_invites" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "type" "OrganizationInviteType" NOT NULL,
    "invited_email" VARCHAR(254),
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_by_user_id" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organization_invites_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_invites_type_email_check" CHECK (("type" = 'EMAIL' AND "invited_email" IS NOT NULL) OR ("type" = 'CODE' AND "invited_email" IS NULL)),
    CONSTRAINT "organization_invites_email_normalized_check" CHECK ("invited_email" IS NULL OR "invited_email" = lower(btrim("invited_email"))),
    CONSTRAINT "organization_invites_acceptor_check" CHECK (("accepted_at" IS NULL AND "accepted_by_user_id" IS NULL) OR ("accepted_at" IS NOT NULL AND "accepted_by_user_id" IS NOT NULL)),
    CONSTRAINT "organization_invites_single_terminal_state_check" CHECK ((CASE WHEN "accepted_at" IS NULL THEN 0 ELSE 1 END) + (CASE WHEN "rejected_at" IS NULL THEN 0 ELSE 1 END) + (CASE WHEN "revoked_at" IS NULL THEN 0 ELSE 1 END) <= 1)
);

CREATE TABLE "sensitive_action_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "action" "SensitiveActionType" NOT NULL,
    "target_user_id" UUID,
    "code_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sensitive_action_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sensitive_action_target_check" CHECK (("action" = 'TRANSFER_OWNERSHIP' AND "target_user_id" IS NOT NULL) OR ("action" = 'DELETE_ORGANIZATION' AND "target_user_id" IS NULL)),
    CONSTRAINT "sensitive_action_attempts_check" CHECK ("attempts" >= 0)
);

CREATE INDEX "organizations_created_by_user_id_idx" ON "organizations"("created_by_user_id");
CREATE INDEX "organizations_deleted_at_idx" ON "organizations"("deleted_at");
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");
CREATE INDEX "organization_members_organization_id_idx" ON "organization_members"("organization_id");
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");
CREATE INDEX "organization_members_organization_id_role_idx" ON "organization_members"("organization_id", "role");
CREATE UNIQUE INDEX "organization_members_one_owner_idx" ON "organization_members"("organization_id") WHERE "role" = 'OWNER';
CREATE UNIQUE INDEX "organization_invites_token_hash_key" ON "organization_invites"("token_hash");
CREATE INDEX "organization_invites_organization_id_created_at_idx" ON "organization_invites"("organization_id", "created_at");
CREATE INDEX "organization_invites_invited_email_type_expires_at_idx" ON "organization_invites"("invited_email", "type", "expires_at");
CREATE INDEX "organization_invites_invited_by_user_id_idx" ON "organization_invites"("invited_by_user_id");
CREATE INDEX "organization_invites_accepted_by_user_id_idx" ON "organization_invites"("accepted_by_user_id");
CREATE UNIQUE INDEX "organization_invites_active_email_key" ON "organization_invites"("organization_id", "invited_email") WHERE "type" = 'EMAIL' AND "accepted_at" IS NULL AND "rejected_at" IS NULL AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX "sensitive_action_tokens_code_hash_key" ON "sensitive_action_tokens"("code_hash");
CREATE INDEX "sensitive_action_tokens_user_id_organization_id_action_used_at_idx" ON "sensitive_action_tokens"("user_id", "organization_id", "action", "used_at");
CREATE INDEX "sensitive_action_tokens_organization_id_idx" ON "sensitive_action_tokens"("organization_id");
CREATE INDEX "sensitive_action_tokens_target_user_id_idx" ON "sensitive_action_tokens"("target_user_id");

ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sensitive_action_tokens" ADD CONSTRAINT "sensitive_action_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sensitive_action_tokens" ADD CONSTRAINT "sensitive_action_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sensitive_action_tokens" ADD CONSTRAINT "sensitive_action_tokens_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
