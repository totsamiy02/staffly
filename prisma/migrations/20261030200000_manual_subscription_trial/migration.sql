ALTER TYPE "AccountNotificationType" ADD VALUE 'SUBSCRIPTION_STATUS';
ALTER TABLE account_notifications ADD COLUMN subscription_delivery_key VARCHAR(200);
CREATE UNIQUE INDEX account_notifications_subscription_delivery_key_key ON account_notifications(subscription_delivery_key);
ALTER TABLE organization_subscriptions ADD COLUMN trial_started_at TIMESTAMPTZ(3);
ALTER TABLE organization_subscriptions ALTER COLUMN plan SET DEFAULT 'FREE';
-- Previously issued trials were automatic. Return them to Free and preserve
-- all data, including resources already exceeding the Free limits. The unused
-- manual trial remains available. Successful purchases are never reset.
WITH reverted AS (
 UPDATE organization_subscriptions s SET plan='FREE',period_start=NULL,period_end=NULL,trial_ends_at=NULL,
 next_plan=NULL,next_starts_at=NULL,next_ends_at=NULL,revision=revision+1,updated_at=now()
 WHERE trial_ends_at IS NOT NULL AND NOT EXISTS
 (SELECT 1 FROM subscription_purchases p WHERE p.organization_id=s.organization_id AND p.status='SUCCEEDED')
 RETURNING organization_id
)
UPDATE organization_resource_budgets b SET storage_limit_bytes=262144000 FROM reverted r WHERE b.organization_id=r.organization_id;
CREATE OR REPLACE FUNCTION staffly_init_resource_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO organization_resource_budgets(organization_id,storage_limit_bytes) VALUES(NEW.id,262144000);
 INSERT INTO organization_subscriptions(organization_id,plan) VALUES(NEW.id,'FREE');
 RETURN NEW;
END $$;
