CREATE TABLE public.platform_runtime_nodes (
 id uuid PRIMARY KEY, role varchar(12) NOT NULL CHECK(role IN ('api','worker')),
 started_at timestamptz(3) NOT NULL, heartbeat_at timestamptz(3) NOT NULL,
 stopped_at timestamptz(3), ready boolean NOT NULL DEFAULT false,
 snapshot jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(snapshot)='object')
);
CREATE INDEX platform_runtime_nodes_heartbeat_at_idx ON public.platform_runtime_nodes(heartbeat_at);
CREATE TABLE public.platform_request_errors (
 id uuid PRIMARY KEY, node_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(),
 method varchar(8) NOT NULL CHECK(method IN ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','OTHER')),
 route varchar(200) NOT NULL, status integer NOT NULL CHECK(status BETWEEN 500 AND 599),
 name varchar(64) NOT NULL, code varchar(40), user_id uuid, organization_id uuid
);
CREATE INDEX platform_request_errors_created_at_idx ON public.platform_request_errors(created_at);
CREATE INDEX platform_request_errors_organization_id_created_at_idx ON public.platform_request_errors(organization_id,created_at);
CREATE INDEX platform_request_errors_user_id_created_at_idx ON public.platform_request_errors(user_id,created_at);

-- Diagnostic events are append-only to runtime. Only fixed retention can erase them.
CREATE FUNCTION public.platform_cleanup_diagnostics() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 DELETE FROM public.platform_request_errors WHERE id IN (SELECT id FROM public.platform_request_errors WHERE created_at<now()-interval '30 days' ORDER BY created_at LIMIT 5000);
 DELETE FROM public.platform_runtime_nodes WHERE id IN (SELECT id FROM public.platform_runtime_nodes WHERE heartbeat_at<now()-interval '7 days' ORDER BY heartbeat_at LIMIT 1000);
END;
$$;
REVOKE ALL ON FUNCTION public.platform_cleanup_diagnostics() FROM PUBLIC;

-- One bounded retry, without resetting attempts or expiry. The private session,
-- ordinary session, quota admission, state change and audit share a transaction.
CREATE FUNCTION staffly_admin.retry_report(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_job uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u public.users; a public.auth_sessions; g staffly_admin.accounts; s staffly_admin.sessions; j public.report_exports; b public.organization_resource_budgets;
BEGIN
 SELECT * INTO u FROM public.users WHERE id=p_user FOR SHARE;
 IF NOT FOUND OR u.deleted_at IS NOT NULL OR u.email_verified_at IS NULL THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO a FROM public.auth_sessions WHERE id=p_auth AND user_id=p_user FOR SHARE;
 IF NOT FOUND OR a.revoked_at IS NOT NULL OR a.idle_expires_at<=now() OR a.absolute_expires_at<=now() THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO g FROM staffly_admin.accounts WHERE user_id=p_user FOR UPDATE;
 IF NOT FOUND OR NOT g.enabled THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO s FROM staffly_admin.sessions WHERE id=p_session AND user_id=p_user AND auth_session_id=p_auth AND token_hash=p_hash FOR UPDATE;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=now() OR s.grant_version<>g.version OR s.user_version<>u.security_version OR s.setup_allowed AND s.created_at<=now()-interval '10 minutes' THEN RETURN 'FORBIDDEN'; END IF;
 IF s.locked_at IS NOT NULL OR s.activity_at<=now()-interval '5 minutes' OR NOT EXISTS(SELECT 1 FROM staffly_admin.credentials WHERE user_id=p_user) THEN RETURN 'LOCKED'; END IF;
 PERFORM pg_advisory_xact_lock(781234567::bigint);
 SELECT * INTO j FROM public.report_exports WHERE id=p_job FOR UPDATE;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 IF j.status<>'FAILED' OR j.attempts>=3 OR j.expires_at<=now() OR COALESCE(j.error_code,'') NOT IN ('EXPORT_FAILED','EXPORT_INTERRUPTED','ORGANIZATION_STORAGE_QUOTA') THEN RETURN 'CONFLICT'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.user_id::text,7));
 IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=j.organization_id AND deleted_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.organization_members m JOIN public.users owner ON owner.id=m.user_id WHERE m.user_id=j.user_id AND m.organization_id=j.organization_id AND m.left_at IS NULL AND owner.deleted_at IS NULL) THEN RETURN 'CONFLICT'; END IF;
 SELECT * INTO b FROM public.organization_resource_budgets WHERE organization_id=j.organization_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 'CONFLICT'; END IF;
 IF (SELECT count(*) FROM public.report_exports WHERE user_id=j.user_id AND status IN ('PENDING','RUNNING') AND expires_at>now())>=2
 OR (SELECT count(*) FROM public.report_exports WHERE status IN ('PENDING','RUNNING') AND expires_at>now())>=200
 OR (SELECT count(*) FROM public.report_exports WHERE organization_id=j.organization_id AND status IN ('PENDING','RUNNING') AND expires_at>now())>=b.export_queue_limit
 OR b.export_window_start>now()-interval '1 hour' AND b.export_window_count>=b.export_hour_limit THEN RETURN 'LIMIT'; END IF;
 UPDATE public.organization_resource_budgets SET export_window_count=CASE WHEN export_window_start<=now()-interval '1 hour' THEN 1 ELSE export_window_count+1 END,
 export_window_start=CASE WHEN export_window_start<=now()-interval '1 hour' THEN now() ELSE export_window_start END WHERE organization_id=j.organization_id;
 UPDATE public.report_exports SET status='PENDING',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=j.id;
 INSERT INTO staffly_admin.audit_events(id,user_id,session_id,action,outcome,resource,resource_id) VALUES(gen_random_uuid(),p_user,p_session,'EXPORT_RETRY','SUCCEEDED','REPORT_EXPORT',p_job);
 RETURN 'OK';
END;
$$;
REVOKE ALL ON FUNCTION staffly_admin.retry_report(uuid,uuid,uuid,text,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON public.platform_runtime_nodes TO staffly_app;
  GRANT SELECT,INSERT ON public.platform_request_errors TO staffly_app;
  REVOKE UPDATE,DELETE,TRUNCATE ON public.platform_request_errors FROM staffly_app;
  GRANT EXECUTE ON FUNCTION public.platform_cleanup_diagnostics() TO staffly_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT EXECUTE ON FUNCTION staffly_admin.retry_report(uuid,uuid,uuid,text,uuid) TO staffly_admin_gateway;
 END IF;
END $$;
