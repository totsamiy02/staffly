-- Schema owner runs this after migrations. No direct grant mutation is allowed;
-- confirmed actions use a bounded SECURITY DEFINER function.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
    GRANT USAGE ON SCHEMA staffly_admin TO staffly_admin_gateway;
    GRANT SELECT ON staffly_admin.accounts TO staffly_admin_gateway;
    GRANT SELECT,INSERT,UPDATE,DELETE ON staffly_admin.credentials,staffly_admin.sessions,staffly_admin.challenges TO staffly_admin_gateway;
    GRANT SELECT,INSERT ON staffly_admin.audit_events TO staffly_admin_gateway;
    GRANT EXECUTE ON FUNCTION staffly_admin.cleanup_expired() TO staffly_admin_gateway;
    GRANT EXECUTE ON FUNCTION staffly_admin.lock_account(uuid) TO staffly_admin_gateway;
    GRANT EXECUTE ON FUNCTION staffly_admin.retry_report(uuid,uuid,uuid,text,uuid) TO staffly_admin_gateway;
    GRANT SELECT ON staffly_admin.administrator_directory,staffly_admin.session_directory,staffly_admin.audit_directory TO staffly_admin_gateway;
    GRANT SELECT ON staffly_admin.management_state,staffly_admin.backups,staffly_admin.backup_jobs,staffly_admin.alerts,staffly_admin.alert_rules TO staffly_admin_gateway;
    GRANT SELECT,INSERT,UPDATE ON staffly_admin.action_challenges TO staffly_admin_gateway;
    GRANT EXECUTE ON FUNCTION staffly_admin.execute_management_action(uuid,uuid,uuid,text,uuid,text,text) TO staffly_admin_gateway;
    REVOKE ALL ON FUNCTION staffly_admin.execute_management_action_once(uuid,uuid,uuid,text,uuid,text,text) FROM staffly_admin_gateway;
    GRANT SELECT ON staffly_admin.action_receipts TO staffly_admin_gateway;
    GRANT SELECT ON staffly_admin.work_directory,staffly_admin.work_history_directory TO staffly_admin_gateway;
    GRANT EXECUTE ON FUNCTION staffly_admin.assign_work(uuid,uuid,uuid,text,text,uuid,uuid,integer) TO staffly_admin_gateway;
    GRANT EXECUTE ON FUNCTION staffly_admin.simple_management_action(uuid,uuid,uuid,text,text,uuid,text) TO staffly_admin_gateway;
  END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  REVOKE ALL ON FUNCTION staffly_admin.execute_management_action_legacy(uuid,uuid,uuid,text,uuid,text,text) FROM staffly_admin_gateway;
  GRANT SELECT ON staffly_admin.service_history,staffly_admin.service_jobs,staffly_admin.cleanup_directory,staffly_admin.queue_history,
   staffly_admin.queue_batches,staffly_admin.backup_schedule,staffly_admin.backup_components,staffly_admin.restore_checks,
   staffly_admin.content_items,staffly_admin.content_revisions,staffly_admin.content_reviews,staffly_admin.content_publications,
   staffly_admin.maintenance_windows,staffly_admin.delivery_settings,staffly_admin.external_probe,staffly_admin.signal_deliveries,
   staffly_admin.user_service_sessions,staffly_admin.release_schema_state,staffly_admin.release_checks TO staffly_admin_gateway;
  GRANT EXECUTE ON FUNCTION staffly_admin.save_service_content(uuid,uuid,uuid,text,jsonb),staffly_admin.review_service_content(uuid,uuid,uuid,text,uuid),staffly_admin.record_runtime_checks(uuid,uuid,uuid,text,uuid,jsonb,text,text) TO staffly_admin_gateway;
 END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT SELECT ON staffly_admin.file_cleanup_directory,staffly_admin.service_runner_state TO staffly_admin_gateway;
 END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  GRANT EXECUTE ON FUNCTION staffly_admin.confirm_signal(uuid,uuid,uuid,text,uuid,text) TO staffly_admin_gateway;
 END IF;
END $$;
