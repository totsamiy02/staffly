CREATE TABLE staffly_admin.work_assignments (
 subject_kind varchar(12) NOT NULL CHECK(subject_kind IN ('alert','diagnostic')),
 subject_id uuid NOT NULL, assignee_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz(3) NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 PRIMARY KEY(subject_kind,subject_id)
);
CREATE TABLE staffly_admin.work_assignment_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_kind varchar(12) NOT NULL,
 subject_id uuid NOT NULL, from_assignee uuid, to_assignee uuid, actor_id uuid NOT NULL,
 version integer NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX admin_work_history_subject_idx ON staffly_admin.work_assignment_history(subject_kind,subject_id,created_at DESC,id);
CREATE VIEW staffly_admin.work_directory AS
 SELECT w.*,a.public_id AS assignee_public_id,a.display_name AS assignee_name,
 COALESCE(a.enabled AND NOT a.deleted AND a.email_verified AND a.password_set,false) AS assignee_available
 FROM staffly_admin.work_assignments w LEFT JOIN staffly_admin.administrator_directory a ON a.user_id=w.assignee_id;
CREATE VIEW staffly_admin.work_history_directory AS
 SELECT h.*,a.public_id AS actor_public_id,a.display_name AS actor_name,
 f.public_id AS from_public_id,f.display_name AS from_name,t.public_id AS to_public_id,t.display_name AS to_name
 FROM staffly_admin.work_assignment_history h
 LEFT JOIN staffly_admin.administrator_directory a ON a.user_id=h.actor_id
 LEFT JOIN staffly_admin.administrator_directory f ON f.user_id=h.from_assignee
 LEFT JOIN staffly_admin.administrator_directory t ON t.user_id=h.to_assignee;
-- Runtime sees only which diagnostic codes have an available assignee. DISTINCT
-- also makes this view non-updatable; no private account or name is exposed.
CREATE VIEW public.platform_assigned_diagnostics AS
 SELECT DISTINCT subject_id FROM staffly_admin.work_directory
 WHERE subject_kind='diagnostic' AND assignee_id IS NOT NULL AND assignee_available;
CREATE FUNCTION staffly_admin.assign_work(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_kind text,p_subject uuid,p_assignee uuid,p_version integer)
RETURNS TABLE(result text,new_version integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE valid text; existing staffly_admin.work_assignments; next_version integer;
BEGIN
 valid:=staffly_admin.management_actor(p_user,p_auth,p_session,p_hash);
 IF valid<>'OK' THEN RETURN QUERY SELECT valid,0; RETURN; END IF;
 IF p_kind NOT IN ('alert','diagnostic') OR p_version<0 THEN RETURN QUERY SELECT 'INVALID',0; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_kind||':'||p_subject::text,681947258));
 IF p_kind='alert' THEN
  PERFORM 1 FROM staffly_admin.alerts WHERE id=p_subject AND resolved_at IS NULL FOR UPDATE;
 ELSE
  PERFORM 1 FROM public.platform_request_errors WHERE id=p_subject AND created_at>now()-interval '30 days' FOR SHARE;
 END IF;
 IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND',0; RETURN; END IF;
 IF p_assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM staffly_admin.accounts a JOIN public.users u ON u.id=a.user_id
  WHERE a.user_id=p_assignee AND a.enabled AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND u.password_hash IS NOT NULL) THEN
  RETURN QUERY SELECT 'ASSIGNEE',0; RETURN;
 END IF;
 SELECT * INTO existing FROM staffly_admin.work_assignments WHERE subject_kind=p_kind AND subject_id=p_subject FOR UPDATE;
 IF COALESCE(existing.version,0)<>p_version THEN RETURN QUERY SELECT 'CHANGED',COALESCE(existing.version,0); RETURN; END IF;
 IF existing.version IS NOT NULL AND existing.assignee_id IS NOT DISTINCT FROM p_assignee THEN RETURN QUERY SELECT 'OK',existing.version; RETURN; END IF;
 next_version:=COALESCE(existing.version,0)+1;
 INSERT INTO staffly_admin.work_assignments(subject_kind,subject_id,assignee_id,version,updated_by)
 VALUES(p_kind,p_subject,p_assignee,next_version,p_user)
 ON CONFLICT(subject_kind,subject_id) DO UPDATE SET assignee_id=EXCLUDED.assignee_id,version=EXCLUDED.version,updated_at=now(),updated_by=p_user;
 INSERT INTO staffly_admin.work_assignment_history(subject_kind,subject_id,from_assignee,to_assignee,actor_id,version)
 VALUES(p_kind,p_subject,existing.assignee_id,p_assignee,p_user,next_version);
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id)
 VALUES(gen_random_uuid(),p_user,p_session,'WORK_ASSIGNED','SUCCEEDED',upper(p_kind),p_subject);
 RETURN QUERY SELECT 'OK',next_version;
END $$;
REVOKE ALL ON FUNCTION staffly_admin.assign_work(uuid,uuid,uuid,text,text,uuid,uuid,integer) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.platform_cleanup_diagnostics() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 DELETE FROM public.platform_request_errors WHERE id IN (SELECT id FROM public.platform_request_errors WHERE created_at<now()-interval '30 days' ORDER BY created_at LIMIT 5000);
 DELETE FROM public.platform_runtime_nodes WHERE id IN (SELECT id FROM public.platform_runtime_nodes WHERE heartbeat_at<now()-interval '7 days' ORDER BY heartbeat_at LIMIT 1000);
 DELETE FROM staffly_admin.work_assignment_history WHERE id IN(SELECT id FROM staffly_admin.work_assignment_history WHERE created_at<now()-interval '180 days' LIMIT 1000);
 DELETE FROM staffly_admin.work_assignments WHERE (subject_kind,subject_id) IN(
  SELECT subject_kind,subject_id FROM staffly_admin.work_assignments w WHERE updated_at<now()-interval '30 days' AND
   (subject_kind='diagnostic' AND NOT EXISTS(SELECT 1 FROM public.platform_request_errors e WHERE e.id=w.subject_id)
    OR subject_kind='alert' AND NOT EXISTS(SELECT 1 FROM staffly_admin.alerts a WHERE a.id=w.subject_id)) LIMIT 1000);
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  GRANT SELECT ON public.platform_assigned_diagnostics TO staffly_app;
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.platform_assigned_diagnostics FROM staffly_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT SELECT ON staffly_admin.work_directory,staffly_admin.work_history_directory TO staffly_admin_gateway;
  GRANT EXECUTE ON FUNCTION staffly_admin.assign_work(uuid,uuid,uuid,text,text,uuid,uuid,integer) TO staffly_admin_gateway;
 END IF;
END $$;
