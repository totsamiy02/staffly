ALTER TABLE users ADD COLUMN email_notifications_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN email_notification_categories JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN email_preferences_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_notifications ADD COLUMN email_context JSONB;
ALTER TABLE organization_events ADD COLUMN important BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE email_deliveries (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 organization_id UUID,
 source_key VARCHAR(240) NOT NULL UNIQUE,
 source_kind VARCHAR(32) NOT NULL,
 source_id UUID,
 category VARCHAR(40),
 payload JSONB NOT NULL DEFAULT '{}',
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
 attempts INTEGER NOT NULL DEFAULT 0,
 available_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 locked_until TIMESTAMPTZ(3),
 delivered_at TIMESTAMPTZ(3),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX email_deliveries_status_available_at_idx ON email_deliveries(status, available_at);
CREATE INDEX email_deliveries_user_id_category_idx ON email_deliveries(user_id, category);

-- Enqueue in the same transaction as every existing notification writer, including bulk inserts.
-- Opt-in is checked at creation AND again at delivery. No historical backfill.
CREATE FUNCTION enqueue_notification_email() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_key TEXT;
BEGIN
 category_key := CASE NEW.type::text
  WHEN 'SHIFT_ASSIGNED' THEN 'shiftChanges' WHEN 'SHIFT_CHANGED' THEN 'shiftChanges' WHEN 'SHIFT_CANCELLED' THEN 'shiftChanges'
  WHEN 'REQUEST_APPROVED' THEN 'requestResults' WHEN 'REQUEST_REJECTED' THEN 'requestResults'
  WHEN 'DOCUMENT_ASSIGNED' THEN 'documents'
  WHEN 'EVENT_PUBLISHED' THEN 'importantEvents' WHEN 'EVENT_CHANGED' THEN 'importantEvents' WHEN 'EVENT_CANCELLED' THEN 'importantEvents'
  WHEN 'SHIFT_OFFER_CREATED' THEN 'shiftOffers' WHEN 'SHIFT_OFFER_RESULT' THEN 'shiftOffers'
  WHEN 'SCHEDULE_DISCUSSION' THEN 'scheduleDiscussion'
  WHEN 'REQUEST_VACATION_COLLECTION' THEN 'vacationCollection'
  WHEN 'ABSENCE_REPORTED' THEN 'urgentAbsences' WHEN 'ABSENCE_CHANGED' THEN 'urgentAbsences'
  ELSE NULL END;
 IF category_key IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NULL AND email_notifications_enabled AND email_notification_categories->category_key='true'::jsonb) THEN
  INSERT INTO email_deliveries(user_id,organization_id,source_key,source_kind,source_id,category,payload,available_at)
  VALUES(NEW.user_id,NEW.organization_id,'notification:'||NEW.id,'NOTIFICATION',NEW.id,category_key,COALESCE(NEW.email_context,'{}'),CURRENT_TIMESTAMP + CASE WHEN category_key='shiftChanges' THEN interval '60 seconds' ELSE interval '0 seconds' END)
  ON CONFLICT(source_key) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_notification_email AFTER INSERT ON account_notifications FOR EACH ROW EXECUTE FUNCTION enqueue_notification_email();
