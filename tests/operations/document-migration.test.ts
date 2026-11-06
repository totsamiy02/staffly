import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'

it('marks proven automatic legacy folders, protects employee names and leaves an unrelated namesake unchanged', async () => {
  const connection = new Client({ connectionString: process.env.DATABASE_URL })
  const schema = 'document_migration_' + randomUUID().replaceAll('-', '')
  await connection.connect()
  try {
    await connection.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`)
    await connection.query(`CREATE TABLE organizations(id uuid PRIMARY KEY,created_at timestamptz);
      CREATE TABLE document_folders(id uuid PRIMARY KEY,organization_id uuid,location_id uuid,parent_id uuid,name text,created_at timestamptz,
      visibility text DEFAULT 'ORGANIZATION',audience_member_ids uuid[] DEFAULT '{}',audience_role_ids uuid[] DEFAULT '{}',inherit_access boolean DEFAULT false);
      CREATE TABLE documents(folder_id uuid,target_member_id uuid)`)
    const [org, root, child, custom, target] = Array.from({ length: 5 }, () => randomUUID())
    await connection.query('INSERT INTO organizations VALUES($1,now())', [org])
    await connection.query("INSERT INTO document_folders(id,organization_id,name,created_at) VALUES($1,$3,'Документы сотрудников',now()),($2,$3,'Документы сотрудников',now()+interval '1 day')", [root,custom,org])
    await connection.query("INSERT INTO document_folders(id,organization_id,parent_id,name,created_at) VALUES($1,$2,$3,'Employee',now())", [child,org,root])
    await connection.query('INSERT INTO documents VALUES($1,$2)', [child,target])
    await connection.query(await readFile(new URL('../../prisma/migrations/20261106010000_document_system_folders/migration.sql', import.meta.url), 'utf8'))
    const rows = (await connection.query('SELECT id,system_key,visibility,audience_member_ids FROM document_folders')).rows
    assert.equal(rows.find(row => row.id === root).system_key, 'employees:shared')
    assert.equal(rows.find(row => row.id === custom).system_key, null)
    assert.equal(rows.find(row => row.id === child).system_key, 'employee:' + root + ':' + target)
    assert.equal(rows.find(row => row.id === child).visibility, 'SELECTED')
    assert.deepEqual(rows.find(row => row.id === child).audience_member_ids, [target])
  } finally {
    await connection.query('ROLLBACK')
    await connection.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await connection.end()
  }
})
