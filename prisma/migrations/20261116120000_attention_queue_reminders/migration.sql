-- Additive delivery identity: one notice per source revision, phase and recipient.
ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_REMINDER';
ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_TASK_REMINDER';
ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_BLOCKED';
ALTER TYPE "AccountNotificationType" ADD VALUE 'DOCUMENT_REMINDER';
ALTER TABLE account_notifications ADD COLUMN attention_delivery_key VARCHAR(300);
CREATE UNIQUE INDEX account_notifications_attention_delivery_key_key ON account_notifications(attention_delivery_key);
CREATE INDEX requests_attention_tasks_idx ON requests(organization_id,id)
 WHERE status='APPROVED' AND outcome->>'kind'='TASK' AND outcome->>'status'='OPEN';

CREATE OR REPLACE FUNCTION enqueue_notification_email() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_key TEXT;
BEGIN
 category_key := CASE NEW.type::text
  WHEN 'SHIFT_ASSIGNED' THEN 'shiftChanges' WHEN 'SHIFT_CHANGED' THEN 'shiftChanges' WHEN 'SHIFT_CANCELLED' THEN 'shiftChanges'
  WHEN 'REQUEST_APPROVED' THEN 'requestResults' WHEN 'REQUEST_REJECTED' THEN 'requestResults'
  WHEN 'REQUEST_CREATED' THEN 'actionDigest' WHEN 'SHIFT_OFFER_APPROVAL' THEN 'actionDigest'
  WHEN 'DOCUMENT_ASSIGNED' THEN 'documents' WHEN 'DOCUMENT_REMINDER' THEN 'documents'
  WHEN 'REQUEST_REMINDER' THEN 'actionDigest' WHEN 'REQUEST_TASK_REMINDER' THEN 'actionDigest' WHEN 'REQUEST_BLOCKED' THEN 'actionDigest'
  WHEN 'EVENT_PUBLISHED' THEN 'importantEvents' WHEN 'EVENT_CHANGED' THEN 'importantEvents' WHEN 'EVENT_CANCELLED' THEN 'importantEvents'
  WHEN 'SHIFT_OFFER_CREATED' THEN 'shiftOffers' WHEN 'SHIFT_OFFER_RESULT' THEN 'shiftOffers'
  WHEN 'SCHEDULE_DISCUSSION' THEN 'scheduleDiscussion'
  WHEN 'REQUEST_VACATION_COLLECTION' THEN 'vacationCollection'
  WHEN 'ABSENCE_REPORTED' THEN 'urgentAbsences' WHEN 'ABSENCE_CHANGED' THEN 'urgentAbsences'
  ELSE NULL END;
 IF category_key IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NULL AND email_notifications_enabled AND email_notification_categories->category_key='true'::jsonb) THEN
  IF NEW.type::text='DOCUMENT_REMINDER' THEN
   INSERT INTO email_deliveries(user_id,organization_id,source_key,source_kind,source_id,category,payload)
   VALUES(NEW.user_id,NEW.organization_id,'attention-document:'||NEW.attention_delivery_key,'DOCUMENT_REMINDER',
    (NEW.email_context->'attention'->>'sourceId')::uuid,category_key,COALESCE(NEW.email_context,'{}'))
   ON CONFLICT(source_key) DO NOTHING;
  ELSE
   INSERT INTO email_deliveries(user_id,organization_id,source_key,source_kind,source_id,category,payload)
   VALUES(NEW.user_id,NEW.organization_id,'notification:'||NEW.id,'NOTIFICATION',NEW.id,category_key,COALESCE(NEW.email_context,'{}'))
   ON CONFLICT(source_key) DO NOTHING;
  END IF;
 END IF;
 RETURN NEW;
END $$;
