-- Service lifecycle operations use the existing password + one-time-code proof.
-- The gateway receives metadata views, never credentials, file contents or DDL.
ALTER TABLE public.organizations
 ADD COLUMN service_state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK(service_state IN ('ACTIVE','SUSPENDED')),
 ADD COLUMN service_reason varchar(1000), ADD COLUMN service_until timestamptz(3),
 ADD COLUMN service_revision integer NOT NULL DEFAULT 1 CHECK(service_revision>0);
ALTER TABLE public.organization_subscriptions
 ADD COLUMN support_plan varchar(16) CHECK(support_plan IN ('FREE','TEAM','BUSINESS')),
 ADD COLUMN support_starts_at timestamptz(3), ADD COLUMN support_ends_at timestamptz(3),
 ADD CHECK((support_plan IS NULL AND support_starts_at IS NULL AND support_ends_at IS NULL)
  OR (support_plan IS NOT NULL AND support_starts_at IS NOT NULL AND support_ends_at>support_starts_at));
CREATE FUNCTION public.platform_organization_available(org uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT deleted_at IS NULL AND (service_state='ACTIVE' OR service_until<=now()) FROM public.organizations WHERE id=org),false)
$$;
CREATE OR REPLACE FUNCTION public.staffly_subscription_storage_limit(org uuid) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN support_plan IS NOT NULL AND support_starts_at<=now() AND support_ends_at>now()
  THEN CASE support_plan WHEN 'FREE' THEN 262144000 WHEN 'TEAM' THEN 2147483648 ELSE 10737418240 END
  ELSE CASE WHEN p.plan='FREE' OR p.ends_at IS NULL OR p.ends_at+interval '7 days'<=now() THEN 262144000 WHEN p.plan='TEAM' THEN 2147483648 ELSE 10737418240 END END
 FROM public.organization_subscriptions s CROSS JOIN LATERAL
 (SELECT CASE WHEN next_starts_at<=now() THEN next_plan ELSE plan END AS plan,CASE WHEN next_starts_at<=now() THEN next_ends_at ELSE period_end END AS ends_at) p
 WHERE organization_id=org
$$;
CREATE TABLE staffly_admin.service_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_kind varchar(24) NOT NULL, subject_id uuid,
 action varchar(32) NOT NULL, reason varchar(1000) NOT NULL, actor_id uuid NOT NULL,
 before_value jsonb NOT NULL DEFAULT '{}', after_value jsonb NOT NULL DEFAULT '{}', created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX service_history_subject ON staffly_admin.service_history(subject_kind,subject_id,created_at DESC,id);
CREATE TABLE staffly_admin.service_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind varchar(24) NOT NULL CHECK(kind IN ('USER_RECOVERY','RESTORE_CHECK','DELIVERY_TEST','FILES_BACKUP','LEDGER_BACKUP','BACKUP_CLEANUP')),
 target_id uuid, requested_by uuid NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
 status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3), created_at timestamptz(3) NOT NULL DEFAULT now(),
 started_at timestamptz(3), finished_at timestamptz(3), lease_until timestamptz(3), lease_token uuid,
 expires_at timestamptz(3) NOT NULL DEFAULT now()+interval '1 day', error_code varchar(64), result jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX service_jobs_pending ON staffly_admin.service_jobs(status,created_at);
CREATE TABLE staffly_admin.cleanup_controls (
 job_id uuid PRIMARY KEY, version integer NOT NULL DEFAULT 1, owner_id uuid NOT NULL, reason varchar(1000) NOT NULL,
 updated_by uuid NOT NULL, updated_at timestamptz(3) NOT NULL DEFAULT now(), retry_requested_at timestamptz(3)
);
CREATE TABLE staffly_admin.queue_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind varchar(8) NOT NULL, job_id uuid NOT NULL, attempt integer NOT NULL,
 status varchar(16) NOT NULL, error_code varchar(64), occurred_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX queue_history_job ON staffly_admin.queue_history(kind,job_id,occurred_at,id);
CREATE FUNCTION staffly_admin.record_queue_transition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.attempts IS DISTINCT FROM OLD.attempts
  OR (to_jsonb(NEW)->>'last_error_code') IS DISTINCT FROM (to_jsonb(OLD)->>'last_error_code') THEN
  INSERT INTO staffly_admin.queue_history(kind,job_id,attempt,status,error_code)
  VALUES(CASE TG_TABLE_NAME WHEN 'email_deliveries' THEN 'email' ELSE 'report' END,NEW.id,NEW.attempts,NEW.status,
   left(COALESCE(to_jsonb(NEW)->>'last_error_code',to_jsonb(NEW)->>'error_code',to_jsonb(NEW)->>'skip_reason'),64));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_email_history AFTER INSERT OR UPDATE ON public.email_deliveries FOR EACH ROW EXECUTE FUNCTION staffly_admin.record_queue_transition();
