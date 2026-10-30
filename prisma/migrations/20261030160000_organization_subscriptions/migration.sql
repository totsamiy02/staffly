BEGIN;
CREATE TABLE organization_subscriptions (
 organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
 plan VARCHAR(16) NOT NULL DEFAULT 'BUSINESS' CHECK(plan IN ('FREE','TEAM','BUSINESS')),
 version VARCHAR(32) NOT NULL DEFAULT '2026-10-v1',
 period_start TIMESTAMPTZ(3), period_end TIMESTAMPTZ(3), trial_ends_at TIMESTAMPTZ(3),
 next_plan VARCHAR(16) CHECK(next_plan IN ('FREE','TEAM','BUSINESS')),
 next_starts_at TIMESTAMPTZ(3), next_ends_at TIMESTAMPTZ(3),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((next_plan IS NULL) = (next_starts_at IS NULL)),
 CHECK (period_end IS NULL OR period_end>period_start),
 CHECK (next_ends_at IS NULL OR next_ends_at>next_starts_at)
);
CREATE TABLE subscription_purchases (
 id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id UUID REFERENCES users(id) ON DELETE SET NULL,
 plan VARCHAR(16) NOT NULL CHECK(plan IN ('TEAM','BUSINESS')), version VARCHAR(32) NOT NULL DEFAULT '2026-10-v1',
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SUCCEEDED','CANCELED')),
 kind VARCHAR(16) NOT NULL CHECK(kind IN ('ACTIVATE','RENEW','UPGRADE','DOWNGRADE')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>=0), currency VARCHAR(3) NOT NULL DEFAULT 'RUB' CHECK(currency='RUB'),
 subscription_revision INTEGER NOT NULL, period_start TIMESTAMPTZ(3) NOT NULL, period_end TIMESTAMPTZ(3) NOT NULL,
 expires_at TIMESTAMPTZ(3) NOT NULL, activated_at TIMESTAMPTZ(3), email VARCHAR(254), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(period_end>period_start)
);
CREATE INDEX subscription_purchases_organization_id_created_at_idx ON subscription_purchases(organization_id,created_at);
CREATE INDEX subscription_purchases_expires_at_status_idx ON subscription_purchases(expires_at,status);
INSERT INTO organization_subscriptions(organization_id,period_start,period_end,trial_ends_at)
 SELECT id,now(),now()+interval '14 days',now()+interval '14 days' FROM organizations;
UPDATE organization_resource_budgets SET storage_limit_bytes=10737418240;
CREATE OR REPLACE FUNCTION staffly_init_resource_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO organization_resource_budgets(organization_id,storage_limit_bytes) VALUES(NEW.id,10737418240);
 INSERT INTO organization_subscriptions(organization_id,period_start,period_end,trial_ends_at) VALUES(NEW.id,now(),now()+interval '14 days',now()+interval '14 days');
 RETURN NEW;
END $$;
-- Resolve the effective plan at storage reservation time, including a scheduled
-- downgrade or expiry while the maintenance worker is unavailable.
CREATE FUNCTION staffly_subscription_storage_limit(org UUID) RETURNS BIGINT LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p.plan='FREE' OR p.ends_at IS NULL OR p.ends_at+interval '7 days'<=now() THEN 262144000 WHEN p.plan='TEAM' THEN 2147483648 ELSE 10737418240 END
 FROM (SELECT CASE WHEN next_starts_at<=now() THEN next_plan ELSE plan END AS plan,
 CASE WHEN next_starts_at<=now() THEN next_ends_at ELSE period_end END AS ends_at
 FROM organization_subscriptions WHERE organization_id=org) p
$$;
CREATE OR REPLACE FUNCTION staffly_storage_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_bytes BIGINT:=0; new_bytes BIGINT:=0; delta BIGINT; ceiling BIGINT;
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') AND OLD.purged_at IS NULL THEN old_bytes:=OLD.size; END IF;
 IF TG_OP IN ('INSERT','UPDATE') AND NEW.purged_at IS NULL THEN new_bytes:=NEW.size; END IF;
 IF TG_OP='UPDATE' AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
  delta:=new_bytes-old_bytes;
  IF delta=0 OR NEW.organization_id IS NULL THEN RETURN NEW; END IF;
  ceiling:=COALESCE(staffly_subscription_storage_limit(NEW.organization_id),262144000);
  UPDATE organization_resource_budgets SET storage_bytes=storage_bytes+delta WHERE organization_id=NEW.organization_id AND (delta<=0 OR storage_bytes+delta<=LEAST(storage_limit_bytes,ceiling));
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ORGANIZATION_STORAGE_QUOTA_EXCEEDED'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP IN ('DELETE','UPDATE') AND OLD.organization_id IS NOT NULL THEN
  UPDATE organization_resource_budgets SET storage_bytes=storage_bytes-old_bytes WHERE organization_id=OLD.organization_id;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') AND NEW.organization_id IS NOT NULL THEN
  ceiling:=COALESCE(staffly_subscription_storage_limit(NEW.organization_id),262144000);
  UPDATE organization_resource_budgets SET storage_bytes=storage_bytes+new_bytes WHERE organization_id=NEW.organization_id AND storage_bytes+new_bytes<=LEAST(storage_limit_bytes,ceiling);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ORGANIZATION_STORAGE_QUOTA_EXCEEDED'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON organization_subscriptions FOR EACH ROW EXECUTE FUNCTION staffly_live_hint('organization');
COMMIT;
