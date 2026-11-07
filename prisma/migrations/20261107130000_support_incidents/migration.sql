ALTER TABLE public.platform_request_errors DROP CONSTRAINT platform_request_errors_status_check;
ALTER TABLE public.platform_request_errors
 ADD CONSTRAINT platform_request_errors_status_check CHECK(status=0 OR status BETWEEN 400 AND 599),
 ADD COLUMN source varchar(12) NOT NULL DEFAULT 'request' CHECK(source IN ('request','client','email','report','worker')),
 ADD COLUMN event_code varchar(80),
 ADD COLUMN job_id uuid,
 ADD COLUMN attempt integer CHECK(attempt BETWEEN 0 AND 100),
 ADD COLUMN max_attempts integer CHECK(max_attempts BETWEEN 1 AND 100),
 ADD COLUMN next_attempt_at timestamptz(3),
 ADD COLUMN task_name varchar(80);
CREATE INDEX platform_request_errors_job_id_created_at_idx ON public.platform_request_errors(job_id,created_at);

ALTER TABLE public.email_deliveries
 ADD COLUMN last_error_code varchar(40), ADD COLUMN last_error_at timestamptz(3);

-- Queue diagnostics survive expiry/deletion of the original short-lived export.
-- Fixed fields only; payload, mail addresses and report input never enter this log.
CREATE FUNCTION public.platform_capture_job_failure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_source text; v_code text; v_attempt integer; v_max integer; v_next timestamptz; v_emit boolean:=false;
BEGIN
 IF TG_TABLE_NAME='email_deliveries' THEN
  v_source:='email';v_max:=7;v_attempt:=NEW.attempts;v_next:=CASE WHEN NEW.status='PENDING' THEN NEW.available_at ELSE NULL END;
  v_code:=COALESCE(NEW.last_error_code,'EMAIL_DELIVERY_FAILED');
  IF TG_OP='INSERT' THEN v_emit:=NEW.status='FAILED';
  ELSE v_emit:=NEW.last_error_at IS DISTINCT FROM OLD.last_error_at AND NEW.last_error_at IS NOT NULL OR NEW.status='FAILED' AND OLD.status<>'FAILED';END IF;
 ELSE
  v_source:='report';v_max:=3;v_attempt:=NEW.attempts;v_code:=COALESCE(NEW.error_code,'EXPORT_FAILED');
  IF TG_OP='INSERT' THEN v_emit:=NEW.status='FAILED';
  ELSE v_emit:=NEW.status='FAILED' AND (OLD.status<>'FAILED' OR NEW.error_code IS DISTINCT FROM OLD.error_code);END IF;
 END IF;
 IF v_emit THEN
  INSERT INTO public.platform_request_errors(id,node_id,method,route,status,name,code,event_code,source,job_id,attempt,max_attempts,next_attempt_at,user_id,organization_id)
  VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000000','OTHER',CASE WHEN v_source='email' THEN '/workers/email' ELSE '/workers/reports' END,0,'Error',
   CASE WHEN v_code IN ('EAUTH','ECONNECTION','ESOCKET','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','57014','53300') THEN v_code END,
   CASE WHEN v_source='email' THEN 'EMAIL_DELIVERY_FAILED' WHEN v_code IN ('EXPORT_FAILED','EXPORT_INTERRUPTED','EXPORT_EXPIRED','ORGANIZATION_STORAGE_QUOTA') THEN v_code ELSE 'EXPORT_FAILED' END,
   v_source,NEW.id,v_attempt,v_max,v_next,NEW.user_id,NEW.organization_id);
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.platform_capture_job_failure() FROM PUBLIC;
CREATE TRIGGER platform_email_failure AFTER INSERT OR UPDATE ON public.email_deliveries FOR EACH ROW EXECUTE FUNCTION public.platform_capture_job_failure();
CREATE TRIGGER platform_report_failure AFTER INSERT OR UPDATE ON public.report_exports FOR EACH ROW EXECUTE FUNCTION public.platform_capture_job_failure();
