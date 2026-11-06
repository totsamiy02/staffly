-- Administrative grants/credentials never inherit public runtime grants.
CREATE SCHEMA staffly_admin;
REVOKE ALL ON SCHEMA staffly_admin FROM PUBLIC;
CREATE TABLE staffly_admin.accounts (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  granted_at timestamptz(3) NOT NULL DEFAULT now(),
  revoked_at timestamptz(3)
);
CREATE TABLE staffly_admin.credentials (
  user_id uuid PRIMARY KEY REFERENCES staffly_admin.accounts(user_id) ON DELETE CASCADE,
  pin_hash text NOT NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TABLE staffly_admin.sessions (
  id uuid PRIMARY KEY,
  token_hash varchar(64) NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES staffly_admin.accounts(user_id) ON DELETE CASCADE,
  auth_session_id uuid NOT NULL REFERENCES public.auth_sessions(id) ON DELETE CASCADE,
  grant_version integer NOT NULL,
  user_version integer NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL,
  activity_at timestamptz(3) NOT NULL DEFAULT now(),
  locked_at timestamptz(3),
  revoked_at timestamptz(3),
  setup_allowed boolean NOT NULL DEFAULT false,
  pin_attempts integer NOT NULL DEFAULT 0 CHECK (pin_attempts BETWEEN 0 AND 5),
  CHECK (expires_at <= created_at + interval '4 hours')
);
CREATE INDEX admin_sessions_user_idx ON staffly_admin.sessions(user_id, revoked_at);
CREATE INDEX admin_sessions_expiry_idx ON staffly_admin.sessions(expires_at);
CREATE TABLE staffly_admin.challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES staffly_admin.accounts(user_id) ON DELETE CASCADE,
  auth_session_id uuid NOT NULL REFERENCES public.auth_sessions(id) ON DELETE CASCADE,
  grant_version integer NOT NULL,
  user_version integer NOT NULL,
  purpose varchar(16) NOT NULL CHECK (purpose IN ('LOGIN','RESET_PIN')),
  code_hash varchar(64) NOT NULL,
  browser_hash varchar(64) NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL,
  sent_at timestamptz(3),
  used_at timestamptz(3)
);
CREATE INDEX admin_challenges_user_idx ON staffly_admin.challenges(user_id, created_at);
CREATE INDEX admin_challenges_expiry_idx ON staffly_admin.challenges(expires_at);
CREATE TABLE staffly_admin.audit_events (
  id uuid PRIMARY KEY,
  user_id uuid,
  session_id uuid,
  action varchar(48) NOT NULL,
  outcome varchar(16) NOT NULL CHECK (outcome IN ('SUCCEEDED','DENIED','FAILED')),
  resource varchar(32),
  resource_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL DEFAULT now() + interval '180 days',
  CHECK (expires_at >= created_at + interval '180 days')
);
CREATE INDEX admin_audit_user_idx ON staffly_admin.audit_events(user_id, created_at, id);
CREATE INDEX admin_audit_expiry_idx ON staffly_admin.audit_events(expires_at);
CREATE TABLE public.platform_monitoring_state (id integer PRIMARY KEY CHECK (id=1), started_at timestamptz(3) NOT NULL DEFAULT now());
INSERT INTO public.platform_monitoring_state(id) VALUES (1);
CREATE TABLE public.platform_organization_presence (
  session_id uuid NOT NULL REFERENCES public.auth_sessions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  last_active_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, organization_id)
);
CREATE INDEX platform_presence_active_idx ON public.platform_organization_presence(last_active_at, organization_id);
CREATE TABLE public.platform_organization_activity (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_active_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TABLE public.platform_activity_days (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  day date NOT NULL,
  PRIMARY KEY (organization_id, day, user_id)
);
CREATE INDEX platform_activity_day_idx ON public.platform_activity_days(day, organization_id);
CREATE TABLE public.platform_feature_days (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  feature varchar(16) NOT NULL CHECK (feature IN ('schedule','requests','documents','reports','planning')),
  PRIMARY KEY (organization_id, day, feature)
);
CREATE TABLE public.platform_online_samples (
  bucket timestamptz(3) PRIMARY KEY,
  users_count integer NOT NULL,
  organizations_count integer NOT NULL,
  sessions_count integer NOT NULL
);

-- Fixed retention only. Application cannot rewrite or truncate admin audit.
CREATE FUNCTION staffly_admin.cleanup_expired() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  DELETE FROM staffly_admin.challenges WHERE expires_at < now() - interval '1 day';
  DELETE FROM staffly_admin.sessions WHERE expires_at < now() - interval '1 day';
  DELETE FROM staffly_admin.audit_events WHERE id IN (SELECT id FROM staffly_admin.audit_events WHERE expires_at < now() LIMIT 5000);
END;
$$;
REVOKE ALL ON FUNCTION staffly_admin.cleanup_expired() FROM PUBLIC;

-- Row locking normally needs UPDATE permission. Expose only this fixed locking
-- operation so the gateway never receives permission to modify admin grants.
CREATE FUNCTION staffly_admin.lock_account(p_user_id uuid) RETURNS TABLE(user_id uuid,enabled boolean,version integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT a.user_id,a.enabled,a.version FROM staffly_admin.accounts a WHERE a.user_id=p_user_id FOR UPDATE;
$$;
REVOKE ALL ON FUNCTION staffly_admin.lock_account(uuid) FROM PUBLIC;

-- Invalidation also covers password reset, email change and the session kept by
-- a password change; application routes cannot forget to revoke elevation.
CREATE FUNCTION staffly_admin.invalidate_account_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.security_version IS DISTINCT FROM NEW.security_version OR OLD.email IS DISTINCT FROM NEW.email OR OLD.password_hash IS DISTINCT FROM NEW.password_hash OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
    UPDATE staffly_admin.sessions SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
    UPDATE staffly_admin.challenges SET used_at=now() WHERE user_id=NEW.id AND used_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION staffly_admin.invalidate_account_access() FROM PUBLIC;
CREATE TRIGGER platform_admin_security_changed AFTER UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION staffly_admin.invalidate_account_access();
