CREATE TABLE staffly_admin.management_state (
 id integer PRIMARY KEY CHECK(id=1), installation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 started_at timestamptz(3) NOT NULL DEFAULT now(), maintenance_heartbeat timestamptz(3), maintenance_stopped_at timestamptz(3),
 alerts_checked_at timestamptz(3), last_api_ok_at timestamptz(3), last_workers_ok_at timestamptz(3)
);
INSERT INTO staffly_admin.management_state(id) VALUES(1);

CREATE TABLE staffly_admin.action_challenges (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES staffly_admin.accounts(user_id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES staffly_admin.sessions(id) ON DELETE CASCADE,
 auth_session_id uuid NOT NULL REFERENCES public.auth_sessions(id) ON DELETE CASCADE,
 grant_version integer NOT NULL, user_version integer NOT NULL,
 action varchar(24) NOT NULL CHECK(action IN ('ACCESS_GRANT','ACCESS_REVOKE','SESSION_REVOKE','BACKUP_CREATE','ALERT_RULE')),
 target_id uuid, payload jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(payload)='object'),
 code_hash varchar(64) NOT NULL, browser_hash varchar(64) NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 created_at timestamptz(3) NOT NULL DEFAULT now(), expires_at timestamptz(3) NOT NULL,
 sent_at timestamptz(3), used_at timestamptz(3),
 CHECK(expires_at<=created_at+interval '5 minutes')
);
CREATE INDEX admin_action_challenges_session_idx ON staffly_admin.action_challenges(session_id,created_at);

CREATE TABLE staffly_admin.backups (
 id uuid PRIMARY KEY, file_key varchar(64) NOT NULL UNIQUE CHECK(file_key ~ '^staffly-[0-9a-f-]{36}\.dump$'),
 size_bytes bigint NOT NULL CHECK(size_bytes>0), sha256 varchar(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT now(), expires_at timestamptz(3) NOT NULL,
 verified_at timestamptz(3), file_state varchar(12) NOT NULL CHECK(file_state IN ('AVAILABLE','MISSING','INVALID')),
 check_code varchar(32), CHECK(expires_at=created_at+interval '30 days')
);
CREATE INDEX admin_backups_created_idx ON staffly_admin.backups(created_at DESC);
CREATE TABLE staffly_admin.backup_jobs (
 id uuid PRIMARY KEY, kind varchar(8) NOT NULL CHECK(kind IN ('CREATE','VERIFY')),
 backup_id uuid REFERENCES staffly_admin.backups(id), requested_by uuid NOT NULL,
 status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 created_at timestamptz(3) NOT NULL DEFAULT now(), started_at timestamptz(3), finished_at timestamptz(3),
 expires_at timestamptz(3) NOT NULL DEFAULT now()+interval '1 hour', lease_until timestamptz(3), lease_token uuid,
 error_code varchar(40), CHECK(kind='CREATE' OR backup_id IS NOT NULL)
);
CREATE INDEX admin_backup_jobs_status_idx ON staffly_admin.backup_jobs(status,created_at);

CREATE TABLE staffly_admin.alert_rules (
 id uuid PRIMARY KEY, key varchar(32) NOT NULL UNIQUE, enabled boolean NOT NULL DEFAULT true,
 severity varchar(12) NOT NULL CHECK(severity IN ('warning','critical')),
 threshold integer NOT NULL, minimum integer NOT NULL, maximum integer NOT NULL,
 required boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz(3) NOT NULL DEFAULT now(), updated_by uuid,
 CHECK(threshold BETWEEN minimum AND maximum), CHECK(NOT required OR enabled)
);
INSERT INTO staffly_admin.alert_rules(id,key,severity,threshold,minimum,maximum,required) VALUES
 ('1a000000-0000-4000-8000-000000000001','API_UNAVAILABLE','critical',90,45,300,true),
 ('1a000000-0000-4000-8000-000000000002','WORKERS_UNAVAILABLE','critical',90,45,300,true),
 ('1a000000-0000-4000-8000-000000000003','API_ERRORS','warning',5,1,1000,false),
 ('1a000000-0000-4000-8000-000000000004','EMAIL_FAILURES','warning',1,1,1000,false),
 ('1a000000-0000-4000-8000-000000000005','REPORT_FAILURES','warning',1,1,1000,false),
 ('1a000000-0000-4000-8000-000000000006','BACKUP_STALE','warning',24,1,168,false),
 ('1a000000-0000-4000-8000-000000000007','ADMIN_DENIALS','critical',10,5,50,true),
 ('1a000000-0000-4000-8000-000000000008','BACKGROUND_FAILURES','warning',3,1,10,true),
 ('1a000000-0000-4000-8000-000000000009','BACKUP_FAILURES','warning',1,1,100,false);
CREATE TABLE staffly_admin.alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_id uuid NOT NULL REFERENCES staffly_admin.alert_rules(id),
 first_seen_at timestamptz(3) NOT NULL DEFAULT now(), last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
 resolved_at timestamptz(3), acknowledged_at timestamptz(3), acknowledged_by uuid,
 measured integer NOT NULL CHECK(measured>=0), threshold integer NOT NULL CHECK(threshold>0)
);
CREATE UNIQUE INDEX admin_alerts_open_rule_idx ON staffly_admin.alerts(rule_id) WHERE resolved_at IS NULL;
CREATE INDEX admin_alerts_first_seen_idx ON staffly_admin.alerts(first_seen_at DESC);

