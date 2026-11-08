-- Recover the date of the actual counting baseline without inventing history.
ALTER TABLE public.platform_lifetime_metrics ADD COLUMN counted_from timestamptz(3);
UPDATE public.platform_lifetime_metrics SET counted_from=(
 SELECT finished_at FROM public._prisma_migrations
 WHERE migration_name='20261107003000_monitoring_history' AND rolled_back_at IS NULL
 ORDER BY started_at DESC LIMIT 1
);

-- A successful action has a durable, read-only receipt. Codes remain one-use.
CREATE TABLE staffly_admin.action_receipts (
 challenge_id uuid PRIMARY KEY REFERENCES staffly_admin.action_challenges(id) ON DELETE CASCADE,
 resource_id uuid, completed_at timestamptz(3) NOT NULL DEFAULT now()
);
REVOKE ALL ON staffly_admin.action_receipts FROM PUBLIC;
ALTER FUNCTION staffly_admin.execute_management_action(uuid,uuid,uuid,text,uuid,text,text)
 RENAME TO execute_management_action_once;
CREATE FUNCTION staffly_admin.execute_management_action(p_user uuid,p_auth uuid,p_session uuid,p_hash text,p_challenge uuid,p_browser text,p_proof text)
RETURNS TABLE(result text,resource_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE performed record;
BEGIN
 SELECT * INTO performed FROM staffly_admin.execute_management_action_once(p_user,p_auth,p_session,p_hash,p_challenge,p_browser,p_proof);
 IF performed.result='OK' THEN
  INSERT INTO staffly_admin.action_receipts(challenge_id,resource_id) VALUES(p_challenge,performed.resource_id);
 END IF;
 RETURN QUERY SELECT performed.result::text,performed.resource_id::uuid;
END;
$$;
REVOKE ALL ON FUNCTION staffly_admin.execute_management_action(uuid,uuid,uuid,text,uuid,text,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='staffly_admin_gateway') THEN
  REVOKE ALL ON FUNCTION staffly_admin.execute_management_action_once(uuid,uuid,uuid,text,uuid,text,text) FROM staffly_admin_gateway;
  GRANT SELECT ON staffly_admin.action_receipts TO staffly_admin_gateway;
  GRANT EXECUTE ON FUNCTION staffly_admin.execute_management_action(uuid,uuid,uuid,text,uuid,text,text) TO staffly_admin_gateway;
 END IF;
END $$;
