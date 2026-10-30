BEGIN;
ALTER TABLE stored_files ADD COLUMN purged_at TIMESTAMPTZ(3);
ALTER TABLE stored_files ADD CONSTRAINT stored_files_purge_completed CHECK (purged_at IS NULL OR pending_deletion_at IS NULL);

-- Retained document metadata keeps its original size/checksum for history.
-- Only successfully removed object bytes stop consuming tenant capacity.
CREATE OR REPLACE FUNCTION staffly_storage_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_bytes BIGINT := 0; new_bytes BIGINT := 0; delta BIGINT;
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') AND OLD.purged_at IS NULL THEN old_bytes := OLD.size; END IF;
 IF TG_OP IN ('INSERT','UPDATE') AND NEW.purged_at IS NULL THEN new_bytes := NEW.size; END IF;
 IF TG_OP='UPDATE' AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
   delta := new_bytes-old_bytes;
   IF delta=0 OR NEW.organization_id IS NULL THEN RETURN NEW; END IF;
   UPDATE organization_resource_budgets SET storage_bytes=storage_bytes+delta
     WHERE organization_id=NEW.organization_id AND (delta<=0 OR storage_bytes+delta<=storage_limit_bytes);
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ORGANIZATION_STORAGE_QUOTA_EXCEEDED'; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP IN ('DELETE','UPDATE') AND OLD.organization_id IS NOT NULL THEN
   UPDATE organization_resource_budgets SET storage_bytes=storage_bytes-old_bytes WHERE organization_id=OLD.organization_id;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') AND NEW.organization_id IS NOT NULL THEN
   UPDATE organization_resource_budgets SET storage_bytes=storage_bytes+new_bytes
    WHERE organization_id=NEW.organization_id AND storage_bytes+new_bytes<=storage_limit_bytes;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ORGANIZATION_STORAGE_QUOTA_EXCEEDED'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
COMMIT;
