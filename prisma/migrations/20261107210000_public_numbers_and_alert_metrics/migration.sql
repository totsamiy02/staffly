-- Visible account numbers are independent of UUID foreign keys. Backfill follows
-- registration order; deleted numbers are never reassigned.
CREATE SEQUENCE public.users_public_id_seq AS integer;
ALTER TABLE public.users ADD COLUMN public_id integer;
WITH numbered AS (SELECT id,row_number() OVER(ORDER BY created_at,id)::integer AS n FROM public.users)
UPDATE public.users u SET public_id=n.n FROM numbered n WHERE n.id=u.id;
SELECT setval('public.users_public_id_seq',COALESCE(max(public_id),1),max(public_id) IS NOT NULL) FROM public.users;
ALTER SEQUENCE public.users_public_id_seq OWNED BY public.users.public_id;
ALTER TABLE public.users ALTER COLUMN public_id SET DEFAULT nextval('public.users_public_id_seq'),ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX users_public_id_key ON public.users(public_id);

CREATE SEQUENCE public.organizations_public_id_seq AS integer;
ALTER TABLE public.organizations ADD COLUMN public_id integer;
WITH numbered AS (SELECT id,row_number() OVER(ORDER BY created_at,id)::integer AS n FROM public.organizations)
UPDATE public.organizations o SET public_id=n.n FROM numbered n WHERE n.id=o.id;
SELECT setval('public.organizations_public_id_seq',COALESCE(max(public_id),1),max(public_id) IS NOT NULL) FROM public.organizations;
ALTER SEQUENCE public.organizations_public_id_seq OWNED BY public.organizations.public_id;
ALTER TABLE public.organizations ALTER COLUMN public_id SET DEFAULT nextval('public.organizations_public_id_seq'),ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX organizations_public_id_key ON public.organizations(public_id);

CREATE FUNCTION public.keep_public_number() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN RAISE EXCEPTION 'Public number is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER users_keep_public_number BEFORE UPDATE OF public_id ON public.users FOR EACH ROW EXECUTE FUNCTION public.keep_public_number();
CREATE TRIGGER organizations_keep_public_number BEFORE UPDATE OF public_id ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.keep_public_number();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
 GRANT USAGE,SELECT ON SEQUENCE public.users_public_id_seq,public.organizations_public_id_seq TO staffly_app;
END IF;END $$;

ALTER TABLE staffly_admin.alert_rules ADD COLUMN measured integer,ADD COLUMN checked_at timestamptz(3);

