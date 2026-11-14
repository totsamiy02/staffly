ALTER TABLE work_shifts
 ADD COLUMN replacement_of_id uuid,
 ADD COLUMN replacement_cutoff_at timestamptz(3),
 ADD COLUMN replacement_floor_at timestamptz(3),
 ADD CONSTRAINT work_shifts_replacement_source_fk FOREIGN KEY (organization_id,replacement_of_id) REFERENCES work_shifts(organization_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT work_shifts_replacement_cutoff CHECK (replacement_cutoff_at IS NULL OR
   (scheduled_end_at<=replacement_cutoff_at AND (actual_end_at IS NULL OR actual_end_at<=replacement_cutoff_at) AND status<>'CANCELLED')),
 ADD CONSTRAINT work_shifts_replacement_floor CHECK (replacement_floor_at IS NULL OR
   (scheduled_start_at>=replacement_floor_at AND (actual_start_at IS NULL OR actual_start_at>=replacement_floor_at)));
CREATE INDEX work_shifts_replacement_source_idx ON work_shifts(replacement_of_id);
ALTER TABLE shift_offers ADD COLUMN partial jsonb, ADD COLUMN creation_key uuid;
CREATE UNIQUE INDEX shift_offers_creation_key_key ON shift_offers(creation_key);

CREATE FUNCTION public.guard_partial_shift_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.replacement_cutoff_at IS NOT NULL AND
    (NEW.member_id<>OLD.member_id OR NEW.attendance='NO_SHOW' OR NEW.replacement_cutoff_at IS DISTINCT FROM OLD.replacement_cutoff_at) THEN
   RAISE EXCEPTION 'Recorded replacement boundary and worker cannot be erased' USING ERRCODE='23514';
 END IF;
 IF OLD.replacement_of_id IS NOT NULL AND OLD.scheduled_start_at<=clock_timestamp() AND NEW.status='CANCELLED' AND OLD.status<>'CANCELLED' THEN
   RAISE EXCEPTION 'Finish worked replacement before assigning its remainder' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_shifts_partial_history BEFORE UPDATE ON work_shifts
 FOR EACH ROW EXECUTE FUNCTION public.guard_partial_shift_history();
