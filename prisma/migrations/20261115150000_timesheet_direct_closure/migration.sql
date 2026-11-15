-- Replace pending assignments with direct reconciliation. Preserve the old
-- reviewer assignment in history before removing the unused column.
BEGIN;
LOCK TABLE public.timesheet_periods IN ACCESS EXCLUSIVE MODE;
INSERT INTO public.timesheet_events(period_id, actor_name, kind, reason, changes)
SELECT id, 'Система', 'REVIEW_REMOVED',
 'Период открыт для сверки без отдельного согласования',
 jsonb_build_object('before', jsonb_build_object('status', status, 'reviewer_member_id', reviewer_member_id),
                    'after', jsonb_build_object('status', 'OPEN'))
FROM public.timesheet_periods WHERE status = 'REVIEW';

-- The schema owner converts pending periods even for suspended organizations.
-- The table lock prevents runtime writes while this one trigger is disabled.
ALTER TABLE public.timesheet_periods DISABLE TRIGGER service_write_guard;
UPDATE public.timesheet_periods SET status = 'OPEN', revision = revision + 1,
 updated_at = clock_timestamp() WHERE status = 'REVIEW';
ALTER TABLE public.timesheet_periods ENABLE TRIGGER service_write_guard;
ALTER TABLE public.timesheet_periods DROP COLUMN reviewer_member_id;
ALTER TABLE public.timesheet_periods DROP CONSTRAINT timesheet_periods_status_check;
ALTER TABLE public.timesheet_periods ADD CONSTRAINT timesheet_periods_status_check
 CHECK (status IN ('OPEN', 'CLOSED'));

CREATE OR REPLACE FUNCTION public.staffly_guard_timesheet_change() RETURNS trigger
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
       ELSE 'Изменение отсутствия после фиксации табеля' END);
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
COMMIT;