-- Shared locks prevent revocation/password changes during a confirmed write.
-- Only the bounded management function below may call this helper.
CREATE FUNCTION staffly_admin.management_actor(p_user uuid,p_auth uuid,p_session uuid,p_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u public.users; a public.auth_sessions; g staffly_admin.accounts; s staffly_admin.sessions;
BEGIN
 SELECT * INTO u FROM public.users WHERE id=p_user FOR SHARE;
 IF NOT FOUND OR u.deleted_at IS NOT NULL OR u.email_verified_at IS NULL THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO a FROM public.auth_sessions WHERE id=p_auth AND user_id=p_user FOR SHARE;
 IF NOT FOUND OR a.revoked_at IS NOT NULL OR a.idle_expires_at<=now() OR a.absolute_expires_at<=now() THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO g FROM staffly_admin.accounts WHERE user_id=p_user FOR UPDATE;
 IF NOT FOUND OR NOT g.enabled THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO s FROM staffly_admin.sessions WHERE id=p_session AND user_id=p_user AND auth_session_id=p_auth AND token_hash=p_hash FOR UPDATE;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=now() OR s.grant_version<>g.version OR s.user_version<>u.security_version OR s.setup_allowed THEN RETURN 'FORBIDDEN'; END IF;
 IF s.locked_at IS NOT NULL OR s.activity_at<=now()-interval '5 minutes' OR NOT EXISTS(SELECT 1 FROM staffly_admin.credentials WHERE user_id=p_user) THEN RETURN 'LOCKED'; END IF;
 RETURN 'OK';
END;
$$;
REVOKE ALL ON FUNCTION staffly_admin.management_actor(uuid,uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION staffly_admin.execute_management_action(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_challenge uuid,p_browser text,p_proof text)
RETURNS TABLE(result text,resource_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c staffly_admin.action_challenges; target public.users; g staffly_admin.accounts; r staffly_admin.alert_rules;
 valid text; resource uuid; audit_action text; enabled_count integer;
BEGIN
 PERFORM pg_advisory_xact_lock(681947253::bigint);
 valid:=staffly_admin.management_actor(p_user,p_auth,p_session,p_hash);
 IF valid<>'OK' THEN RETURN QUERY SELECT valid,NULL::uuid;RETURN;END IF;
 SELECT * INTO c FROM staffly_admin.action_challenges WHERE id=p_challenge AND user_id=p_user AND session_id=p_session AND auth_session_id=p_auth FOR UPDATE;
 IF NOT FOUND OR c.used_at IS NOT NULL OR c.sent_at IS NULL OR c.expires_at<=now() OR c.attempts>=5 OR c.browser_hash<>p_browser
 OR c.grant_version<>(SELECT version FROM staffly_admin.accounts WHERE user_id=p_user)
 OR c.user_version<>(SELECT security_version FROM public.users WHERE id=p_user) THEN
  RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;
 END IF;
 IF c.code_hash<>p_proof THEN
  UPDATE staffly_admin.action_challenges SET attempts=attempts+1,used_at=CASE WHEN attempts>=4 THEN now() ELSE NULL END WHERE id=c.id;
  INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),p_user,p_session,'MANAGEMENT_CHALLENGE_DENIED','DENIED',c.action,c.target_id);
  RETURN QUERY SELECT 'CODE',NULL::uuid;RETURN;
 END IF;
 UPDATE staffly_admin.action_challenges SET used_at=now() WHERE id=c.id;
 resource:=c.target_id;
 IF c.action IN ('ACCESS_GRANT','ACCESS_REVOKE') THEN
  IF c.target_id=p_user THEN RETURN QUERY SELECT 'SELF',NULL::uuid;RETURN;END IF;
  SELECT * INTO target FROM public.users WHERE id=c.target_id FOR SHARE;
  IF NOT FOUND OR target.security_version<>(c.payload->>'userVersion')::int OR c.action='ACCESS_GRANT' AND (target.deleted_at IS NOT NULL OR target.email_verified_at IS NULL OR target.password_hash IS NULL) THEN
   RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;
  END IF;
  SELECT * INTO g FROM staffly_admin.accounts WHERE user_id=c.target_id FOR UPDATE;
  IF COALESCE(g.version,0)<>(c.payload->>'version')::int THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  IF c.action='ACCESS_GRANT' THEN
   IF g.enabled THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
   INSERT INTO staffly_admin.accounts(user_id) VALUES(c.target_id)
   ON CONFLICT(user_id) DO UPDATE SET enabled=true,version=staffly_admin.accounts.version+1,granted_at=now(),revoked_at=NULL;
   audit_action:='ACCESS_GRANTED';
  ELSE
   IF g.user_id IS NULL OR NOT g.enabled THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
   SELECT count(*) INTO enabled_count FROM staffly_admin.accounts a JOIN public.users u ON u.id=a.user_id WHERE a.enabled AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND u.password_hash IS NOT NULL;
   IF enabled_count<=1 AND target.deleted_at IS NULL AND target.email_verified_at IS NOT NULL AND target.password_hash IS NOT NULL THEN RETURN QUERY SELECT 'LAST_ADMIN',NULL::uuid;RETURN;END IF;
   UPDATE staffly_admin.accounts SET enabled=false,version=version+1,revoked_at=now() WHERE user_id=c.target_id;
   audit_action:='ACCESS_REVOKED';
  END IF;
  UPDATE staffly_admin.sessions SET revoked_at=now() WHERE user_id=c.target_id AND revoked_at IS NULL;
  UPDATE staffly_admin.challenges SET used_at=now() WHERE user_id=c.target_id AND used_at IS NULL;
  UPDATE staffly_admin.action_challenges SET used_at=now() WHERE user_id=c.target_id AND used_at IS NULL;
 ELSIF c.action='SESSION_REVOKE' THEN
  IF c.target_id=p_session THEN RETURN QUERY SELECT 'SELF',NULL::uuid;RETURN;END IF;
  UPDATE staffly_admin.sessions SET revoked_at=now() WHERE id=c.target_id AND revoked_at IS NULL AND expires_at>now() AND grant_version=(c.payload->>'version')::int;
  IF NOT FOUND THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  audit_action:='ADMIN_SESSION_REVOKED';
 ELSIF c.action='BACKUP_CREATE' THEN
  IF EXISTS(SELECT 1 FROM staffly_admin.backup_jobs WHERE status IN ('PENDING','RUNNING') AND expires_at>now()) THEN RETURN QUERY SELECT 'BUSY',NULL::uuid;RETURN;END IF;
  IF EXISTS(SELECT 1 FROM staffly_admin.backup_jobs WHERE kind='CREATE' AND created_at>now()-interval '15 minutes') THEN RETURN QUERY SELECT 'LIMIT',NULL::uuid;RETURN;END IF;
  resource:=gen_random_uuid();
  INSERT INTO staffly_admin.backup_jobs(id,kind,requested_by) VALUES(resource,'CREATE',p_user);
  audit_action:='BACKUP_REQUESTED';
 ELSIF c.action='ALERT_RULE' THEN
  SELECT * INTO r FROM staffly_admin.alert_rules WHERE id=c.target_id FOR UPDATE;
  IF NOT FOUND OR r.version<>(c.payload->>'version')::int OR jsonb_typeof(c.payload->'enabled')<>'boolean' OR jsonb_typeof(c.payload->'threshold')<>'number'
   OR (c.payload->>'threshold')::int NOT BETWEEN r.minimum AND r.maximum OR r.required AND NOT (c.payload->>'enabled')::boolean THEN
   RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;
  END IF;
  UPDATE staffly_admin.alert_rules SET threshold=(c.payload->>'threshold')::int,enabled=(c.payload->>'enabled')::boolean,version=version+1,updated_at=now(),updated_by=p_user WHERE id=r.id;
  audit_action:='ALERT_RULE_CHANGED';
 ELSE RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;
 END IF;
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),p_user,p_session,audit_action,'SUCCEEDED',c.action,resource);
 RETURN QUERY SELECT 'OK',resource;
