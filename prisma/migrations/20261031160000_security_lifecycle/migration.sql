CREATE TABLE security_events (
  id UUID PRIMARY KEY,
  user_id UUID, organization_id UUID, session_id UUID,
  correlation_id UUID NOT NULL,
  action VARCHAR(64) NOT NULL,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('SUCCEEDED','DENIED','FAILED')),
  resource_type VARCHAR(24), resource_id UUID, reason_code VARCHAR(64), count INTEGER,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP + interval '180 days',
  CHECK (expires_at >= created_at + interval '180 days')
);
CREATE INDEX security_events_user_id_organization_id_created_at_id_idx ON security_events(user_id,organization_id,created_at,id);
CREATE INDEX security_events_organization_id_created_at_id_idx ON security_events(organization_id,created_at,id);
CREATE INDEX security_events_correlation_id_idx ON security_events(correlation_id);
CREATE INDEX security_events_expires_at_idx ON security_events(expires_at);
CREATE TABLE data_deletions (
  id UUID PRIMARY KEY, kind VARCHAR(16) NOT NULL CHECK (kind IN ('ACCOUNT','ORGANIZATION')),
  subject_id UUID NOT NULL, requested_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at TIMESTAMPTZ(3) NOT NULL, completed_at TIMESTAMPTZ(3),
  hold BOOLEAN NOT NULL DEFAULT false, attempts INTEGER NOT NULL DEFAULT 0, last_error_code VARCHAR(64),
  UNIQUE(kind,subject_id), CHECK(due_at >= requested_at + interval '30 days')
);
CREATE INDEX data_deletions_completed_at_due_at_idx ON data_deletions(completed_at,due_at);
CREATE TABLE account_deletion_challenges (
  id UUID PRIMARY KEY, user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL, security_version INTEGER NOT NULL,
  code_hash VARCHAR(64) NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX account_deletion_challenges_expires_at_idx ON account_deletion_challenges(expires_at);
CREATE FUNCTION purge_expired_security_events() RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE removed INTEGER;
BEGIN
  DELETE FROM public.security_events WHERE id IN (
    SELECT id FROM public.security_events WHERE expires_at < CURRENT_TIMESTAMP
    ORDER BY expires_at,id LIMIT 5000 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION purge_expired_security_events() FROM PUBLIC;
