-- New accounts start with the main employee categories. Existing choices stay unchanged.
ALTER TABLE users ALTER COLUMN email_notifications_enabled SET DEFAULT true;
ALTER TABLE users ALTER COLUMN email_notification_categories SET DEFAULT
 '{"shiftChanges":true,"publishedSchedule":true,"shiftOffers":true,"scheduleDiscussion":true,"requestResults":true,"documents":true,"importantEvents":true}'::jsonb;

-- Each business event is eligible immediately, without per-minute/hour/day quotas.
CREATE OR REPLACE FUNCTION enqueue_notification_email() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_key TEXT;
BEGIN
 category_key := CASE NEW.type::text
  WHEN 'SHIFT_ASSIGNED' THEN 'shiftChanges' WHEN 'SHIFT_CHANGED' THEN 'shiftChanges' WHEN 'SHIFT_CANCELLED' THEN 'shiftChanges'
  WHEN 'REQUEST_APPROVED' THEN 'requestResults' WHEN 'REQUEST_REJECTED' THEN 'requestResults'
  WHEN 'REQUEST_CREATED' THEN 'actionDigest' WHEN 'SHIFT_OFFER_APPROVAL' THEN 'actionDigest'
  WHEN 'DOCUMENT_ASSIGNED' THEN 'documents'
  WHEN 'EVENT_PUBLISHED' THEN 'importantEvents' WHEN 'EVENT_CHANGED' THEN 'importantEvents' WHEN 'EVENT_CANCELLED' THEN 'importantEvents'
  WHEN 'SHIFT_OFFER_CREATED' THEN 'shiftOffers' WHEN 'SHIFT_OFFER_RESULT' THEN 'shiftOffers'
  WHEN 'SCHEDULE_DISCUSSION' THEN 'scheduleDiscussion'
  WHEN 'REQUEST_VACATION_COLLECTION' THEN 'vacationCollection'
  WHEN 'ABSENCE_REPORTED' THEN 'urgentAbsences' WHEN 'ABSENCE_CHANGED' THEN 'urgentAbsences'
  ELSE NULL END;
 IF category_key IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NULL AND email_notifications_enabled AND email_notification_categories->category_key='true'::jsonb) THEN
  INSERT INTO email_deliveries(user_id,organization_id,source_key,source_kind,source_id,category,payload)
  VALUES(NEW.user_id,NEW.organization_id,'notification:'||NEW.id,'NOTIFICATION',NEW.id,category_key,COALESCE(NEW.email_context,'{}'))
  ON CONFLICT(source_key) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;

-- Every closure, including deadline expiry, is an independent review event.
-- The sender rechecks current point permissions before revealing any draft details.
CREATE FUNCTION enqueue_draft_review_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO email_deliveries(user_id,organization_id,source_key,source_kind,source_id,category,payload)
 SELECT m.user_id,NEW.organization_id,'draft-review:'||NEW.id||':'||NEW.revision||':'||m.user_id,
  'DRAFT_REVIEW',NEW.id,'actionDigest',jsonb_build_object('revision',NEW.revision)
 FROM organization_members m JOIN users u ON u.id=m.user_id
 WHERE m.organization_id=NEW.organization_id AND m.left_at IS NULL AND u.deleted_at IS NULL
  AND u.email_notifications_enabled AND u.email_notification_categories->'actionDigest'='true'::jsonb
 ON CONFLICT(source_key) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER draft_review_email AFTER UPDATE OF status ON schedule_drafts
 FOR EACH ROW WHEN (NEW.status::text='CLOSED' AND OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION enqueue_draft_review_email();

-- Retire pending daily summaries. Previously queued event/retry records retain their identity.
UPDATE email_deliveries SET status='SKIPPED',locked_until=NULL WHERE source_kind='DIGEST' AND status='PENDING';
UPDATE email_deliveries SET available_at=CURRENT_TIMESTAMP WHERE category='shiftChanges'
 AND status='PENDING' AND attempts=0 AND available_at>CURRENT_TIMESTAMP;