END;
$$;
REVOKE ALL ON FUNCTION staffly_admin.execute_management_action(uuid,uuid,uuid,text,uuid,text,text) FROM PUBLIC;

-- Runtime can trigger only a fixed collector, never read private data or change
-- settings/grants. One check per 10 seconds across every API/worker replica.
CREATE FUNCTION public.platform_reconcile_admin_alerts() RETURNS void
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
  IF r.enabled THEN
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
  END IF;
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
REVOKE ALL ON FUNCTION public.platform_reconcile_admin_alerts() FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  GRANT EXECUTE ON FUNCTION public.platform_reconcile_admin_alerts() TO staffly_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT SELECT ON staffly_admin.management_state,staffly_admin.backups,staffly_admin.backup_jobs,staffly_admin.alerts,staffly_admin.alert_rules TO staffly_admin_gateway;
  GRANT SELECT,INSERT,UPDATE ON staffly_admin.action_challenges TO staffly_admin_gateway;
  GRANT EXECUTE ON FUNCTION staffly_admin.execute_management_action(uuid,uuid,uuid,text,uuid,text,text) TO staffly_admin_gateway;
 END IF;
END $$;

-- Minimal private read models. No password/PIN/token/IP/user-agent columns.
CREATE VIEW staffly_admin.administrator_directory AS
 SELECT a.user_id,a.enabled,a.version,u.security_version AS user_version,a.granted_at,a.revoked_at,u.deleted_at IS NOT NULL AS deleted,
 u.email_verified_at IS NOT NULL AS email_verified,u.password_hash IS NOT NULL AS password_set,
 CASE WHEN u.deleted_at IS NULL THEN concat_ws(' ',u.last_name,u.first_name) END AS display_name,
 CASE WHEN u.deleted_at IS NULL THEN left(u.email,1)||'***'||substring(u.email FROM position('@' IN u.email)) END AS email,
 EXISTS(SELECT 1 FROM staffly_admin.credentials c WHERE c.user_id=a.user_id) AS pin_set
 FROM staffly_admin.accounts a JOIN public.users u ON u.id=a.user_id;
