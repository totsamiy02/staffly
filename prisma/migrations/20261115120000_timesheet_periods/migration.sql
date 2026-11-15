CREATE TABLE public.timesheet_periods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 location_id uuid NOT NULL,
 month varchar(7) NOT NULL CHECK(month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 timezone varchar(80) NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','REVIEW','CLOSED')),
 reviewer_member_id uuid,
 revision integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 0,
 updated_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,location_id) REFERENCES public.organization_locations(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,reviewer_member_id) REFERENCES public.organization_members(organization_id,id) ON DELETE RESTRICT,
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,location_id,month)
);
CREATE TABLE public.timesheet_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 period_id uuid NOT NULL REFERENCES public.timesheet_periods(id) ON DELETE CASCADE,
 version integer NOT NULL,
 snapshot jsonb NOT NULL,
 closed_by_member_id uuid NOT NULL REFERENCES public.organization_members(id) ON DELETE RESTRICT,
 closed_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(period_id,version)
);
CREATE TABLE public.timesheet_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 period_id uuid NOT NULL REFERENCES public.timesheet_periods(id) ON DELETE CASCADE,
 actor_member_id uuid REFERENCES public.organization_members(id) ON DELETE RESTRICT,
 actor_name varchar(400) NOT NULL,
 kind varchar(32) NOT NULL,
 reason varchar(1000) NOT NULL,
 changes jsonb,
 created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX timesheet_events_period_id_created_at_idx ON public.timesheet_events(period_id,created_at);
-- A write epoch prevents a transaction with an older SERIALIZABLE snapshot from
-- missing a period that another transaction has just created or closed.
CREATE TABLE public.timesheet_write_locks (
 organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 0
);
CREATE FUNCTION public.staffly_lock_timesheets(org uuid) RETURNS void
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 INSERT INTO public.timesheet_write_locks(organization_id) VALUES(org)
 ON CONFLICT(organization_id) DO UPDATE SET revision=timesheet_write_locks.revision+1;
$$;

CREATE FUNCTION public.staffly_guard_timesheet_change() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 before_row jsonb; after_row jsonb; org uuid; p record; affected boolean;
 actor uuid; actor_name text; correction_reason text;
