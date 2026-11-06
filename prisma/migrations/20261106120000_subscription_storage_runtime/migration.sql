-- The runtime cannot write quota policy directly. Synchronize only the ceiling
-- derived from the persisted subscription, never a caller-supplied byte limit.
CREATE FUNCTION public.staffly_sync_subscription_storage_limit(org UUID)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE public.organization_resource_budgets
  SET storage_limit_bytes=COALESCE(public.staffly_subscription_storage_limit(org),262144000)
  WHERE organization_id=org;
$$;
REVOKE ALL ON FUNCTION public.staffly_sync_subscription_storage_limit(UUID) FROM PUBLIC;