CREATE TRIGGER service_report_history AFTER INSERT OR UPDATE ON public.report_exports FOR EACH ROW EXECUTE FUNCTION staffly_admin.record_queue_transition();
CREATE TABLE staffly_admin.queue_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL, command varchar(8) NOT NULL,
 reason varchar(1000) NOT NULL, results jsonb NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TABLE staffly_admin.backup_schedule (
 id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 owner_id uuid, create_minutes integer NOT NULL DEFAULT 1440 CHECK(create_minutes BETWEEN 15 AND 10080),
 verify_minutes integer NOT NULL DEFAULT 1440 CHECK(verify_minutes BETWEEN 15 AND 10080),
 cleanup_minutes integer NOT NULL DEFAULT 1440 CHECK(cleanup_minutes BETWEEN 15 AND 10080),
 next_create_at timestamptz(3), next_verify_at timestamptz(3), next_cleanup_at timestamptz(3),
 last_create_id uuid, last_verify_id uuid, last_cleanup_id uuid, heartbeat_at timestamptz(3), updated_at timestamptz(3) NOT NULL DEFAULT now()
);
INSERT INTO staffly_admin.backup_schedule(id) VALUES(1);
CREATE TABLE staffly_admin.backup_components (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), backup_id uuid, component varchar(12) NOT NULL CHECK(component IN ('database','files','deletions')),
 snapshot_at timestamptz(3) NOT NULL, checked_at timestamptz(3), expires_at timestamptz(3) NOT NULL,
 status varchar(12) NOT NULL CHECK(status IN ('VERIFIED','FAILED')), sha256 varchar(64), objects bigint,
 consistent boolean NOT NULL DEFAULT false, check_code varchar(64), schema_version varchar(100)
);
CREATE INDEX backup_components_latest ON staffly_admin.backup_components(component,snapshot_at DESC);
CREATE TABLE staffly_admin.restore_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), backup_id uuid NOT NULL REFERENCES staffly_admin.backups(id),
 status varchar(12) NOT NULL CHECK(status IN ('SUCCEEDED','FAILED')), checked_at timestamptz(3) NOT NULL DEFAULT now(),
 duration_ms integer NOT NULL CHECK(duration_ms>=0), schema_version varchar(100), checks jsonb NOT NULL DEFAULT '{}', error_code varchar(64)
);
CREATE TABLE staffly_admin.content_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(160) NOT NULL UNIQUE,
 kind varchar(16) NOT NULL CHECK(kind IN ('home','guide','faq','contacts','announcement','legal')),
 version integer NOT NULL DEFAULT 0, created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TABLE staffly_admin.content_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES staffly_admin.content_items(id),
 revision integer NOT NULL, title varchar(200) NOT NULL, body text NOT NULL CHECK(length(body)<=100000),
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object' AND length(metadata::text)<=4096),
 effective_at timestamptz(3) NOT NULL, author_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(item_id,revision)
);
CREATE TABLE staffly_admin.content_reviews (
 revision_id uuid PRIMARY KEY REFERENCES staffly_admin.content_revisions(id), reviewed_by uuid NOT NULL,
 reviewed_at timestamptz(3) NOT NULL DEFAULT now(), checks jsonb NOT NULL
);
CREATE TABLE staffly_admin.content_publications (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, item_id uuid NOT NULL REFERENCES staffly_admin.content_items(id),
 revision_id uuid NOT NULL REFERENCES staffly_admin.content_revisions(id), actor_id uuid NOT NULL, reason varchar(1000) NOT NULL,
 effective_at timestamptz(3) NOT NULL, published_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE VIEW public.platform_public_content AS
 SELECT DISTINCT ON(i.key) i.key,i.kind,r.title,r.body,r.metadata,r.revision,p.effective_at,p.published_at
 FROM staffly_admin.content_items i JOIN staffly_admin.content_publications p ON p.item_id=i.id
 JOIN staffly_admin.content_revisions r ON r.id=p.revision_id AND r.item_id=i.id
 WHERE p.effective_at<=now() ORDER BY i.key,p.id DESC;
CREATE TABLE staffly_admin.maintenance_windows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), starts_at timestamptz(3) NOT NULL, ends_at timestamptz(3) NOT NULL,
 reason varchar(1000) NOT NULL, announcement varchar(1000) NOT NULL, owner_id uuid NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','IN_PROGRESS','VERIFYING','COMPLETED','CANCELLED')),
 read_only boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 app_version varchar(100), schema_version varchar(100), prechecks jsonb NOT NULL DEFAULT '{}', postchecks jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(), CHECK(ends_at>starts_at)
);
CREATE VIEW public.platform_maintenance_notice AS
 SELECT DISTINCT id,starts_at,ends_at,announcement,read_only,status FROM staffly_admin.maintenance_windows
 WHERE status IN ('PLANNED','IN_PROGRESS','VERIFYING') AND ends_at>now() ORDER BY starts_at;
CREATE TABLE staffly_admin.delivery_settings (
 id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL DEFAULT 1, enabled boolean NOT NULL DEFAULT false,
 channel varchar(12) NOT NULL DEFAULT 'webhook' CHECK(channel IN ('webhook','email','telegram')),
 recipients text[] NOT NULL DEFAULT '{}', escalation_recipients text[] NOT NULL DEFAULT '{}',
 escalation_minutes integer NOT NULL DEFAULT 15 CHECK(escalation_minutes BETWEEN 1 AND 1440),
 repeat_minutes integer NOT NULL DEFAULT 60 CHECK(repeat_minutes BETWEEN 1 AND 1440), owner_id uuid,
 updated_at timestamptz(3) NOT NULL DEFAULT now(), CHECK(cardinality(recipients)<=10 AND cardinality(escalation_recipients)<=10)
);
INSERT INTO staffly_admin.delivery_settings(id) VALUES(1);
CREATE TABLE staffly_admin.external_probe (
 id integer PRIMARY KEY CHECK(id=1), heartbeat_at timestamptz(3), checked_at timestamptz(3), available boolean,
 consecutive_failures integer NOT NULL DEFAULT 0, incident_id uuid, last_delivery_at timestamptz(3), last_delivery_error varchar(64)
);
INSERT INTO staffly_admin.external_probe(id) VALUES(1);
CREATE TABLE staffly_admin.signal_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), incident_id uuid NOT NULL, stage varchar(16) NOT NULL,
 channel varchar(12) NOT NULL, recipient varchar(254) NOT NULL, status varchar(16) NOT NULL,
 attempted_at timestamptz(3) NOT NULL DEFAULT now(), confirmed_at timestamptz(3), error_code varchar(64), provider_id varchar(100)
);
CREATE INDEX signal_deliveries_incident ON staffly_admin.signal_deliveries(incident_id,attempted_at DESC);
CREATE VIEW staffly_admin.user_service_sessions AS
 SELECT id,user_id,created_at,last_used_at,last_active_at,idle_expires_at,absolute_expires_at,revoked_at,refresh_reuse_detected_at,
 left(user_agent,512) AS user_agent,ip_address FROM public.auth_sessions;
-- No password, token hashes, document names, content or physical storage paths.
CREATE VIEW staffly_admin.cleanup_directory AS
 SELECT d.*,COALESCE(c.version,0) AS control_version,c.owner_id,c.reason,c.updated_at,c.retry_requested_at,
 (SELECT count(*)::int FROM public.stored_files f WHERE f.purged_at IS NULL AND CASE WHEN d.kind='ORGANIZATION' THEN f.organization_id=d.subject_id ELSE f.uploaded_by_user_id=d.subject_id AND f.organization_id IS NULL END) AS files_remaining,
 (SELECT count(*)::int FROM public.stored_files f WHERE f.last_deletion_error IS NOT NULL AND CASE WHEN d.kind='ORGANIZATION' THEN f.organization_id=d.subject_id ELSE f.uploaded_by_user_id=d.subject_id AND f.organization_id IS NULL END) AS files_failed
 FROM public.data_deletions d LEFT JOIN staffly_admin.cleanup_controls c ON c.job_id=d.id;
