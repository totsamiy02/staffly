-- Schema owner runs this after migrations. Gateway cannot appoint/revoke admins.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
    GRANT USAGE ON SCHEMA staffly_admin TO staffly_admin_gateway;
    GRANT SELECT ON staffly_admin.accounts TO staffly_admin_gateway;
    GRANT SELECT,INSERT,UPDATE,DELETE ON staffly_admin.credentials,staffly_admin.sessions,staffly_admin.challenges TO staffly_admin_gateway;
    GRANT SELECT,INSERT ON staffly_admin.audit_events TO staffly_admin_gateway;
    GRANT EXECUTE ON FUNCTION staffly_admin.cleanup_expired() TO staffly_admin_gateway;
    GRANT EXECUTE ON FUNCTION staffly_admin.lock_account(uuid) TO staffly_admin_gateway;
  END IF;
END $$;
