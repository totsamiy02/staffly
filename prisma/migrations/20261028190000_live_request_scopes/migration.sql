-- Personal lists change for the creator/author/task assignees. Review queues get an
-- organization-wide hint. IDs/topics only; HTTP rechecks all permissions.
CREATE FUNCTION staffly_live_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item requests; previous requests; recipient uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN item := OLD; ELSE item := NEW; END IF;
  IF TG_OP = 'UPDATE' THEN previous := OLD; END IF;
  PERFORM pg_notify('staffly_live', jsonb_build_object('topic','requests-review','organizationId',item.organization_id)::text);
  FOR recipient IN SELECT DISTINCT user_id FROM organization_members
    WHERE organization_id = item.organization_id AND (id IN
      (item.created_by_member_id, item.author_member_id, previous.created_by_member_id, previous.author_member_id)
      OR id::text IN (SELECT jsonb_array_elements_text(
        (CASE WHEN jsonb_typeof(item.outcome -> 'assignees') = 'array' THEN item.outcome -> 'assignees' ELSE '[]'::jsonb END) ||
        (CASE WHEN jsonb_typeof(previous.outcome -> 'assignees') = 'array' THEN previous.outcome -> 'assignees' ELSE '[]'::jsonb END))))
  LOOP
    PERFORM pg_notify('staffly_live', jsonb_build_object('topic','requests-mine','organizationId',item.organization_id,'userId',recipient)::text);
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER staffly_live ON requests;
CREATE TRIGGER staffly_live AFTER INSERT OR UPDATE OR DELETE ON requests FOR EACH ROW EXECUTE FUNCTION staffly_live_request();