CREATE FUNCTION staffly_admin.queue_action_reason(p_kind text,p_id uuid,p_command text) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e public.email_deliveries; r public.report_exports;
BEGIN
 IF p_command NOT IN ('retry','cancel') THEN RETURN 'INVALID_COMMAND'; END IF;
 IF p_kind='email' THEN
  SELECT * INTO e FROM public.email_deliveries WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF e.source_kind='MANDATORY' OR e.category IS NULL THEN RETURN 'SECURITY_MESSAGE'; END IF;
  IF e.status IN ('SENT','SKIPPED') THEN RETURN 'ALREADY_FINISHED'; END IF;
  IF e.locked_until>now() THEN RETURN 'RUNNING'; END IF;
  IF e.created_at<=now()-interval '1 day' THEN RETURN 'EXPIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=e.user_id AND deleted_at IS NULL AND email_verified_at IS NOT NULL) THEN RETURN 'ACCOUNT_UNAVAILABLE'; END IF;
  IF e.organization_id IS NOT NULL AND NOT public.platform_organization_available(e.organization_id) THEN RETURN 'ORGANIZATION_UNAVAILABLE'; END IF;
  IF p_command='cancel' AND e.status<>'PENDING' THEN RETURN 'NOT_PENDING'; END IF;
  IF p_command='retry' AND (e.status<>'FAILED' OR e.attempts>=7) THEN RETURN 'ATTEMPTS_OR_STATE'; END IF;
  IF p_command='retry' AND e.organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.organization_resource_budgets WHERE organization_id=e.organization_id AND pending_emails>=email_queue_limit) THEN RETURN 'QUEUE_LIMIT'; END IF;
 ELSIF p_kind='report' THEN
  SELECT * INTO r FROM public.report_exports WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF r.expires_at<=now() THEN RETURN 'EXPIRED'; END IF;
  IF r.status='RUNNING' OR r.lease_until>now() THEN RETURN 'RUNNING'; END IF;
  IF NOT public.platform_organization_available(r.organization_id) THEN RETURN 'ORGANIZATION_UNAVAILABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.organization_members m ON m.user_id=u.id WHERE u.id=r.user_id AND u.deleted_at IS NULL AND m.organization_id=r.organization_id AND m.left_at IS NULL) THEN RETURN 'ACCOUNT_UNAVAILABLE'; END IF;
  IF p_command='cancel' AND r.status<>'PENDING' THEN RETURN 'NOT_PENDING'; END IF;
  IF p_command='retry' AND (r.status<>'FAILED' OR r.attempts>=3) THEN RETURN 'ATTEMPTS_OR_STATE'; END IF;
 ELSE RETURN 'INVALID_KIND'; END IF;
 RETURN 'OK';