BEGIN
 IF TG_OP<>'INSERT' THEN before_row=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN after_row=to_jsonb(NEW); END IF;
 -- Read acknowledgements are unrelated to accounting and remain available.
 IF TG_TABLE_NAME='work_shifts' AND TG_OP='UPDATE'
    AND (before_row - ARRAY['assignment_read_at','updated_at'])=(after_row - ARRAY['assignment_read_at','updated_at']) THEN RETURN NEW; END IF;
 org=COALESCE((after_row->>'organization_id')::uuid,(before_row->>'organization_id')::uuid);
 -- Organization cascades are a separate lifecycle operation.
 IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=org) THEN RETURN COALESCE(NEW,OLD); END IF;
 PERFORM public.staffly_lock_timesheets(org);
 SELECT id, COALESCE(NULLIF(concat_ws(' ',personnel_last_name,personnel_first_name,personnel_middle_name),''), 'Сотрудник')
 INTO actor,actor_name FROM public.organization_members
 WHERE organization_id=org AND user_id=NULLIF(current_setting('staffly.actor_user_id',true),'')::uuid;
 correction_reason=NULLIF(btrim(current_setting('staffly.correction_reason',true)),'');
 FOR p IN SELECT * FROM public.timesheet_periods WHERE organization_id=org
  AND (TG_TABLE_NAME='work_shifts' AND EXISTS(SELECT 1 FROM (VALUES(before_row),(after_row)) v(j)
    WHERE (j->>'location_id')::uuid=location_id
    AND to_char((j->>'scheduled_start_at')::timestamptz AT TIME ZONE timezone,'YYYY-MM')=month)
   OR TG_TABLE_NAME='employee_absences' AND EXISTS(SELECT 1 FROM (VALUES(before_row),(after_row)) v(j)
    WHERE (j->>'start_date')::date < (month||'-01')::date+interval '1 month'
    AND (j->>'end_date')::date >= (month||'-01')::date))
  FOR UPDATE LOOP
  IF TG_TABLE_NAME='work_shifts' THEN
   affected=EXISTS(SELECT 1 FROM (VALUES(before_row),(after_row)) v(j)
    WHERE (j->>'location_id')::uuid=p.location_id
    AND to_char((j->>'scheduled_start_at')::timestamptz AT TIME ZONE p.timezone,'YYYY-MM')=p.month);
  ELSE
   -- Absences span the organization. Check historical assignments, transfers,
   -- and shifts, rather than only today's point of employment.
   affected=EXISTS(SELECT 1 FROM (VALUES(before_row),(after_row)) v(j)
    WHERE (j->>'start_date')::date < (p.month||'-01')::date+interval '1 month'
    AND (j->>'end_date')::date >= (p.month||'-01')::date
    AND (EXISTS(SELECT 1 FROM public.location_members m WHERE m.member_id=(j->>'member_id')::uuid AND m.location_id=p.location_id
       AND m.joined_at < ((p.month||'-01')::date+interval '1 month') AT TIME ZONE p.timezone
       AND (m.left_at IS NULL OR m.left_at >= (p.month||'-01')::date AT TIME ZONE p.timezone))
     OR EXISTS(SELECT 1 FROM public.work_shifts s WHERE s.member_id=(j->>'member_id')::uuid AND s.location_id=p.location_id
       AND to_char(s.scheduled_start_at AT TIME ZONE p.timezone,'YYYY-MM')=p.month)
     OR EXISTS(SELECT 1 FROM public.location_transfers t WHERE t.member_id=(j->>'member_id')::uuid AND t.to_location_id=p.location_id
       AND t.start_at < ((p.month||'-01')::date+interval '1 month') AT TIME ZONE p.timezone
       AND (t.end_at IS NULL OR t.end_at >= (p.month||'-01')::date AT TIME ZONE p.timezone)
       AND (t.revoked_at IS NULL OR t.revoked_at>t.start_at))));
  END IF;
  IF NOT affected THEN CONTINUE; END IF;
  IF TG_TABLE_NAME='work_shifts' AND p.status<>'OPEN' THEN
   RAISE EXCEPTION USING ERRCODE='P2601', MESSAGE='TIMESHEET_LOCKED';
  END IF;
  IF TG_TABLE_NAME='work_shifts' AND p.version>0 AND (actor IS NULL OR length(COALESCE(correction_reason,''))<3) THEN
   RAISE EXCEPTION USING ERRCODE='P2602', MESSAGE='TIMESHEET_REASON_REQUIRED';
  END IF;
  IF TG_TABLE_NAME='employee_absences' AND p.status='REVIEW' THEN
   -- New medical/absence information must not be lost. The reviewer must return
   -- the period and check it again before closing.
   UPDATE public.timesheet_periods SET status='OPEN',revision=revision+1,updated_at=clock_timestamp() WHERE id=p.id;
  END IF;
  IF p.version>0 OR p.status<>'OPEN' THEN
   IF actor IS NULL THEN
    -- Direct service callers may supply the absence's explicit author.
    actor=COALESCE((after_row->>'updated_by_member_id')::uuid,(after_row->>'cancelled_by_member_id')::uuid);
    IF actor IS NULL AND TG_TABLE_NAME='employee_absences' THEN
     SELECT created_by_member_id INTO actor FROM public.requests WHERE id=(after_row->>'source_request_id')::uuid;
    END IF;
   END IF;
   IF TG_TABLE_NAME='employee_absences' THEN
    correction_reason=COALESCE(correction_reason,NULLIF(after_row->>'cancellation_reason',''));
    IF p.version>0 AND TG_OP<>'INSERT' AND (actor IS NULL OR length(COALESCE(correction_reason,''))<3) THEN
     RAISE EXCEPTION USING ERRCODE='P2602', MESSAGE='TIMESHEET_REASON_REQUIRED';
    END IF;
    correction_reason=COALESCE(correction_reason,NULLIF(after_row->>'comment',''),
      CASE WHEN TG_OP='INSERT' THEN 'Регистрация позднего отсутствия: '||COALESCE(after_row->>'reason',after_row->>'type','отсутствие')
       ELSE 'Изменение отсутствия во время проверки табеля' END);
   END IF;
   IF actor IS NOT NULL THEN
    SELECT COALESCE(NULLIF(concat_ws(' ',m.personnel_last_name,m.personnel_first_name,m.personnel_middle_name),''),
      NULLIF(concat_ws(' ',u.last_name,u.first_name,u.middle_name),''),'Сотрудник') INTO actor_name
      FROM public.organization_members m JOIN public.users u ON u.id=m.user_id WHERE m.id=actor AND m.organization_id=org;
   END IF;
   INSERT INTO public.timesheet_events(period_id,actor_member_id,actor_name,kind,reason,changes)
    VALUES(p.id,actor,COALESCE(actor_name,'Система'),CASE WHEN TG_TABLE_NAME='employee_absences' THEN 'LATE_ABSENCE' ELSE 'CORRECTION' END,
     correction_reason,jsonb_build_object('table',TG_TABLE_NAME,'before',before_row,'after',after_row));
  END IF;
 END LOOP;
 RETURN COALESCE(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION public.staffly_guard_timesheet_change() FROM PUBLIC;
CREATE TRIGGER work_shifts_timesheet_guard BEFORE INSERT OR UPDATE OR DELETE ON public.work_shifts
 FOR EACH ROW EXECUTE FUNCTION public.staffly_guard_timesheet_change();
CREATE TRIGGER employee_absences_timesheet_guard BEFORE INSERT OR UPDATE OR DELETE ON public.employee_absences
 FOR EACH ROW EXECUTE FUNCTION public.staffly_guard_timesheet_change();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  GRANT SELECT,INSERT,UPDATE ON public.timesheet_periods TO staffly_app;
  GRANT SELECT,INSERT ON public.timesheet_versions,public.timesheet_events TO staffly_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.timesheet_versions,public.timesheet_events FROM staffly_app;
  REVOKE ALL ON public.timesheet_write_locks FROM staffly_app;
 END IF;
END $$;

ALTER TYPE "AccountNotificationType" ADD VALUE 'TIMESHEET_REVIEW';
ALTER TABLE public.account_notifications ADD COLUMN timesheet_period_id uuid,
 ADD CONSTRAINT account_notifications_timesheet_period_fk FOREIGN KEY(organization_id,timesheet_period_id) REFERENCES public.timesheet_periods(organization_id,id) ON DELETE CASCADE;
CREATE INDEX account_notifications_timesheet_period_idx ON public.account_notifications(timesheet_period_id);

CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON public.timesheet_periods
 FOR EACH ROW EXECUTE FUNCTION public.staffly_live_hint('schedule');
CREATE TRIGGER service_write_guard BEFORE INSERT OR UPDATE ON public.timesheet_periods
 FOR EACH ROW EXECUTE FUNCTION public.staffly_service_write_guard();
-- Retention may remove accounting history only as part of an already due,
-- explicitly requested organization deletion. Normal runtime writes cannot.
CREATE FUNCTION public.staffly_purge_deleted_timesheets(org uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=org AND deleted_at IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM public.data_deletions WHERE kind='ORGANIZATION' AND subject_id=org
   AND completed_at IS NULL AND NOT hold AND due_at<=clock_timestamp()) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='TIMESHEET_RETENTION_NOT_DUE';
 END IF;
 DELETE FROM public.timesheet_periods WHERE organization_id=org;
END $$;
REVOKE ALL ON FUNCTION public.staffly_purge_deleted_timesheets(uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  GRANT EXECUTE ON FUNCTION public.staffly_purge_deleted_timesheets(uuid) TO staffly_app;
 END IF;
END $$;
