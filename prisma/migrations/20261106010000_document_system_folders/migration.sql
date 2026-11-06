BEGIN;
ALTER TABLE document_folders ADD COLUMN system_key VARCHAR(180);

-- Recognize legacy automatic roots by original seed time or linked employee files.
-- An unrelated user-created namesake must remain an ordinary folder.
WITH candidates AS (
  SELECT f.id, 'employees:' || COALESCE(f.location_id::text,'shared') AS key,
    row_number() OVER (PARTITION BY f.organization_id,f.location_id ORDER BY f.created_at,f.id) AS ordinal
  FROM document_folders f JOIN organizations o ON o.id=f.organization_id
  WHERE f.parent_id IS NULL AND f.name='Документы сотрудников'
  AND (f.created_at BETWEEN o.created_at - interval '1 second' AND o.created_at + interval '5 seconds'
    OR EXISTS(SELECT 1 FROM document_folders c JOIN documents d ON d.folder_id=c.id
      WHERE c.parent_id=f.id AND d.target_member_id IS NOT NULL))
)
UPDATE document_folders f SET system_key=c.key FROM candidates c WHERE c.id=f.id AND c.ordinal=1;

WITH children AS (
  SELECT c.id,c.parent_id,CASE WHEN count(DISTINCT d.target_member_id)=1 THEN min(d.target_member_id::text) ELSE NULL END AS member_id
  FROM document_folders c JOIN document_folders p ON p.id=c.parent_id AND p.system_key LIKE 'employees:%'
  LEFT JOIN documents d ON d.folder_id=c.id AND d.target_member_id IS NOT NULL
  GROUP BY c.id,c.parent_id
), ranked AS (
  SELECT *,row_number() OVER(PARTITION BY parent_id,member_id ORDER BY id) AS ordinal FROM children
)
UPDATE document_folders f SET system_key=CASE WHEN r.member_id IS NOT NULL AND r.ordinal=1
  THEN 'employee:' || r.parent_id::text || ':' || r.member_id ELSE 'legacy-employee:' || f.id::text END
FROM ranked r WHERE r.id=f.id;

-- Employee names and private contents are not a public directory.
UPDATE document_folders SET visibility='SELECTED',
  audience_member_ids=ARRAY[(split_part(system_key,':',3))::uuid]
WHERE system_key LIKE 'employee:%' AND visibility='ORGANIZATION'
  AND cardinality(audience_member_ids)=0 AND cardinality(audience_role_ids)=0 AND NOT inherit_access;

CREATE UNIQUE INDEX document_folders_organization_id_system_key_key ON document_folders(organization_id,system_key);
COMMIT;