END $$;
REVOKE ALL ON FUNCTION staffly_admin.queue_action_reason(text,uuid,text) FROM PUBLIC;
CREATE FUNCTION staffly_admin.perform_service_action(p_action text,p_target uuid,p_payload jsonb,p_user uuid,p_auth uuid,p_session uuid,p_hash text)
RETURNS TABLE(result text,resource_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o public.organizations; s public.organization_subscriptions; d public.data_deletions;
 change_reason text:=p_payload->>'reason'; v integer; resource uuid:=p_target; before_value jsonb:='{}'; after_value jsonb:='{}';
 item jsonb; code text; results jsonb:='[]'; schedule staffly_admin.backup_schedule; w staffly_admin.maintenance_windows;
 content_revision staffly_admin.content_revisions; state text; entry record;
BEGIN
 IF change_reason IS NULL OR length(btrim(change_reason)) NOT BETWEEN 5 AND 1000 THEN RETURN QUERY SELECT 'INVALID',NULL::uuid; RETURN; END IF;
 IF p_action='USER_SESSION_REVOKE' THEN
  IF p_target=p_auth THEN RETURN QUERY SELECT 'SELF',NULL::uuid;RETURN;END IF;
  UPDATE public.auth_sessions SET revoked_at=now(),last_active_at=NULL WHERE id=p_target AND user_id=(p_payload->>'userId')::uuid
   AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now() AND last_used_at=(p_payload->>'lastUsedAt')::timestamptz;
  IF NOT FOUND THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  UPDATE staffly_admin.sessions SET revoked_at=now() WHERE auth_session_id=p_target AND revoked_at IS NULL;
  INSERT INTO public.security_events(id,user_id,correlation_id,action,outcome,resource_type,resource_id,reason_code)
   VALUES(gen_random_uuid(),(p_payload->>'userId')::uuid,gen_random_uuid(),'SESSION_REVOKED','SUCCEEDED','SESSION',p_target,'ADMIN_SUPPORT');
 ELSIF p_action='USER_RECOVERY' THEN
  PERFORM 1 FROM public.users WHERE id=p_target AND deleted_at IS NULL AND email_verified_at IS NOT NULL AND security_version=(p_payload->>'version')::integer FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  IF EXISTS(SELECT 1 FROM staffly_admin.service_jobs WHERE kind='USER_RECOVERY' AND target_id=p_target AND created_at>now()-interval '15 minutes') THEN RETURN QUERY SELECT 'LIMIT',NULL::uuid;RETURN;END IF;
  INSERT INTO staffly_admin.service_jobs(kind,target_id,requested_by,payload) VALUES(p_action,p_target,p_user,jsonb_build_object('userVersion',p_payload->'version')) RETURNING id INTO resource;
 ELSIF p_action IN ('ORG_STATE','PLAN_ADJUST') THEN
  IF p_action='ORG_STATE' THEN PERFORM pg_advisory_xact_lock(hashtextextended(p_target::text,681947262));ELSE PERFORM pg_advisory_xact_lock(hashtextextended(p_target::text,1));END IF;
  SELECT * INTO o FROM public.organizations WHERE id=p_target AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND',NULL::uuid;RETURN;END IF;
  IF p_action='ORG_STATE' THEN
   IF o.service_revision<>(p_payload->>'version')::integer OR p_payload->>'state' NOT IN ('ACTIVE','SUSPENDED') THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
   IF p_payload->>'state'='SUSPENDED' AND p_payload->>'until' IS NOT NULL AND (p_payload->>'until')::timestamptz<=now() THEN RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;END IF;
   before_value:=jsonb_build_object('state',o.service_state,'until',o.service_until);
   UPDATE public.organizations SET service_state=p_payload->>'state',service_reason=change_reason,
    service_until=CASE WHEN p_payload->>'state'='SUSPENDED' THEN (p_payload->>'until')::timestamptz ELSE NULL END,
    service_revision=service_revision+1,updated_at=now() WHERE id=p_target;
   after_value:=jsonb_build_object('state',p_payload->>'state','until',p_payload->>'until');
  ELSE
   SELECT * INTO s FROM public.organization_subscriptions WHERE organization_id=p_target FOR UPDATE;
   IF NOT FOUND OR s.revision<>(p_payload->>'version')::integer THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
   IF p_payload->>'plan' NOT IN ('FREE','TEAM','BUSINESS') OR (p_payload->>'endsAt')::timestamptz<=(p_payload->>'startsAt')::timestamptz
    OR (p_payload->>'endsAt')::timestamptz<=now() OR (p_payload->>'endsAt')::timestamptz>(p_payload->>'startsAt')::timestamptz+interval '366 days' THEN RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;END IF;
   IF p_payload->>'plan' IS NULL AND COALESCE((p_payload->>'revoke')::boolean,false)=false THEN RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;END IF;
   before_value:=jsonb_build_object('plan',s.support_plan,'startsAt',s.support_starts_at,'endsAt',s.support_ends_at);
   UPDATE public.organization_subscriptions SET support_plan=CASE WHEN COALESCE((p_payload->>'revoke')::boolean,false) THEN NULL ELSE p_payload->>'plan' END,
    support_starts_at=CASE WHEN COALESCE((p_payload->>'revoke')::boolean,false) THEN NULL ELSE (p_payload->>'startsAt')::timestamptz END,
    support_ends_at=CASE WHEN COALESCE((p_payload->>'revoke')::boolean,false) THEN NULL ELSE (p_payload->>'endsAt')::timestamptz END,
    revision=revision+1,updated_at=now() WHERE organization_id=p_target;
   PERFORM public.staffly_sync_subscription_storage_limit(p_target);
   after_value:=p_payload-'reason'-'version';
  END IF;
 ELSIF p_action='FILE_CLEANUP_CONTROL' THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(p_target::text,92)) THEN RETURN QUERY SELECT 'BUSY',NULL::uuid;RETURN;END IF;
  PERFORM 1 FROM public.stored_files WHERE id=p_target AND pending_deletion_at IS NOT NULL AND purged_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  SELECT COALESCE((SELECT version FROM staffly_admin.file_cleanup_controls WHERE file_id=p_target),0) INTO v;
  IF v<>(p_payload->>'version')::int OR NOT EXISTS(SELECT 1 FROM staffly_admin.administrator_directory WHERE user_id=(p_payload->>'ownerId')::uuid AND enabled AND NOT deleted) THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  INSERT INTO staffly_admin.file_cleanup_controls(file_id,hold,owner_id,reason,updated_by)
   VALUES(p_target,(p_payload->>'hold')::boolean,(p_payload->>'ownerId')::uuid,change_reason,p_user)
   ON CONFLICT(file_id) DO UPDATE SET hold=EXCLUDED.hold,version=staffly_admin.file_cleanup_controls.version+1,owner_id=EXCLUDED.owner_id,reason=EXCLUDED.reason,updated_by=p_user,updated_at=now();
  IF COALESCE((p_payload->>'retry')::boolean,false) THEN
   UPDATE public.stored_files SET last_deletion_error=NULL,pending_deletion_at=now() WHERE id=p_target;
  END IF;
  after_value:=p_payload-'reason'-'version';
 ELSIF p_action='CLEANUP_CONTROL' THEN
  -- Same lock as the purge worker, held through the update and audit.
  IF NOT pg_try_advisory_xact_lock(hashtextextended(p_target::text,91)) THEN RETURN QUERY SELECT 'BUSY',NULL::uuid;RETURN;END IF;
  SELECT * INTO d FROM public.data_deletions WHERE id=p_target FOR UPDATE;
  IF NOT FOUND OR d.completed_at IS NOT NULL THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  SELECT COALESCE((SELECT version FROM staffly_admin.cleanup_controls WHERE job_id=p_target),0) INTO v;
  IF v<>(p_payload->>'version')::integer OR NOT EXISTS(SELECT 1 FROM staffly_admin.administrator_directory WHERE user_id=(p_payload->>'ownerId')::uuid AND enabled AND NOT deleted) THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  IF COALESCE((p_payload->>'retry')::boolean,false) AND (d.hold OR d.due_at>now() OR d.last_error_code IS NULL) THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  before_value:=jsonb_build_object('hold',d.hold,'lastError',d.last_error_code);
  UPDATE public.data_deletions SET hold=(p_payload->>'hold')::boolean,last_error_code=CASE WHEN COALESCE((p_payload->>'retry')::boolean,false) THEN NULL ELSE last_error_code END WHERE id=p_target;
  INSERT INTO staffly_admin.cleanup_controls(job_id,owner_id,reason,updated_by,retry_requested_at) VALUES(p_target,(p_payload->>'ownerId')::uuid,change_reason,p_user,CASE WHEN COALESCE((p_payload->>'retry')::boolean,false) THEN now() END)
   ON CONFLICT(job_id) DO UPDATE SET version=staffly_admin.cleanup_controls.version+1,owner_id=EXCLUDED.owner_id,reason=EXCLUDED.reason,updated_by=p_user,updated_at=now(),retry_requested_at=EXCLUDED.retry_requested_at;
  after_value:=p_payload-'reason'-'version';
 ELSIF p_action='QUEUE_ACTION' THEN
  IF jsonb_typeof(p_payload->'jobs')<>'array' OR jsonb_array_length(p_payload->'jobs') NOT BETWEEN 1 AND 20 THEN RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'jobs') LOOP
   code:=staffly_admin.queue_action_reason(item->>'kind',(item->>'id')::uuid,p_payload->>'command');
   IF code='OK' AND ((item->>'kind'='report' AND NOT EXISTS(SELECT 1 FROM public.report_exports WHERE id=(item->>'id')::uuid AND status=item->>'expectedStatus' AND attempts=(item->>'expectedAttempts')::int))
    OR (item->>'kind'='email' AND NOT EXISTS(SELECT 1 FROM public.email_deliveries WHERE id=(item->>'id')::uuid AND status=item->>'expectedStatus' AND attempts=(item->>'expectedAttempts')::int))) THEN code:='CHANGED'; END IF;
   IF code='OK' THEN
    IF item->>'kind'='report' THEN
     IF p_payload->>'command'='retry' THEN code:=staffly_admin.retry_report(p_user,p_auth,p_session,p_hash,(item->>'id')::uuid);
     ELSE UPDATE public.report_exports SET status='CANCELLED',lease_token=NULL,lease_until=NULL,error_code='ADMIN_CANCELLED' WHERE id=(item->>'id')::uuid; END IF;
    ELSE
     UPDATE public.email_deliveries SET status=CASE WHEN p_payload->>'command'='retry' THEN 'PENDING' ELSE 'SKIPPED' END,
      available_at=now(),locked_until=NULL,last_error_code=NULL,skip_reason=CASE WHEN p_payload->>'command'='cancel' THEN 'ADMIN_CANCELLED' ELSE NULL END WHERE id=(item->>'id')::uuid;
    END IF;
   END IF;
   results:=results||jsonb_build_array(jsonb_build_object('kind',item->>'kind','id',item->>'id','result',code));
  END LOOP;
  INSERT INTO staffly_admin.queue_batches(actor_id,command,reason,results) VALUES(p_user,p_payload->>'command',change_reason,results) RETURNING id INTO resource;
 ELSIF p_action='BACKUP_SCHEDULE' THEN
  SELECT * INTO schedule FROM staffly_admin.backup_schedule WHERE id=1 FOR UPDATE;
  IF schedule.version<>(p_payload->>'version')::integer THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  IF NOT EXISTS(SELECT 1 FROM staffly_admin.administrator_directory WHERE user_id=(p_payload->>'ownerId')::uuid AND enabled AND NOT deleted) THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  before_value:=to_jsonb(schedule)-'heartbeat_at';
  UPDATE staffly_admin.backup_schedule SET enabled=(p_payload->>'enabled')::boolean,owner_id=(p_payload->>'ownerId')::uuid,
   create_minutes=(p_payload->>'createMinutes')::integer,verify_minutes=(p_payload->>'verifyMinutes')::integer,cleanup_minutes=(p_payload->>'cleanupMinutes')::integer,
   next_create_at=now(),next_verify_at=now(),next_cleanup_at=now(),version=version+1,updated_at=now() WHERE id=1;
  after_value:=p_payload-'reason'-'version';
 ELSIF p_action IN ('RESTORE_CHECK','DELIVERY_TEST') THEN
  IF p_action='RESTORE_CHECK' AND NOT EXISTS(SELECT 1 FROM staffly_admin.backups WHERE id=p_target AND file_state='AVAILABLE' AND verified_at IS NOT NULL AND expires_at>now()) THEN RETURN QUERY SELECT 'NOT_FOUND',NULL::uuid;RETURN;END IF;
  IF EXISTS(SELECT 1 FROM staffly_admin.service_jobs WHERE kind=p_action AND target_id IS NOT DISTINCT FROM p_target AND status IN ('PENDING','RUNNING') AND expires_at>now()) THEN RETURN QUERY SELECT 'BUSY',NULL::uuid;RETURN;END IF;
  INSERT INTO staffly_admin.service_jobs(kind,target_id,requested_by) VALUES(p_action,p_target,p_user) RETURNING id INTO resource;
 ELSIF p_action='CONTENT_PUBLISH' THEN
  SELECT r.* INTO content_revision FROM staffly_admin.content_revisions r JOIN staffly_admin.content_items i ON i.id=r.item_id WHERE r.id=p_target AND i.version=(p_payload->>'version')::integer FOR UPDATE OF i;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM staffly_admin.content_reviews WHERE revision_id=p_target) THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  INSERT INTO staffly_admin.content_publications(item_id,revision_id,actor_id,reason,effective_at)
   VALUES(content_revision.item_id,content_revision.id,p_user,change_reason,GREATEST(now(),(p_payload->>'effectiveAt')::timestamptz));
  UPDATE staffly_admin.content_items SET version=version+1 WHERE id=content_revision.item_id;
  after_value:=jsonb_build_object('revision',content_revision.revision,'effectiveAt',p_payload->>'effectiveAt');
 ELSIF p_action='MAINTENANCE_WINDOW' THEN
  state:=p_payload->>'status';
  IF NOT EXISTS(SELECT 1 FROM staffly_admin.administrator_directory WHERE user_id=(p_payload->>'ownerId')::uuid AND enabled AND NOT deleted AND email_verified AND password_set) THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  IF state NOT IN ('PLANNED','IN_PROGRESS','VERIFYING','COMPLETED','CANCELLED') OR (p_payload->>'endsAt')::timestamptz<=(p_payload->>'startsAt')::timestamptz THEN RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;END IF;
  IF p_target IS NOT NULL THEN
   SELECT * INTO w FROM staffly_admin.maintenance_windows WHERE id=p_target FOR UPDATE;
   IF NOT FOUND OR w.version<>(p_payload->>'version')::integer OR w.status IN ('COMPLETED','CANCELLED') THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
   IF NOT ((w.status='PLANNED' AND state IN ('PLANNED','IN_PROGRESS','CANCELLED')) OR (w.status='IN_PROGRESS' AND state IN ('IN_PROGRESS','VERIFYING','CANCELLED')) OR (w.status='VERIFYING' AND state IN ('VERIFYING','IN_PROGRESS','COMPLETED','CANCELLED'))) THEN RETURN QUERY SELECT 'INVALID_TRANSITION',NULL::uuid;RETURN;END IF;
   IF state='COMPLETED' AND (w.status<>'VERIFYING' OR (NOT COALESCE((w.postchecks->>'passed')::boolean,false) OR NOT COALESCE((w.postchecks->>'checkedAt')::timestamptz>now()-interval '15 minutes',false))) THEN RETURN QUERY SELECT 'CHECKS_REQUIRED',NULL::uuid;RETURN;END IF;
   IF state='IN_PROGRESS' AND (NOT COALESCE((w.prechecks->>'passed')::boolean,false) OR NOT COALESCE((w.prechecks->>'checkedAt')::timestamptz>now()-interval '15 minutes',false)) THEN RETURN QUERY SELECT 'CHECKS_REQUIRED',NULL::uuid;RETURN;END IF;
   before_value:=jsonb_build_object('status',w.status,'startsAt',w.starts_at,'endsAt',w.ends_at);
   UPDATE staffly_admin.maintenance_windows SET status=state,starts_at=(p_payload->>'startsAt')::timestamptz,ends_at=(p_payload->>'endsAt')::timestamptz,reason=change_reason,
    announcement=p_payload->>'announcement',read_only=(p_payload->>'readOnly')::boolean,owner_id=(p_payload->>'ownerId')::uuid,version=version+1,updated_at=now() WHERE id=p_target;
  ELSE
   IF state<>'PLANNED' THEN RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;END IF;
   INSERT INTO staffly_admin.maintenance_windows(starts_at,ends_at,reason,announcement,read_only,owner_id)
    VALUES((p_payload->>'startsAt')::timestamptz,(p_payload->>'endsAt')::timestamptz,change_reason,p_payload->>'announcement',(p_payload->>'readOnly')::boolean,(p_payload->>'ownerId')::uuid) RETURNING id INTO resource;
  END IF;
  after_value:=p_payload-'reason'-'version';
 ELSIF p_action='DELIVERY_SETTINGS' THEN
  SELECT version INTO v FROM staffly_admin.delivery_settings WHERE id=1 FOR UPDATE;
  IF v<>(p_payload->>'version')::integer OR p_payload->>'channel' NOT IN ('webhook','email','telegram') THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid;RETURN;END IF;
  UPDATE staffly_admin.delivery_settings SET enabled=(p_payload->>'enabled')::boolean,channel=p_payload->>'channel',
   recipients=ARRAY(SELECT jsonb_array_elements_text(p_payload->'recipients')),escalation_recipients=ARRAY(SELECT jsonb_array_elements_text(p_payload->'escalationRecipients')),
   escalation_minutes=(p_payload->>'escalationMinutes')::integer,repeat_minutes=(p_payload->>'repeatMinutes')::integer,owner_id=p_user,version=version+1,updated_at=now() WHERE id=1;
  after_value:=p_payload-'reason'-'version';
 ELSE RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;
 END IF;
 INSERT INTO staffly_admin.service_history(subject_kind,subject_id,action,reason,actor_id,before_value,after_value)
  VALUES(p_action,p_target,p_action,change_reason,p_user,before_value,after_value);
 RETURN QUERY SELECT 'OK',resource;
