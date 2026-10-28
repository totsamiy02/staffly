CREATE TABLE api_rate_limits (
  key varchar(64) PRIMARY KEY,
  hits integer NOT NULL,
  reset_at timestamptz(3) NOT NULL
);
CREATE INDEX api_rate_limits_reset_at_idx ON api_rate_limits(reset_at);

-- Payloads contain scope identifiers only. PostgreSQL delivers them only on commit,
-- and coalesces identical payloads within a transaction.
CREATE FUNCTION staffly_live_hint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; org text; recipient text;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD); ELSE row_data := to_jsonb(NEW); END IF;
  org := row_data ->> 'organization_id';
  IF TG_TABLE_NAME IN ('account_notifications','auth_identities') THEN recipient := row_data ->> 'user_id'; END IF;
  IF TG_TABLE_NAME = 'organization_invites' THEN
    SELECT id::text INTO recipient FROM users WHERE email = row_data ->> 'invited_email';
    IF recipient IS NOT NULL THEN PERFORM pg_notify('staffly_live',jsonb_build_object('topic','notifications','userId',recipient)::text); END IF;
    recipient := NULL;
  END IF;
  IF org IS NULL AND TG_TABLE_NAME = 'document_folder_pins' THEN
    SELECT organization_id::text INTO org FROM document_folders WHERE id = (row_data ->> 'folder_id')::uuid;
  END IF;
  IF org IS NULL AND TG_TABLE_NAME = 'member_positions' THEN
    SELECT organization_id::text INTO org FROM organization_members WHERE id = (row_data ->> 'member_id')::uuid;
  END IF;
  IF org IS NULL AND TG_TABLE_NAME = 'document_acknowledgements' THEN
    SELECT organization_id::text INTO org FROM documents WHERE id = (row_data ->> 'document_id')::uuid;
  END IF;
  IF org IS NULL AND TG_TABLE_NAME IN ('demand_versions', 'demand_exceptions') THEN
    SELECT organization_id::text INTO org FROM organization_locations WHERE id = (row_data ->> 'location_id')::uuid;
  END IF;
  IF org IS NULL AND TG_TABLE_NAME IN ('draft_shifts','draft_recipients','draft_comments') THEN
    SELECT organization_id::text INTO org FROM schedule_drafts WHERE id = (row_data ->> 'draft_id')::uuid;
  END IF;
  IF org IS NOT NULL OR recipient IS NOT NULL THEN
    PERFORM pg_notify('staffly_live', jsonb_strip_nulls(jsonb_build_object('topic',TG_ARGV[0],'organizationId',org,'userId',recipient))::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON work_shifts FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON employee_absences FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON organization_positions FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON member_positions FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON shift_templates FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON shift_offers FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON demand_versions FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON demand_exceptions FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON schedule_drafts FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON draft_shifts FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON draft_recipients FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON draft_comments FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('schedule');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON requests FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('requests');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON request_types FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('requests');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON vacation_campaigns FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('requests');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('documents');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON document_folders FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('documents');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON document_acknowledgements FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('documents');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON document_folder_pins FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('documents');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON organization_events FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('events');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON event_recipients FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('events');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON organization_locations FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('organization');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON location_teams FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('organization');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON location_team_members FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('organization');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON location_transfers FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('organization');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON organization_invites FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('organization');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON organization_members FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('access');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON location_members FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('access');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON access_roles FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('access');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON access_assignments FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('access');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON account_notifications FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('notifications');

CREATE FUNCTION staffly_live_organization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('staffly_live', jsonb_build_object('topic',CASE WHEN OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN 'access' ELSE 'organization' END,'organizationId',NEW.id)::text);
  RETURN NULL;
END $$;
CREATE TRIGGER staffly_live AFTER UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION staffly_live_organization();

CREATE FUNCTION staffly_live_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org uuid;
BEGIN
  IF (OLD.first_name,OLD.last_name,OLD.middle_name,OLD.avatar_file_id,OLD.bio,OLD.phone) IS DISTINCT FROM
     (NEW.first_name,NEW.last_name,NEW.middle_name,NEW.avatar_file_id,NEW.bio,NEW.phone) THEN
    FOR org IN SELECT organization_id FROM organization_members WHERE user_id=NEW.id AND left_at IS NULL LOOP
      PERFORM pg_notify('staffly_live',jsonb_build_object('topic','profile','organizationId',org)::text);
    END LOOP;
  END IF;
  IF (OLD.first_name,OLD.last_name,OLD.middle_name,OLD.avatar_file_id,OLD.bio,OLD.phone,OLD.email,OLD.email_notifications_enabled,OLD.email_notification_categories) IS DISTINCT FROM
     (NEW.first_name,NEW.last_name,NEW.middle_name,NEW.avatar_file_id,NEW.bio,NEW.phone,NEW.email,NEW.email_notifications_enabled,NEW.email_notification_categories) THEN
    PERFORM pg_notify('staffly_live',jsonb_build_object('topic','profile','userId',NEW.id)::text);
  END IF;
  IF (OLD.password_hash,OLD.security_version,OLD.deleted_at) IS DISTINCT FROM (NEW.password_hash,NEW.security_version,NEW.deleted_at) THEN
    PERFORM pg_notify('staffly_live',jsonb_build_object('topic','access','userId',NEW.id)::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER staffly_live AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION staffly_live_profile();
CREATE FUNCTION staffly_live_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS DISTINCT FROM NEW.revoked_at THEN
    PERFORM pg_notify('staffly_live',jsonb_build_object('topic','access','userId',NEW.user_id)::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER staffly_live AFTER UPDATE OF revoked_at ON auth_sessions FOR EACH ROW EXECUTE FUNCTION staffly_live_session();

CREATE TABLE report_exports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  input jsonb NOT NULL,
  input_hash varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz(3),
  object_key varchar(512),
  error_code varchar(64),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL
);
CREATE INDEX report_exports_status_lease_until_created_at_idx ON report_exports(status,lease_until,created_at);
CREATE INDEX report_exports_user_id_created_at_idx ON report_exports(user_id,created_at);
CREATE INDEX report_exports_expires_at_idx ON report_exports(expires_at);
CREATE FUNCTION staffly_live_export() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM pg_notify('staffly_live',jsonb_build_object('topic','exports','userId',NEW.user_id)::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER staffly_live AFTER UPDATE OF status ON report_exports FOR EACH ROW EXECUTE FUNCTION staffly_live_export();

CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON report_templates FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('organization');
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON auth_identities FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('profile');
