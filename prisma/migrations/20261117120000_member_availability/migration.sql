BEGIN;

ALTER TYPE public."AccountNotificationType" ADD VALUE 'SHIFT_AVAILABILITY_CHANGED';
ALTER TABLE public.work_shifts ADD COLUMN availability_override jsonb;

CREATE TABLE public.member_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL,
  employment_period_id uuid NOT NULL UNIQUE,
  timezone varchar(64) NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, member_id, employment_period_id),
  FOREIGN KEY (organization_id, member_id) REFERENCES public.organization_members(organization_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (organization_id, member_id, employment_period_id)
    REFERENCES public.member_employment_periods(organization_id, member_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX member_availability_organization_id_member_id_idx ON public.member_availability(organization_id, member_id);

CREATE TABLE public.member_availability_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  actor_member_id uuid NOT NULL,
  actor_name varchar(300) NOT NULL,
  operation_id uuid NOT NULL,
  input_hash varchar(64) NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  before jsonb,
  after jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, actor_member_id, operation_id),
  UNIQUE (account_id, revision),
  FOREIGN KEY (organization_id, account_id) REFERENCES public.member_availability(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, actor_member_id) REFERENCES public.organization_members(organization_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX member_availability_events_account_id_created_at_idx ON public.member_availability_events(account_id, created_at);

-- Only built-in roles gain the new defaults; custom roles keep their choices.
-- DDL holds an exclusive table lock until commit. Updating built-in defaults
-- must also work for suspended tenants; runtime suspension protection is restored
-- before this migration transaction commits.
ALTER TABLE public.access_roles DISABLE TRIGGER service_write_guard;
UPDATE public.access_roles SET permissions = ARRAY(
  SELECT DISTINCT unnest(permissions || ARRAY['availability.own'])
) WHERE system_code = 'MEMBER' AND 'schedule.own' = ANY(permissions);
UPDATE public.access_roles SET permissions = ARRAY(
  SELECT DISTINCT unnest(permissions || ARRAY['availability.own', 'availability.view', 'availability.manage', 'availability.override'])
) WHERE system_code = 'ADMIN' AND permissions @> ARRAY['members.view', 'schedule.view'];
ALTER TABLE public.access_roles ENABLE TRIGGER service_write_guard;

CREATE FUNCTION public.staffly_availability_period_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.member_employment_periods p
      JOIN public.organization_members m ON m.organization_id=p.organization_id AND m.id=p.member_id
    WHERE p.id=NEW.employment_period_id AND p.organization_id=NEW.organization_id
      AND p.member_id=NEW.member_id AND p.ended_at IS NULL AND m.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'AVAILABILITY_EMPLOYMENT_ENDED' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER availability_period_guard BEFORE INSERT OR UPDATE ON public.member_availability
  FOR EACH ROW EXECUTE FUNCTION public.staffly_availability_period_guard();

CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON public.member_availability
  FOR EACH ROW EXECUTE FUNCTION public.staffly_live_hint('schedule');
CREATE TRIGGER staffly_service_guard BEFORE INSERT OR UPDATE ON public.member_availability
  FOR EACH ROW EXECUTE FUNCTION public.staffly_service_write_guard();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staffly_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.member_availability TO staffly_app;
    REVOKE DELETE, TRUNCATE ON public.member_availability FROM staffly_app;
    GRANT SELECT, INSERT ON public.member_availability_events TO staffly_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON public.member_availability_events FROM staffly_app;
  END IF;
END $$;

COMMIT;