END $$;
REVOKE ALL ON FUNCTION staffly_admin.perform_service_action(text,uuid,jsonb,uuid,uuid,uuid,text) FROM PUBLIC;
ALTER TABLE staffly_admin.action_challenges DROP CONSTRAINT action_challenges_action_check;
ALTER TABLE staffly_admin.action_challenges ADD CHECK(action IN ('ACCESS_GRANT','ACCESS_REVOKE','SESSION_REVOKE','BACKUP_CREATE','ALERT_RULE',
 'USER_SESSION_REVOKE','USER_RECOVERY','ORG_STATE','PLAN_ADJUST','CLEANUP_CONTROL','FILE_CLEANUP_CONTROL','QUEUE_ACTION','BACKUP_SCHEDULE','RESTORE_CHECK','CONTENT_PUBLISH','MAINTENANCE_WINDOW','DELIVERY_SETTINGS','DELIVERY_TEST'));
ALTER FUNCTION staffly_admin.execute_management_action_once(uuid,uuid,uuid,text,uuid,text,text) RENAME TO execute_management_action_legacy;
CREATE FUNCTION staffly_admin.execute_management_action_once(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_challenge uuid,p_browser text,p_proof text)
RETURNS TABLE(result text,resource_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c staffly_admin.action_challenges; valid text; performed record;
BEGIN
 PERFORM pg_advisory_xact_lock(681947253::bigint);
 SELECT * INTO c FROM staffly_admin.action_challenges WHERE id=p_challenge AND user_id=p_user AND session_id=p_session AND auth_session_id=p_auth FOR UPDATE;
 IF c.action IN ('ACCESS_GRANT','ACCESS_REVOKE','SESSION_REVOKE','BACKUP_CREATE','ALERT_RULE') THEN
  RETURN QUERY SELECT * FROM staffly_admin.execute_management_action_legacy(p_user,p_auth,p_session,p_hash,p_challenge,p_browser,p_proof);RETURN;
 END IF;
 valid:=staffly_admin.management_actor(p_user,p_auth,p_session,p_hash);
 IF valid<>'OK' THEN RETURN QUERY SELECT valid,NULL::uuid;RETURN;END IF;
 IF c.id IS NULL OR c.used_at IS NOT NULL OR c.sent_at IS NULL OR c.expires_at<=now() OR c.attempts>=5 OR c.browser_hash<>p_browser
  OR c.grant_version<>(SELECT version FROM staffly_admin.accounts WHERE user_id=p_user) OR c.user_version<>(SELECT security_version FROM public.users WHERE id=p_user) THEN RETURN QUERY SELECT 'INVALID',NULL::uuid;RETURN;END IF;
 IF c.code_hash<>p_proof THEN
  UPDATE staffly_admin.action_challenges SET attempts=attempts+1,used_at=CASE WHEN attempts>=4 THEN now() ELSE NULL END WHERE id=c.id;
  INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource) VALUES(gen_random_uuid(),p_user,p_session,c.action,'DENIED',c.action);
  RETURN QUERY SELECT 'CODE',NULL::uuid;RETURN;
 END IF;
 UPDATE staffly_admin.action_challenges SET used_at=now() WHERE id=c.id;
 BEGIN
  SELECT * INTO performed FROM staffly_admin.perform_service_action(c.action,c.target_id,c.payload,p_user,p_auth,p_session,p_hash);
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR check_violation OR not_null_violation OR numeric_value_out_of_range THEN
  SELECT 'INVALID'::text AS result,NULL::uuid AS resource_id INTO performed;
 END;
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id)
  VALUES(gen_random_uuid(),p_user,p_session,c.action,CASE WHEN performed.result='OK' THEN 'SUCCEEDED' ELSE 'DENIED' END,c.action,performed.resource_id);
 RETURN QUERY SELECT performed.result::text,performed.resource_id::uuid;
