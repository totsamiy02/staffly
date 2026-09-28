INSERT INTO document_folders (id, organization_id, name)
SELECT gen_random_uuid(), o.id, 'Главная'
FROM organizations o
WHERE o.deleted_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM document_folders f WHERE f.organization_id = o.id AND f.parent_id IS NULL AND f.name = 'Главная'
);

INSERT INTO document_folders (id, organization_id, name)
SELECT gen_random_uuid(), o.id, 'Документы сотрудников'
FROM organizations o
WHERE o.deleted_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM document_folders f WHERE f.organization_id = o.id AND f.parent_id IS NULL AND f.name = 'Документы сотрудников'
);
