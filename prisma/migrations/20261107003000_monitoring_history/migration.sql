CREATE TABLE public.platform_operation_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, user_id uuid,
 resource_id uuid, module varchar(24) NOT NULL, action varchar(16) NOT NULL CHECK(action IN ('CREATE','UPDATE','DELETE')),
 created_at timestamptz(3) NOT NULL DEFAULT now(), expires_at timestamptz(3) NOT NULL DEFAULT now()+interval '180 days'
);
CREATE INDEX platform_operations_org_idx ON public.platform_operation_events(organization_id,created_at,id);
CREATE INDEX platform_operations_user_idx ON public.platform_operation_events(user_id,created_at,id);
CREATE INDEX platform_operations_expiry_idx ON public.platform_operation_events(expires_at);
CREATE TABLE public.platform_lifetime_metrics (
 id integer PRIMARY KEY CHECK(id=1), users_created bigint NOT NULL, organizations_created bigint NOT NULL,
 shifts_created bigint NOT NULL, requests_created bigint NOT NULL, documents_created bigint NOT NULL, events_created bigint NOT NULL
);
INSERT INTO public.platform_lifetime_metrics SELECT 1,(SELECT count(*) FROM public.users),(SELECT count(*) FROM public.organizations),
 (SELECT count(*) FROM public.work_shifts),(SELECT count(*) FROM public.requests),(SELECT count(*) FROM public.documents),(SELECT count(*) FROM public.organization_events);
-- Append independent anonymous deltas instead of locking one global counter
-- for every tenant's business transaction.
CREATE TABLE public.platform_creation_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),metric varchar(16) NOT NULL);
CREATE INDEX platform_creation_metric_idx ON public.platform_creation_events(metric);
CREATE FUNCTION public.platform_count_creation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO public.platform_creation_events(metric) VALUES(CASE TG_TABLE_NAME WHEN 'users' THEN 'users' WHEN 'organizations' THEN 'organizations' WHEN 'work_shifts' THEN 'shifts' WHEN 'requests' THEN 'requests' WHEN 'documents' THEN 'documents' WHEN 'organization_events' THEN 'events' END);
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.platform_count_creation() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['users','organizations','work_shifts','requests','documents','organization_events'] LOOP
 EXECUTE format('CREATE TRIGGER platform_creation_count AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.platform_count_creation()',t);
 END LOOP;
END; $$;
CREATE FUNCTION public.platform_record_operation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row_data jsonb; org uuid; actor uuid; resource uuid;
BEGIN
 IF TG_OP='DELETE' THEN row_data=to_jsonb(OLD); ELSE row_data=to_jsonb(NEW); END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RETURN NEW; END IF;
 org=CASE WHEN TG_TABLE_NAME='organizations' THEN (row_data->>'id')::uuid ELSE (row_data->>'organization_id')::uuid END;
 IF org IS NULL AND TG_TABLE_NAME='request_events' THEN SELECT organization_id INTO org FROM public.requests WHERE id=(row_data->>'request_id')::uuid; END IF;
 IF org IS NULL AND TG_TABLE_NAME='event_changes' THEN SELECT organization_id INTO org FROM public.organization_events WHERE id=(row_data->>'event_id')::uuid; END IF;
 IF org IS NULL AND TG_TABLE_NAME='work_shift_adjustments' THEN SELECT organization_id INTO org FROM public.work_shifts WHERE id=(row_data->>'shift_id')::uuid; END IF;
 IF org IS NULL THEN RETURN NULL; END IF;
 resource=(row_data->>'id')::uuid;
 -- Current executor is unknown for direct SQL/background changes. Do not infer
 -- it from a stale "last updated by" field or record a document's contents.
 INSERT INTO public.platform_operation_events(organization_id,user_id,resource_id,module,action) VALUES(org,actor,resource,TG_ARGV[0],CASE WHEN TG_OP='INSERT' THEN 'CREATE' ELSE TG_OP END);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.platform_record_operation() FROM PUBLIC;
DO $$ DECLARE spec text[]; BEGIN
 FOREACH spec SLICE 1 IN ARRAY ARRAY[
 ['organizations','organization'],['organization_members','members'],['organization_locations','locations'],['organization_invites','invitations'],
 ['work_shifts','schedule'],['work_shift_adjustments','schedule'],['requests','requests'],['request_events','requests'],
 ['documents','documents'],['document_folders','documents'],['organization_events','events'],['event_changes','events'],
 ['access_roles','access'],['access_assignments','access'],['access_audit','access'],['organization_subscriptions','subscription'],['subscription_purchases','subscription'],
 ['report_templates','reports'],['report_exports','reports'],['stored_files','documents'],['request_types','requests'],['employee_absences','requests'],['vacation_campaigns','requests'],
 ['organization_positions','members'],['shift_templates','schedule'],['location_members','members'],['location_teams','members'],['location_team_members','members'],['location_transfers','members'],
 ['event_locations','events'],['event_recipients','events'],['shift_offer_reservations','schedule'],['shift_offers','schedule'],
 ['demand_versions','planning'],['demand_exceptions','planning'],['schedule_drafts','planning'],['draft_recipients','planning'],['draft_comments','planning'],['draft_history','planning']
 ] LOOP
 EXECUTE format('CREATE TRIGGER platform_operation_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.platform_record_operation(%L)',spec[1],spec[2]);
 END LOOP;
END; $$;
CREATE FUNCTION public.platform_cleanup_operations() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DELETE FROM public.platform_operation_events WHERE id IN (SELECT id FROM public.platform_operation_events WHERE expires_at<now() LIMIT 5000);
$$;
REVOKE ALL ON FUNCTION public.platform_cleanup_operations() FROM PUBLIC;