CREATE OR REPLACE FUNCTION public.platform_reconcile_admin_alerts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
<<alert_cycle>>
DECLARE st staffly_admin.management_state; r staffly_admin.alert_rules; measured integer; healthy boolean; changed uuid;
BEGIN
 IF NOT pg_try_advisory_xact_lock(681947254::bigint) THEN RETURN;END IF;
 SELECT * INTO st FROM staffly_admin.management_state WHERE id=1 FOR UPDATE;
 IF st.alerts_checked_at>now()-interval '10 seconds' THEN RETURN;END IF;
 UPDATE staffly_admin.management_state SET alerts_checked_at=now(),
  last_api_ok_at=CASE WHEN EXISTS(SELECT 1 FROM public.platform_runtime_nodes WHERE role='api' AND ready AND stopped_at IS NULL AND heartbeat_at>now()-interval '45 seconds') THEN now() ELSE last_api_ok_at END,
  last_workers_ok_at=CASE WHEN EXISTS(SELECT 1 FROM public.platform_runtime_nodes WHERE (role='worker' OR role='api' AND snapshot->'config'->>'backgroundWorkers'='true') AND ready AND stopped_at IS NULL AND heartbeat_at>now()-interval '45 seconds') THEN now() ELSE last_workers_ok_at END
 WHERE id=1 RETURNING * INTO st;
 FOR r IN SELECT * FROM staffly_admin.alert_rules ORDER BY id FOR UPDATE LOOP
  measured:=0;
  CASE r.key
    WHEN 'API_UNAVAILABLE' THEN measured:=floor(LEAST(2147483647,GREATEST(0,extract(epoch FROM now()-COALESCE(st.last_api_ok_at,st.started_at)))))::int;
    WHEN 'WORKERS_UNAVAILABLE' THEN measured:=floor(LEAST(2147483647,GREATEST(0,extract(epoch FROM now()-COALESCE(st.last_workers_ok_at,st.started_at)))))::int;
    WHEN 'API_ERRORS' THEN SELECT count(*)::int INTO measured FROM public.platform_request_errors WHERE source='request' AND status>=500 AND created_at>now()-interval '5 minutes';
    WHEN 'EMAIL_FAILURES' THEN SELECT count(*)::int INTO measured FROM public.email_deliveries WHERE status='FAILED' AND created_at>now()-interval '24 hours';
    WHEN 'REPORT_FAILURES' THEN SELECT count(*)::int INTO measured FROM public.report_exports WHERE status='FAILED' AND expires_at>now();
    WHEN 'BACKUP_STALE' THEN SELECT floor(LEAST(2147483647,GREATEST(0,extract(epoch FROM now()-COALESCE(max(created_at),st.started_at))/3600)))::int INTO measured FROM staffly_admin.backups WHERE file_state='AVAILABLE' AND verified_at IS NOT NULL;
    WHEN 'ADMIN_DENIALS' THEN SELECT count(*)::int INTO measured FROM staffly_admin.audit_events WHERE outcome='DENIED' AND action IN ('CHALLENGE_DENIED','PIN_DENIED','ACCESS_DENIED','MANAGEMENT_CHALLENGE_DENIED') AND created_at>now()-interval '15 minutes';
    WHEN 'BACKGROUND_FAILURES' THEN SELECT COALESCE(max(CASE WHEN t->>'failures' ~ '^[0-9]{1,8}$' THEN (t->>'failures')::int ELSE 0 END),0) INTO measured FROM public.platform_runtime_nodes n CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.snapshot->'tasks')='array' THEN n.snapshot->'tasks' ELSE '[]'::jsonb END) t WHERE n.stopped_at IS NULL AND n.heartbeat_at>now()-interval '45 seconds';
    WHEN 'BACKUP_FAILURES' THEN SELECT count(*)::int INTO measured FROM staffly_admin.backup_jobs WHERE status='FAILED' AND finished_at>now()-interval '24 hours';
    ELSE measured:=0;
  END CASE;
  UPDATE staffly_admin.alert_rules SET measured=alert_cycle.measured,checked_at=now() WHERE id=r.id;
  healthy:=NOT r.enabled OR measured<r.threshold;
  IF NOT healthy THEN
   INSERT INTO staffly_admin.alerts(rule_id,measured,threshold) VALUES(r.id,measured,r.threshold)
   ON CONFLICT(rule_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id INTO changed;
   IF changed IS NOT NULL THEN
    INSERT INTO staffly_admin.audit_events(id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),'ALERT_OPENED','SUCCEEDED','ALERT',changed);
   END IF;
   UPDATE staffly_admin.alerts SET measured=alert_cycle.measured,threshold=r.threshold,last_seen_at=now() WHERE rule_id=r.id AND resolved_at IS NULL;
  ELSE
   UPDATE staffly_admin.alerts SET resolved_at=now(),last_seen_at=now() WHERE rule_id=r.id AND resolved_at IS NULL RETURNING id INTO changed;
   IF changed IS NOT NULL THEN
    INSERT INTO staffly_admin.audit_events(id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),'ALERT_RESOLVED','SUCCEEDED','ALERT',changed);
   END IF;
  END IF;
 END LOOP;
 WITH expired AS (UPDATE staffly_admin.backup_jobs SET status='FAILED',finished_at=now(),error_code='BACKUP_REQUEST_EXPIRED',lease_token=NULL,lease_until=NULL WHERE status IN ('PENDING','RUNNING') AND expires_at<now() RETURNING id,requested_by),
 logged AS (INSERT INTO staffly_admin.audit_events(id,user_id,action,outcome,resource,resource_id) SELECT gen_random_uuid(),requested_by,'BACKUP_FAILED','FAILED','BACKUP_JOB',id FROM expired)
 INSERT INTO public.platform_request_errors(id,node_id,method,route,status,name,event_code,source,job_id,user_id,task_name)
 SELECT gen_random_uuid(),'00000000-0000-0000-0000-000000000000','OTHER','/workers/backups',0,'Error','BACKUP_REQUEST_EXPIRED','worker',id,requested_by,'Backup maintenance' FROM expired;
 DELETE FROM staffly_admin.action_challenges WHERE id IN (SELECT id FROM staffly_admin.action_challenges WHERE expires_at<now()-interval '1 day' LIMIT 1000);
 DELETE FROM staffly_admin.backup_jobs WHERE id IN (SELECT id FROM staffly_admin.backup_jobs WHERE created_at<now()-interval '30 days' AND status IN ('SUCCEEDED','FAILED') LIMIT 1000);
 DELETE FROM staffly_admin.alerts WHERE id IN (SELECT id FROM staffly_admin.alerts WHERE resolved_at<now()-interval '180 days' LIMIT 1000);
 PERFORM staffly_admin.cleanup_expired();