CREATE VIEW staffly_admin.session_directory AS
 SELECT s.id,s.user_id,s.grant_version,s.created_at,s.expires_at,s.activity_at,s.locked_at,s.revoked_at,s.setup_allowed,
 CASE WHEN u.deleted_at IS NULL THEN concat_ws(' ',u.last_name,u.first_name) END AS display_name,
 (s.revoked_at IS NULL AND s.expires_at>now() AND a.enabled AND a.version=s.grant_version AND u.security_version=s.user_version
  AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND x.revoked_at IS NULL AND x.user_id=s.user_id AND x.idle_expires_at>now() AND x.absolute_expires_at>now()) AS valid
 FROM staffly_admin.sessions s JOIN staffly_admin.accounts a ON a.user_id=s.user_id JOIN public.users u ON u.id=s.user_id JOIN public.auth_sessions x ON x.id=s.auth_session_id;
CREATE VIEW staffly_admin.audit_directory AS
 SELECT e.id,e.user_id,e.session_id,e.action,e.outcome,e.resource,e.resource_id,e.created_at,
 CASE WHEN u.deleted_at IS NULL THEN concat_ws(' ',u.last_name,u.first_name) END AS actor_name,
 CASE WHEN t.deleted_at IS NULL THEN concat_ws(' ',t.last_name,t.first_name) END AS target_name
 FROM staffly_admin.audit_events e LEFT JOIN public.users u ON u.id=e.user_id LEFT JOIN public.users t ON t.id=e.resource_id;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT SELECT ON staffly_admin.administrator_directory,staffly_admin.session_directory,staffly_admin.audit_directory TO staffly_admin_gateway;
 END IF;