END $$;
REVOKE ALL ON FUNCTION staffly_admin.execute_management_action_once(uuid,uuid,uuid,text,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION staffly_admin.execute_management_action_legacy(uuid,uuid,uuid,text,uuid,text,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  REVOKE ALL ON FUNCTION staffly_admin.execute_management_action_legacy(uuid,uuid,uuid,text,uuid,text,text) FROM staffly_admin_gateway;
  GRANT SELECT ON staffly_admin.service_history,staffly_admin.service_jobs,staffly_admin.cleanup_directory,staffly_admin.queue_history,
   staffly_admin.queue_batches,staffly_admin.backup_schedule,staffly_admin.backup_components,staffly_admin.restore_checks,
   staffly_admin.content_items,staffly_admin.content_revisions,staffly_admin.content_reviews,staffly_admin.content_publications,
   staffly_admin.maintenance_windows,staffly_admin.delivery_settings,staffly_admin.external_probe,staffly_admin.signal_deliveries,staffly_admin.user_service_sessions TO staffly_admin_gateway;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  GRANT SELECT ON public.platform_public_content,public.platform_maintenance_notice TO staffly_app;
 END IF;
END $$;
CREATE VIEW staffly_admin.release_schema_state AS
 SELECT (SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1) AS version,
 count(*) FILTER(WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied,
 count(*) FILTER(WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS failed FROM public._prisma_migrations;
CREATE TABLE staffly_admin.release_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_version varchar(100) NOT NULL, schema_version varchar(100) NOT NULL,
 checked_at timestamptz(3) NOT NULL DEFAULT now(), checks jsonb NOT NULL,
 passed boolean NOT NULL, source varchar(40) NOT NULL CHECK(source IN ('operator-ci','runtime'))
);
CREATE FUNCTION staffly_admin.save_service_content(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_draft jsonb)
RETURNS TABLE(result text,item_id uuid,revision_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE valid text; i staffly_admin.content_items; rid uuid;
BEGIN
 valid:=staffly_admin.management_actor(p_user,p_auth,p_session,p_hash);
 IF valid<>'OK' THEN RETURN QUERY SELECT valid,NULL::uuid,NULL::uuid;RETURN;END IF;
 IF p_draft->>'key' !~ '^(home|faq|contacts|announcement|guide:[a-z0-9-]+|legal:(privacy|terms|offer|consent))$'
 OR p_draft->>'kind' NOT IN ('home','guide','faq','contacts','announcement','legal') OR split_part(p_draft->>'key',':',1)<>p_draft->>'kind'
 OR length(p_draft->>'title') NOT BETWEEN 1 AND 200 OR length(p_draft->>'body') NOT BETWEEN 1 AND 100000 THEN RETURN QUERY SELECT 'INVALID',NULL::uuid,NULL::uuid;RETURN;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_draft->>'key',681947259));
 SELECT * INTO i FROM staffly_admin.content_items WHERE key=p_draft->>'key' FOR UPDATE;
 IF COALESCE(i.version,0)<>(p_draft->>'version')::integer THEN RETURN QUERY SELECT 'CONFLICT',NULL::uuid,NULL::uuid;RETURN;END IF;
 IF i.id IS NULL THEN INSERT INTO staffly_admin.content_items(key,kind) VALUES(p_draft->>'key',p_draft->>'kind') RETURNING * INTO i; END IF;
 UPDATE staffly_admin.content_items SET version=version+1 WHERE id=i.id;
 INSERT INTO staffly_admin.content_revisions(item_id,revision,title,body,metadata,effective_at,author_id)
  VALUES(i.id,i.version+1,p_draft->>'title',p_draft->>'body',COALESCE(p_draft->'metadata','{}'),(p_draft->>'effectiveAt')::timestamptz,p_user) RETURNING id INTO rid;
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id)
  VALUES(gen_random_uuid(),p_user,p_session,'CONTENT_DRAFT_SAVED','SUCCEEDED','CONTENT',rid);
 RETURN QUERY SELECT 'OK',i.id,rid;
END $$;
CREATE FUNCTION staffly_admin.review_service_content(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_revision uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE valid text; r staffly_admin.content_revisions;
BEGIN
 valid:=staffly_admin.management_actor(p_user,p_auth,p_session,p_hash);IF valid<>'OK' THEN RETURN valid;END IF;
 SELECT * INTO r FROM staffly_admin.content_revisions WHERE id=p_revision;
 IF NOT FOUND THEN RETURN 'NOT_FOUND';END IF;
 -- Raw HTML and executable URL protocols have no place in public content.
 IF r.body ~* '<\s*/?\s*[a-z!]' OR r.body ~* '(javascript|vbscript|data)\s*:' THEN RETURN 'CONTENT_INVALID';END IF;
 INSERT INTO staffly_admin.content_reviews(revision_id,reviewed_by,checks) VALUES(p_revision,p_user,'{"length":true,"safeMarkup":true,"previewReviewed":true}')
  ON CONFLICT(revision_id) DO UPDATE SET reviewed_by=p_user,reviewed_at=now(),checks=EXCLUDED.checks;
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),p_user,p_session,'CONTENT_REVIEWED','SUCCEEDED','CONTENT',p_revision);
 RETURN 'OK';