END;
$$;

CREATE OR REPLACE VIEW staffly_admin.administrator_directory AS
 SELECT a.user_id,a.enabled,a.version,u.security_version AS user_version,a.granted_at,a.revoked_at,u.deleted_at IS NOT NULL AS deleted,
 u.email_verified_at IS NOT NULL AS email_verified,u.password_hash IS NOT NULL AS password_set,
 CASE WHEN u.deleted_at IS NULL THEN concat_ws(' ',u.last_name,u.first_name) END AS display_name,
 CASE WHEN u.deleted_at IS NULL THEN left(u.email,1)||'***'||substring(u.email FROM position('@' IN u.email)) END AS email,
 EXISTS(SELECT 1 FROM staffly_admin.credentials c WHERE c.user_id=a.user_id) AS pin_set,u.public_id
 FROM staffly_admin.accounts a JOIN public.users u ON u.id=a.user_id;
CREATE OR REPLACE VIEW staffly_admin.session_directory AS
 SELECT s.id,s.user_id,s.grant_version,s.created_at,s.expires_at,s.activity_at,s.locked_at,s.revoked_at,s.setup_allowed,
 CASE WHEN u.deleted_at IS NULL THEN concat_ws(' ',u.last_name,u.first_name) END AS display_name,
 (s.revoked_at IS NULL AND s.expires_at>now() AND a.enabled AND a.version=s.grant_version AND u.security_version=s.user_version
  AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND x.revoked_at IS NULL AND x.user_id=s.user_id AND x.idle_expires_at>now() AND x.absolute_expires_at>now()) AS valid,u.public_id
 FROM staffly_admin.sessions s JOIN staffly_admin.accounts a ON a.user_id=s.user_id JOIN public.users u ON u.id=s.user_id JOIN public.auth_sessions x ON x.id=s.auth_session_id;
CREATE OR REPLACE VIEW staffly_admin.audit_directory AS
 SELECT e.id,e.user_id,e.session_id,e.action,e.outcome,e.resource,e.resource_id,e.created_at,
 CASE WHEN u.deleted_at IS NULL THEN concat_ws(' ',u.last_name,u.first_name) END AS actor_name,
 CASE WHEN t.deleted_at IS NULL THEN concat_ws(' ',t.last_name,t.first_name) END AS target_name,u.public_id AS actor_public_id,t.public_id AS target_public_id
 FROM staffly_admin.audit_events e LEFT JOIN public.users u ON u.id=e.user_id LEFT JOIN public.users t ON t.id=e.resource_id;
