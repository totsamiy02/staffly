import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { databasePool, prisma } from '../../src/server/db.ts';
after(() => prisma.$disconnect());
test('personnel migration preserves existing IDs, numbers and audit without guessing account names or contacts', async () => {
    const schema = 'personnel_rehearsal_' + randomUUID().replaceAll('-', ''), member = randomUUID(), org = randomUUID(), db = await databasePool.connect();
    try {
        await db.query('BEGIN');
        await db.query('CREATE SCHEMA ' + schema);
        await db.query('SET LOCAL search_path TO ' + schema);
        await db.query('CREATE TABLE organization_members(id uuid PRIMARY KEY,organization_id uuid,personnel_number varchar(32));CREATE TABLE access_audit(id uuid PRIMARY KEY,organization_id uuid,details jsonb,action varchar(80),created_at timestamptz)');
        await db.query('INSERT INTO organization_members VALUES($1,$2,$3)', [member, org, 'Existing-42']);
        await db.query(await readFile('prisma/migrations/20261112120000_member_personnel_profile/migration.sql', 'utf8'));
        const row = (await db.query('SELECT * FROM organization_members')).rows[0];
        assert.equal(row.id, member);
        assert.equal(row.personnel_number, 'Existing-42');
        assert.equal(row.personnel_first_name, null);
        assert.equal(row.work_email, null);
        assert.equal(row.personnel_revision, 1);
        await db.query('SAVEPOINT invalid');
        await assert.rejects(db.query('UPDATE organization_members SET personnel_revision=0'), { code: '23514' });
        await db.query('ROLLBACK TO SAVEPOINT invalid');
    }
    finally {
        await db.query('ROLLBACK');
        db.release();
    }
});
