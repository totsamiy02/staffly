ALTER TABLE public.member_employment_periods ADD CONSTRAINT member_employment_periods_organization_member_id_key UNIQUE (organization_id, member_id, id);
ALTER TABLE public.employee_absences ADD COLUMN vacation_service varchar(16) NOT NULL DEFAULT 'INCLUDED'
  CHECK (vacation_service IN ('INCLUDED', 'UNPAID', 'EXCLUDED'));

CREATE TABLE public.vacation_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  member_id uuid NOT NULL,
  employment_period_id uuid NOT NULL UNIQUE,
  employment_start_date date NOT NULL,
  annual_days integer NOT NULL CHECK (annual_days BETWEEN 28 AND 366),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, member_id) REFERENCES public.organization_members(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, employment_period_id) REFERENCES public.member_employment_periods(organization_id, member_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX vacation_accounts_organization_id_member_id_idx ON public.vacation_accounts(organization_id, member_id);
CREATE TABLE public.vacation_balance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL,
  actor_member_id uuid NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('START', 'OPENING', 'ADJUSTMENT', 'POLICY', 'EMPLOYMENT')),
  effective_date date NOT NULL,
  amount_hundredths integer,
  annual_days integer CHECK (annual_days BETWEEN 28 AND 366),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) >= 3),
  submission_key uuid NOT NULL,
  input_hash varchar(64) NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, submission_key),
  FOREIGN KEY (organization_id, account_id) REFERENCES public.vacation_accounts(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, actor_member_id) REFERENCES public.organization_members(organization_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK ((kind IN ('OPENING', 'ADJUSTMENT') AND amount_hundredths IS NOT NULL AND annual_days IS NULL)
    OR (kind IN ('START', 'POLICY') AND annual_days IS NOT NULL AND amount_hundredths IS NULL)
    OR (kind = 'EMPLOYMENT' AND annual_days IS NULL AND amount_hundredths IS NULL))
);
CREATE INDEX vacation_balance_events_account_id_created_at_id_idx ON public.vacation_balance_events(account_id, created_at, id);

-- Existing explicitly configured roles retain their chosen permissions.
UPDATE public.access_roles SET permissions = array_append(array_append(permissions, 'vacations.balances.view'), 'vacations.balances.manage')
WHERE system_code = 'ADMIN' AND NOT ('vacations.balances.view' = ANY(permissions));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staffly_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.vacation_accounts TO staffly_app;
    REVOKE DELETE, TRUNCATE ON public.vacation_accounts FROM staffly_app;
    GRANT SELECT, INSERT ON public.vacation_balance_events TO staffly_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON public.vacation_balance_events FROM staffly_app;
  END IF;
END $$;

CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON public.vacation_accounts
  FOR EACH ROW EXECUTE FUNCTION public.staffly_live_hint('requests');
CREATE TRIGGER staffly_live AFTER INSERT ON public.vacation_balance_events
  FOR EACH ROW EXECUTE FUNCTION public.staffly_live_hint('requests');