END $$;
CREATE FUNCTION staffly_admin.record_runtime_checks(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_window uuid,p_checks jsonb,p_app text,p_schema text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE valid text; w staffly_admin.maintenance_windows;
BEGIN
 valid:=staffly_admin.management_actor(p_user,p_auth,p_session,p_hash);IF valid<>'OK' THEN RETURN valid;END IF;
 IF jsonb_typeof(p_checks)<>'object' OR NOT p_checks ?& ARRAY['database','backup','release','passed','checkedAt'] OR length(p_checks::text)>4096 THEN RETURN 'INVALID';END IF;
 SELECT * INTO w FROM staffly_admin.maintenance_windows WHERE id=p_window FOR UPDATE;
 IF NOT FOUND OR w.status NOT IN ('PLANNED','IN_PROGRESS','VERIFYING') THEN RETURN 'CONFLICT';END IF;
 UPDATE staffly_admin.maintenance_windows SET prechecks=CASE WHEN status='PLANNED' THEN p_checks ELSE prechecks END,
  postchecks=CASE WHEN status='VERIFYING' THEN p_checks ELSE postchecks END,app_version=left(p_app,100),schema_version=left(p_schema,100),version=version+1,updated_at=now() WHERE id=p_window;
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),p_user,p_session,'MAINTENANCE_CHECKED','SUCCEEDED','MAINTENANCE',p_window);
 RETURN 'OK';
