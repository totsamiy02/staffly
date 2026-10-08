-- CreateEnum
CREATE TYPE "ShiftOfferMode" AS ENUM ('DISABLED', 'AUTO', 'APPROVAL');

-- CreateEnum
CREATE TYPE "ShiftOfferKind" AS ENUM ('TRANSFER', 'SWAP');

-- CreateEnum
CREATE TYPE "ShiftOfferStatus" AS ENUM ('PENDING', 'AWAITING_APPROVAL', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'INVALID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccountNotificationType" ADD VALUE 'SHIFT_OFFER_CREATED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'SHIFT_OFFER_APPROVAL';
ALTER TYPE "AccountNotificationType" ADD VALUE 'SHIFT_OFFER_RESULT';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "shift_swap_mode" "ShiftOfferMode" NOT NULL DEFAULT 'DISABLED',
ADD COLUMN     "shift_transfer_mode" "ShiftOfferMode" NOT NULL DEFAULT 'DISABLED';

-- AlterTable
ALTER TABLE "account_notifications" ADD COLUMN     "shift_offer_delivery_key" VARCHAR(200),
ADD COLUMN     "shift_offer_id" UUID;

-- AlterTable
ALTER TABLE "work_shift_adjustments" ADD COLUMN     "assignment_change" JSONB,
ADD COLUMN     "kind" VARCHAR(20) NOT NULL DEFAULT 'ACTUAL';

-- CreateTable
CREATE TABLE "shift_offer_reservations" (
    "shift_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,

    CONSTRAINT "shift_offer_reservations_pkey" PRIMARY KEY ("shift_id")
);

-- CreateTable
CREATE TABLE "shift_offers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "initiator_member_id" UUID NOT NULL,
    "recipient_member_id" UUID,
    "source_shift_id" UUID NOT NULL,
    "target_shift_id" UUID,
    "kind" "ShiftOfferKind" NOT NULL,
    "mode" "ShiftOfferMode" NOT NULL,
    "status" "ShiftOfferStatus" NOT NULL DEFAULT 'PENDING',
    "source_snapshot" JSONB NOT NULL,
    "target_snapshot" JSONB,
    "comment" VARCHAR(500),
    "resolution_reason" VARCHAR(500),
    "accepted_by_member_id" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "reviewed_by_member_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "shift_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shift_offer_reservations_offer_id_idx" ON "shift_offer_reservations"("offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "shift_offer_reservations_organization_id_shift_id_key" ON "shift_offer_reservations"("organization_id", "shift_id");

-- CreateIndex
CREATE INDEX "shift_offers_organization_id_location_id_status_created_at_idx" ON "shift_offers"("organization_id", "location_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "shift_offers_initiator_member_id_created_at_idx" ON "shift_offers"("initiator_member_id", "created_at");

-- CreateIndex
CREATE INDEX "shift_offers_recipient_member_id_status_idx" ON "shift_offers"("recipient_member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shift_offers_organization_id_id_key" ON "shift_offers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_notifications_shift_offer_delivery_key_key" ON "account_notifications"("shift_offer_delivery_key");

-- CreateIndex
CREATE UNIQUE INDEX "work_shifts_organization_id_id_key" ON "work_shifts"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_organization_id_shift_offer_id_fkey" FOREIGN KEY ("organization_id", "shift_offer_id") REFERENCES "shift_offers"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offer_reservations" ADD CONSTRAINT "shift_offer_reservations_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "work_shifts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offer_reservations" ADD CONSTRAINT "shift_offer_reservations_organization_id_offer_id_fkey" FOREIGN KEY ("organization_id", "offer_id") REFERENCES "shift_offers"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "organization_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_organization_id_initiator_member_id_fkey" FOREIGN KEY ("organization_id", "initiator_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_organization_id_recipient_member_id_fkey" FOREIGN KEY ("organization_id", "recipient_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_organization_id_accepted_by_member_id_fkey" FOREIGN KEY ("organization_id", "accepted_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_organization_id_reviewed_by_member_id_fkey" FOREIGN KEY ("organization_id", "reviewed_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_organization_id_source_shift_id_fkey" FOREIGN KEY ("organization_id", "source_shift_id") REFERENCES "work_shifts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_organization_id_target_shift_id_fkey" FOREIGN KEY ("organization_id", "target_shift_id") REFERENCES "work_shifts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the existing overlap protection, but permit atomic exchanges of
-- overlapping shifts. All other transactions continue to check immediately.
ALTER TABLE work_shifts DROP CONSTRAINT work_shifts_no_overlap;
ALTER TABLE work_shifts ADD CONSTRAINT work_shifts_no_overlap EXCLUDE USING gist (
  member_id WITH =, tstzrange(scheduled_start_at, scheduled_end_at, '[)') WITH &&
) WHERE (status = 'SCHEDULED') DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE shift_offers ADD CONSTRAINT shift_offers_shape CHECK (
  (kind = 'TRANSFER' AND target_shift_id IS NULL) OR
  (kind = 'SWAP' AND target_shift_id IS NOT NULL AND recipient_member_id IS NOT NULL AND target_shift_id <> source_shift_id)
);

-- Every writer (schedule, absence requests, member removal) invalidates pending
-- offers in the SAME transaction. Reading an assignment notice is not a change
-- of shift terms. The completion service closes its own offer before updates.
CREATE FUNCTION invalidate_changed_shift_offers() RETURNS trigger AS $$
DECLARE offer_record RECORD;
BEGIN
  IF ROW(OLD.member_id, OLD.location_id, OLD.scheduled_start_at, OLD.scheduled_end_at,
         OLD.position_id, OLD.position_name_snapshot, OLD.break_minutes, OLD.description,
         OLD.status, OLD.cancelled_at, OLD.actual_start_at, OLD.actual_end_at, OLD.actual_break_minutes)
     IS NOT DISTINCT FROM
     ROW(NEW.member_id, NEW.location_id, NEW.scheduled_start_at, NEW.scheduled_end_at,
         NEW.position_id, NEW.position_name_snapshot, NEW.break_minutes, NEW.description,
         NEW.status, NEW.cancelled_at, NEW.actual_start_at, NEW.actual_end_at, NEW.actual_break_minutes)
  THEN RETURN NEW; END IF;
  FOR offer_record IN
    UPDATE shift_offers SET status = 'INVALID', resolution_reason = 'Условия или сотрудник смены изменились. Предложение больше неактуально.', closed_at = NOW(), updated_at = NOW()
    WHERE status IN ('PENDING', 'AWAITING_APPROVAL') AND (source_shift_id = NEW.id OR target_shift_id = NEW.id)
    RETURNING *
  LOOP
    DELETE FROM shift_offer_reservations WHERE offer_id = offer_record.id;
    UPDATE account_notifications SET read_at = NOW() WHERE shift_offer_id = offer_record.id AND read_at IS NULL;
    INSERT INTO account_notifications (id, user_id, organization_id, shift_offer_id, shift_offer_delivery_key, type, title, message, created_at)
    SELECT gen_random_uuid(), m.user_id, offer_record.organization_id, offer_record.id,
      offer_record.id::text || ':SHIFT_OFFER_RESULT:' || m.id::text,
      'SHIFT_OFFER_RESULT', 'Предложение смены закрыто', offer_record.resolution_reason, NOW()
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.id IN (offer_record.initiator_member_id, offer_record.recipient_member_id, offer_record.accepted_by_member_id)
      AND m.left_at IS NULL AND u.deleted_at IS NULL
    ON CONFLICT (shift_offer_delivery_key) DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER work_shifts_invalidate_offers AFTER UPDATE ON work_shifts
FOR EACH ROW EXECUTE FUNCTION invalidate_changed_shift_offers();
