-- Existing membership boundaries do not prove uninterrupted historical employment.
CREATE TABLE public.member_employment_periods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 member_id uuid NOT NULL,
 started_at timestamptz(3),
 ended_at timestamptz(3),
 source varchar(16) NOT NULL CHECK (source IN ('LEGACY','RECORDED')),
 CONSTRAINT member_employment_periods_member_fk FOREIGN KEY (organization_id,member_id)
 REFERENCES public.organization_members(organization_id,id) ON DELETE CASCADE,
 CONSTRAINT member_employment_periods_dates CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at>=started_at),
 CONSTRAINT member_employment_periods_recorded_start CHECK (source<>'RECORDED' OR started_at IS NOT NULL)
);
CREATE UNIQUE INDEX member_employment_periods_open_idx ON public.member_employment_periods(member_id) WHERE ended_at IS NULL;
CREATE INDEX member_employment_periods_member_idx ON public.member_employment_periods(organization_id,member_id,started_at);
CREATE INDEX member_employment_periods_ended_idx ON public.member_employment_periods(organization_id,ended_at);
INSERT INTO public.member_employment_periods(organization_id,member_id,started_at,ended_at,source)
 SELECT organization_id,id,NULL,left_at,'LEGACY' FROM public.organization_members;
CREATE FUNCTION public.staffly_record_member_employment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO public.member_employment_periods(organization_id,member_id,started_at,ended_at,source)
   VALUES(NEW.organization_id,NEW.id,NEW.joined_at,NEW.left_at,'RECORDED');
 ELSIF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
  UPDATE public.member_employment_periods SET ended_at=NEW.left_at WHERE member_id=NEW.id AND ended_at IS NULL;
 ELSIF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL THEN
  INSERT INTO public.member_employment_periods(organization_id,member_id,started_at,source)
   VALUES(NEW.organization_id,NEW.id,date_trunc('milliseconds',clock_timestamp()),'RECORDED');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.staffly_record_member_employment() FROM PUBLIC;
CREATE TRIGGER organization_members_employment AFTER INSERT OR UPDATE OF left_at ON public.organization_members
 FOR EACH ROW EXECUTE FUNCTION public.staffly_record_member_employment();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  GRANT SELECT ON public.member_employment_periods TO staffly_app;
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.member_employment_periods FROM staffly_app;
 END IF;
END $$;