END $$;
REVOKE ALL ON FUNCTION staffly_admin.save_service_content(uuid,uuid,uuid,text,jsonb),staffly_admin.review_service_content(uuid,uuid,uuid,text,uuid),staffly_admin.record_runtime_checks(uuid,uuid,uuid,text,uuid,jsonb,text,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT SELECT ON staffly_admin.release_schema_state,staffly_admin.release_checks TO staffly_admin_gateway;
  GRANT EXECUTE ON FUNCTION staffly_admin.save_service_content(uuid,uuid,uuid,text,jsonb),staffly_admin.review_service_content(uuid,uuid,uuid,text,uuid),staffly_admin.record_runtime_checks(uuid,uuid,uuid,text,uuid,jsonb,text,text) TO staffly_admin_gateway;
 END IF;
END $$;
-- Ordinary app credentials cannot turn support overrides into client-editable fields.
CREATE FUNCTION public.staffly_service_fields_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
  IF TG_TABLE_NAME='organizations' AND (to_jsonb(NEW)->'service_state',to_jsonb(NEW)->'service_reason',to_jsonb(NEW)->'service_until',to_jsonb(NEW)->'service_revision') IS DISTINCT FROM (to_jsonb(OLD)->'service_state',to_jsonb(OLD)->'service_reason',to_jsonb(OLD)->'service_until',to_jsonb(OLD)->'service_revision') THEN RAISE EXCEPTION 'Service fields require the protected administrative action' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='organization_subscriptions' AND (to_jsonb(NEW)->'support_plan',to_jsonb(NEW)->'support_starts_at',to_jsonb(NEW)->'support_ends_at') IS DISTINCT FROM (to_jsonb(OLD)->'support_plan',to_jsonb(OLD)->'support_starts_at',to_jsonb(OLD)->'support_ends_at') THEN RAISE EXCEPTION 'Support fields require the protected administrative action' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_service_fields BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.staffly_service_fields_guard();
CREATE TRIGGER subscription_support_fields BEFORE UPDATE ON public.organization_subscriptions FOR EACH ROW EXECUTE FUNCTION public.staffly_service_fields_guard();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.platform_public_content,public.platform_maintenance_notice FROM staffly_app;
 END IF;
END $$;
CREATE TABLE staffly_admin.file_cleanup_controls (
 file_id uuid PRIMARY KEY, hold boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 owner_id uuid NOT NULL, reason varchar(1000) NOT NULL, updated_by uuid NOT NULL, updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE FUNCTION public.platform_file_cleanup_allowed(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM staffly_admin.file_cleanup_controls WHERE file_id=p_id AND hold)
$$;
CREATE VIEW staffly_admin.file_cleanup_directory AS
 SELECT f.id,f.organization_id,f.uploaded_by_user_id,f.purpose,f.size,f.pending_deletion_at,f.deletion_attempts,
 f.last_deletion_error IS NOT NULL AS failed,COALESCE(c.hold,false) AS hold,COALESCE(c.version,0) AS control_version,c.owner_id,c.reason,c.updated_at
 FROM public.stored_files f LEFT JOIN staffly_admin.file_cleanup_controls c ON c.file_id=f.id
 WHERE f.pending_deletion_at IS NOT NULL AND f.purged_at IS NULL;
ALTER TABLE staffly_admin.external_probe ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}';
CREATE TABLE staffly_admin.service_runner_state(id integer PRIMARY KEY CHECK(id=1),heartbeat_at timestamptz(3),configuration jsonb NOT NULL DEFAULT '{}',last_error_code varchar(64));
INSERT INTO staffly_admin.service_runner_state(id) VALUES(1);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT SELECT ON staffly_admin.file_cleanup_directory,staffly_admin.service_runner_state TO staffly_admin_gateway;
 END IF;
END $$;
CREATE TABLE staffly_admin.signal_receipts (
 delivery_id uuid PRIMARY KEY REFERENCES staffly_admin.signal_deliveries(id) ON DELETE CASCADE,
 proof varchar(64) NOT NULL, expires_at timestamptz(3) NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5)
);
CREATE FUNCTION staffly_admin.confirm_signal(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_id uuid,p_proof text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE valid text; receipt staffly_admin.signal_receipts;
BEGIN
 valid:=staffly_admin.management_actor(p_user,p_auth,p_session,p_hash);IF valid<>'OK' THEN RETURN valid;END IF;
 SELECT * INTO receipt FROM staffly_admin.signal_receipts WHERE delivery_id=p_id FOR UPDATE;
 IF NOT FOUND OR receipt.expires_at<=now() OR receipt.attempts>=5 THEN RETURN 'EXPIRED';END IF;
 UPDATE staffly_admin.signal_receipts SET attempts=attempts+1 WHERE delivery_id=p_id;
 IF receipt.proof<>p_proof THEN RETURN 'CODE';END IF;
 UPDATE staffly_admin.signal_deliveries SET status='CONFIRMED',confirmed_at=now() WHERE id=p_id AND status='ACCEPTED';
 IF NOT FOUND THEN RETURN 'CONFLICT';END IF;
 UPDATE staffly_admin.signal_receipts SET expires_at=now() WHERE delivery_id=p_id;
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),p_user,p_session,'SIGNAL_DELIVERY_CONFIRMED','SUCCEEDED','SIGNAL',p_id);
 RETURN 'OK';
END $$;
REVOKE ALL ON FUNCTION staffly_admin.confirm_signal(uuid,uuid,uuid,text,uuid,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN GRANT EXECUTE ON FUNCTION staffly_admin.confirm_signal(uuid,uuid,uuid,text,uuid,text) TO staffly_admin_gateway;END IF;
END $$;

CREATE OR REPLACE FUNCTION staffly_admin.execute_management_action(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_challenge uuid,p_browser text,p_proof text)
RETURNS TABLE(result text,resource_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE performed record;
BEGIN
 SELECT * INTO performed FROM staffly_admin.execute_management_action_once(p_user,p_auth,p_session,p_hash,p_challenge,p_browser,p_proof);
 IF performed.result='OK' THEN
  INSERT INTO staffly_admin.action_receipts(challenge_id,resource_id) VALUES(p_challenge,performed.resource_id);
 END IF;
 RETURN QUERY SELECT performed.result::text,performed.resource_id::uuid;
END;
$$;
CREATE FUNCTION public.staffly_service_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE org uuid; state text; until_at timestamptz; deleted timestamptz;
BEGIN
 org:=(to_jsonb(NEW)->>'organization_id')::uuid;
 IF org IS NULL THEN RETURN NEW;END IF;
 -- Shared through commit; a suspension waits for in-flight tenant writes.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(org::text,681947262));
 SELECT service_state,service_until,deleted_at INTO state,until_at,deleted FROM public.organizations WHERE id=org;
 IF deleted IS NULL AND state='SUSPENDED' AND (until_at IS NULL OR until_at>clock_timestamp()) THEN
  -- Purging an archived file may only refresh the document's live hint.
  IF TG_TABLE_NAME='documents' AND TG_OP='UPDATE' AND (to_jsonb(NEW)-'updated_at')=(to_jsonb(OLD)-'updated_at') THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'ORGANIZATION_SUSPENDED' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text;BEGIN
 FOR tab IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY(ARRAY['organization_members','organization_locations','access_roles','access_assignments','work_shifts','requests','employee_absences','work_shift_adjustments','request_types','organization_invites','sensitive_action_tokens','shift_templates','document_folders','documents','document_acknowledgements','organization_events','event_locations','event_recipients','event_changes','shift_offers','report_templates','schedule_drafts','draft_shifts','draft_recipients','draft_comments','draft_history','vacation_campaigns','demand_versions','demand_exceptions','location_members','location_teams','location_team_members','location_transfers','report_exports']) LOOP
  EXECUTE format('CREATE TRIGGER service_write_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.staffly_service_write_guard()',tab);
 END LOOP;
END $$;
-- Operator/CLI holds also invalidate a stale web preview.
CREATE FUNCTION staffly_admin.track_cleanup_hold() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.hold IS DISTINCT FROM OLD.hold THEN
  INSERT INTO staffly_admin.cleanup_controls(job_id,owner_id,reason,updated_by)
   VALUES(NEW.id,'00000000-0000-0000-0000-000000000000','Изменено оператором','00000000-0000-0000-0000-000000000000')
   ON CONFLICT(job_id) DO UPDATE SET version=staffly_admin.cleanup_controls.version+1,updated_at=now();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cleanup_hold_version AFTER UPDATE OF hold ON public.data_deletions FOR EACH ROW EXECUTE FUNCTION staffly_admin.track_cleanup_hold();
