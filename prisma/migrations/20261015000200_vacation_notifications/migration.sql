ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_VACATION_COLLECTION';
ALTER TYPE "AccountNotificationType" ADD VALUE 'REQUEST_VACATION_REMINDER';
CREATE UNIQUE INDEX vacation_campaigns_organization_id_id_key ON vacation_campaigns(organization_id,id);
ALTER TABLE account_notifications ADD COLUMN vacation_campaign_id UUID;
ALTER TABLE account_notifications ADD CONSTRAINT notification_vacation_campaign_tenant_fkey FOREIGN KEY(organization_id,vacation_campaign_id) REFERENCES vacation_campaigns(organization_id,id) ON DELETE CASCADE;
