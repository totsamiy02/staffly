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
    GRANT EXECUTE ON FUNCTION staffly_admin.simple_management_action(uuid,uuid,uuid,text,text,uuid,text) TO staffly_admin_gateway;
  END IF;
END $$;
