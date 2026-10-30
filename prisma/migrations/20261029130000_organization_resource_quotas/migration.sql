BEGIN;
-- Keep the initial counters and trigger installation consistent with live writes.
LOCK TABLE organizations, stored_files, email_deliveries IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE organization_resource_budgets (
 organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
 storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
 storage_limit_bytes BIGINT NOT NULL DEFAULT 5368709120 CHECK (storage_limit_bytes >= 0),
 export_queue_limit INTEGER NOT NULL DEFAULT 5 CHECK (export_queue_limit BETWEEN 1 AND 200),
 export_hour_limit INTEGER NOT NULL DEFAULT 20 CHECK (export_hour_limit BETWEEN 1 AND 10000),
 export_window_start TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 export_window_count INTEGER NOT NULL DEFAULT 0 CHECK (export_window_count >= 0),
 last_export_at TIMESTAMPTZ(3),
 pending_emails INTEGER NOT NULL DEFAULT 0 CHECK (pending_emails >= 0),
 email_queue_limit INTEGER NOT NULL DEFAULT 2000 CHECK (email_queue_limit BETWEEN 1 AND 100000),
 email_minute_limit INTEGER NOT NULL DEFAULT 60 CHECK (email_minute_limit BETWEEN 1 AND 10000),
 email_window_start TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 email_window_count INTEGER NOT NULL DEFAULT 0 CHECK (email_window_count >= 0),
 last_email_at TIMESTAMPTZ(3),
 offer_check_cursor UUID,
 request_check_cursor UUID
);
-- Existing files (including staged uploads / pending deletion) already consume space.
INSERT INTO organization_resource_budgets(organization_id,storage_bytes,pending_emails)
 SELECT o.id, COALESCE((SELECT sum(size) FROM stored_files f WHERE f.organization_id=o.id),0),
 (SELECT count(*) FROM email_deliveries e WHERE e.organization_id=o.id AND e.category IS NOT NULL AND e.status='PENDING')
 FROM organizations o;
CREATE FUNCTION staffly_init_resource_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN INSERT INTO organization_resource_budgets(organization_id) VALUES(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER resource_budget AFTER INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION staffly_init_resource_budget();

-- Reserve bytes atomically, before storage I/O, independent of API process count.
-- Release only when the file record is removed after successful object deletion.
CREATE FUNCTION staffly_storage_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE delta BIGINT;
BEGIN
 IF TG_OP='UPDATE' AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
   IF OLD.size=NEW.size OR NEW.organization_id IS NULL THEN RETURN NEW; END IF;
   delta := NEW.size-OLD.size;
   UPDATE organization_resource_budgets SET storage_bytes=storage_bytes+delta
     WHERE organization_id=NEW.organization_id AND (delta<=0 OR storage_bytes+delta<=storage_limit_bytes);
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ORGANIZATION_STORAGE_QUOTA_EXCEEDED'; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP IN ('DELETE','UPDATE') AND OLD.organization_id IS NOT NULL THEN
   UPDATE organization_resource_budgets SET storage_bytes=storage_bytes-OLD.size WHERE organization_id=OLD.organization_id;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') AND NEW.organization_id IS NOT NULL THEN
   delta := NEW.size;
   UPDATE organization_resource_budgets SET storage_bytes=storage_bytes+delta
    WHERE organization_id=NEW.organization_id AND storage_bytes+delta<=storage_limit_bytes;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ORGANIZATION_STORAGE_QUOTA_EXCEEDED'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER resource_storage AFTER INSERT OR UPDATE OR DELETE ON stored_files FOR EACH ROW EXECUTE FUNCTION staffly_storage_budget();

ALTER TABLE email_deliveries ADD COLUMN skip_reason VARCHAR(40);
CREATE INDEX report_exports_org_active_idx ON report_exports(organization_id,status,lease_until);
CREATE INDEX email_deliveries_org_active_idx ON email_deliveries(organization_id,status,locked_until);
-- Optional mail overflow must not roll back the business event or in-app notice.
-- AFTER INSERT avoids reserving slots for ON CONFLICT DO NOTHING duplicates.
CREATE FUNCTION staffly_email_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pending INTEGER; ceiling INTEGER;
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') AND OLD.organization_id IS NOT NULL AND OLD.category IS NOT NULL AND OLD.status='PENDING' THEN
   UPDATE organization_resource_budgets SET pending_emails=pending_emails-1 WHERE organization_id=OLD.organization_id;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') AND NEW.organization_id IS NOT NULL AND NEW.category IS NOT NULL AND NEW.status='PENDING' THEN
   UPDATE organization_resource_budgets SET pending_emails=pending_emails+1 WHERE organization_id=NEW.organization_id RETURNING pending_emails,email_queue_limit INTO pending,ceiling;
   IF NOT FOUND OR pending>ceiling THEN
     UPDATE email_deliveries SET status='SKIPPED',skip_reason='ORGANIZATION_QUEUE_QUOTA',locked_until=NULL WHERE id=NEW.id;
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER resource_email AFTER INSERT OR UPDATE OF status,organization_id,category OR DELETE ON email_deliveries FOR EACH ROW EXECUTE FUNCTION staffly_email_budget();
COMMIT;
