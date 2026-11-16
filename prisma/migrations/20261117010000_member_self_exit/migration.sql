ALTER TYPE public."WorkShiftStatus" ADD VALUE 'UNASSIGNED';
ALTER TYPE public."AccountNotificationType" ADD VALUE 'ORGANIZATION_MEMBER_LEFT';

CREATE TABLE public.member_self_exits (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL,
  employment_period_id uuid NOT NULL UNIQUE,
  member_name varchar(300) NOT NULL,
  location_ids uuid[] NOT NULL,
  request_ids uuid[] NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, member_id, id),
  UNIQUE (organization_id, member_id, employment_period_id),
  FOREIGN KEY (organization_id, member_id) REFERENCES public.organization_members(organization_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (organization_id, member_id, employment_period_id) REFERENCES public.member_employment_periods(organization_id,member_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX member_self_exits_organization_id_created_at_id_idx ON public.member_self_exits(organization_id,created_at,id);
ALTER TABLE public.work_shifts ADD COLUMN self_exit_id uuid;
ALTER TABLE public.work_shifts ADD CONSTRAINT work_shifts_self_exit_fk FOREIGN KEY (organization_id,member_id,self_exit_id)
  REFERENCES public.member_self_exits(organization_id,member_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.work_shifts ADD CONSTRAINT work_shifts_unassigned_exit CHECK (
  status::text <> 'UNASSIGNED' OR (self_exit_id IS NOT NULL AND actual_start_at IS NULL AND actual_end_at IS NULL AND actual_break_minutes IS NULL AND attendance::text='UNCONFIRMED' AND cancelled_at IS NULL)
);
ALTER TABLE public.work_shifts DROP CONSTRAINT work_shifts_cancellation_check;
ALTER TABLE public.work_shifts ADD CONSTRAINT work_shifts_cancellation_check CHECK (
  (status::text IN ('SCHEDULED','UNASSIGNED') AND cancelled_at IS NULL AND cancelled_by_member_id IS NULL AND cancellation_reason IS NULL)
  OR (status::text='CANCELLED' AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL)
);
CREATE INDEX work_shifts_self_exit_id_status_idx ON public.work_shifts(self_exit_id,status);
ALTER TABLE public.requests ADD COLUMN self_exit_id uuid;
ALTER TABLE public.requests ADD CONSTRAINT requests_self_exit_fk FOREIGN KEY (organization_id,self_exit_id)
  REFERENCES public.member_self_exits(organization_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX requests_self_exit_id_idx ON public.requests(self_exit_id);

CREATE OR REPLACE FUNCTION public.staffly_service_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE org uuid; state text; until_at timestamptz; deleted timestamptz; x record; before_row jsonb; after_row jsonb; allowed boolean := false;
BEGIN
 org:=(to_jsonb(NEW)->>'organization_id')::uuid;
 IF org IS NULL THEN RETURN NEW;END IF;
 -- Shared through commit; a suspension waits for in-flight tenant writes.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(org::text,681947262));
 SELECT service_state,service_until,deleted_at INTO state,until_at,deleted FROM public.organizations WHERE id=org;
 IF deleted IS NULL AND state='SUSPENDED' AND (until_at IS NULL OR until_at>clock_timestamp()) THEN
  -- Purging an archived file may only refresh the document's live hint.
  IF TG_TABLE_NAME='documents' AND TG_OP='UPDATE' AND (to_jsonb(NEW)-'updated_at')=(to_jsonb(OLD)-'updated_at') THEN RETURN NEW;END IF;
  -- An exit may only remove the caller's own participation and stranded assignments.
  -- The organization remains suspended for every other mutation.
  IF TG_OP='UPDATE' THEN
   SELECT e.* INTO x FROM public.member_self_exits e
    JOIN public.organization_members m ON m.id=e.member_id AND m.organization_id=e.organization_id
    WHERE e.id=NULLIF(current_setting('staffly.self_exit_id',true),'')::uuid AND e.organization_id=org
     AND m.user_id=NULLIF(current_setting('staffly.actor_user_id',true),'')::uuid AND m.role<>'OWNER';
   IF FOUND THEN
    before_row=to_jsonb(OLD); after_row=to_jsonb(NEW);
    IF TG_TABLE_NAME='organization_members' THEN
     allowed=OLD.id=x.member_id AND NEW.access_role_id IS NULL AND NEW.access_configured
      AND (NEW.left_at IS NULL OR NEW.left_at=x.created_at)
      AND (before_row-ARRAY['left_at','access_role_id','access_configured','updated_at'])=(after_row-ARRAY['left_at','access_role_id','access_configured','updated_at']);
    ELSIF TG_TABLE_NAME='location_members' THEN
     allowed=OLD.member_id=x.member_id AND NEW.left_at=x.created_at
      AND (before_row-'left_at')=(after_row-'left_at');
    ELSIF TG_TABLE_NAME='location_transfers' THEN
     allowed=OLD.member_id=x.member_id AND NEW.revoked_at=x.created_at
      AND (before_row-'revoked_at')=(after_row-'revoked_at');
    ELSIF TG_TABLE_NAME='document_acknowledgements' THEN
     allowed=OLD.member_id=x.member_id AND NEW.cancelled_at=x.created_at
      AND (before_row-'cancelled_at')=(after_row-'cancelled_at');
    ELSIF TG_TABLE_NAME='work_shifts' THEN
     allowed=OLD.member_id=x.member_id AND OLD.status::text='SCHEDULED' AND NEW.status::text='UNASSIGNED'
      AND NEW.self_exit_id=x.id AND OLD.scheduled_start_at>x.created_at
      AND (before_row-ARRAY['status','self_exit_id','updated_at'])=(after_row-ARRAY['status','self_exit_id','updated_at']);
    ELSIF TG_TABLE_NAME='requests' THEN
     IF NEW.self_exit_id=x.id AND OLD.id=ANY(x.request_ids) THEN
      allowed=OLD.status::text='PENDING' AND NEW.status::text='PENDING'
       AND (before_row-ARRAY['self_exit_id','updated_at'])=(after_row-ARRAY['self_exit_id','updated_at']);
      IF OLD.status::text='APPROVED' AND NEW.status::text='APPROVED' AND OLD.outcome->>'kind'='TASK' AND OLD.outcome->>'status'='OPEN' THEN
       allowed=(before_row-ARRAY['self_exit_id','outcome','updated_at'])=(after_row-ARRAY['self_exit_id','outcome','updated_at'])
        AND (OLD.outcome-'assignees')=(NEW.outcome-'assignees')
        AND NEW.outcome->'assignees'=COALESCE((SELECT jsonb_agg(v) FROM jsonb_array_elements(OLD.outcome->'assignees') v WHERE v<>to_jsonb(x.member_id::text)),'[]'::jsonb);
      END IF;
     ELSE
      allowed=OLD.status::text='PENDING' AND NEW.status::text='INVALID'
       AND EXISTS(SELECT 1 FROM public.work_shifts s WHERE s.id=OLD.related_shift_id AND s.self_exit_id=x.id)
       AND (before_row-ARRAY['status','resolution_comment','cancelled_at','updated_at'])=(after_row-ARRAY['status','resolution_comment','cancelled_at','updated_at']);
     END IF;
    ELSIF TG_TABLE_NAME='shift_offers' THEN
     allowed=OLD.status::text IN ('PENDING','AWAITING_APPROVAL') AND NEW.status::text='CANCELLED'
      AND x.member_id IN (OLD.initiator_member_id,OLD.recipient_member_id,OLD.accepted_by_member_id)
      AND (before_row-ARRAY['status','resolution_reason','closed_at','updated_at'])=(after_row-ARRAY['status','resolution_reason','closed_at','updated_at']);
    END IF;
    IF allowed THEN RETURN NEW; END IF;
   END IF;
  END IF;
  RAISE EXCEPTION 'ORGANIZATION_SUSPENDED' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  GRANT SELECT,INSERT ON public.member_self_exits TO staffly_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.member_self_exits FROM staffly_app;
 END IF;
END $$;