END $$;

-- Low-impact actions still require the unlocked, current administrative session.
-- This function cannot appoint admins, copy/export a dump, or change rules.
CREATE FUNCTION staffly_admin.simple_management_action(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_action text,p_target uuid,p_expected text)
RETURNS TABLE(result text,resource_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE valid text; resource uuid:=p_target; audit_action text;
BEGIN
 PERFORM pg_advisory_xact_lock(681947253::bigint);
 valid:=staffly_admin.management_actor(p_user,p_auth,p_session,p_hash);
 IF valid<>'OK' THEN RETURN QUERY SELECT valid,NULL::uuid;RETURN;END IF;
 IF p_action='ALERT_ACK' THEN
  UPDATE staffly_admin.alerts SET acknowledged_at=now(),acknowledged_by=p_user WHERE id=p_target AND resolved_at IS NULL AND acknowledged_at IS NULL;
  IF NOT FOUND THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  audit_action:='ALERT_ACKNOWLEDGED';
 ELSIF p_action='BACKUP_VERIFY' THEN
  IF NOT EXISTS(SELECT 1 FROM staffly_admin.backups WHERE id=p_target AND sha256=p_expected AND expires_at>now()) THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  IF EXISTS(SELECT 1 FROM staffly_admin.backup_jobs WHERE status IN ('PENDING','RUNNING') AND expires_at>now()) THEN RETURN QUERY SELECT 'BUSY',NULL::uuid;RETURN;END IF;
  IF EXISTS(SELECT 1 FROM staffly_admin.backup_jobs WHERE kind='VERIFY' AND backup_id=p_target AND created_at>now()-interval '1 minute') THEN RETURN QUERY SELECT 'LIMIT',NULL::uuid;RETURN;END IF;
  resource:=gen_random_uuid();
  INSERT INTO staffly_admin.backup_jobs(id,kind,backup_id,requested_by) VALUES(resource,'VERIFY',p_target,p_user);
  audit_action:='BACKUP_VERIFY_REQUESTED';
 ELSE RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;
 END IF;
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),p_user,p_session,audit_action,'SUCCEEDED',p_action,resource);
 RETURN QUERY SELECT 'OK',resource;
END;
$$;
REVOKE ALL ON FUNCTION staffly_admin.simple_management_action(uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT EXECUTE ON FUNCTION staffly_admin.simple_management_action(uuid,uuid,uuid,text,text,uuid,text) TO staffly_admin_gateway;
 END IF;
END $$;
