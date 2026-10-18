-- Preserve original temporary assignment dates while revoking future access.
ALTER TABLE "location_transfers" ADD COLUMN "revoked_at" TIMESTAMPTZ(3);
