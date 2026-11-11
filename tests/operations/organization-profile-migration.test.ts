import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {databasePool,prisma} from '../../src/server/db.ts'
after(()=>prisma.$disconnect())
test('profile migration preserves existing descriptions, physical addresses and unknown opening hours',async()=>{
 const schema='profile_rehearsal_'+randomUUID().replaceAll('-',''),id=randomUUID(),point=randomUUID(),owner=randomUUID(),db=await databasePool.connect()
 try{
  await db.query('BEGIN');await db.query('CREATE SCHEMA '+schema);await db.query('SET LOCAL search_path TO '+schema)
  await db.query('CREATE TABLE organizations(id uuid PRIMARY KEY,created_by_user_id uuid NOT NULL,name varchar(120),description varchar(1000),timezone varchar(64));CREATE TABLE organization_locations(id uuid PRIMARY KEY,organization_id uuid,name varchar(120),city varchar(120),address varchar(300),timezone varchar(64))')
  await db.query('INSERT INTO organizations VALUES($1,$2,$3,$4,$5)',[id,owner,'Синтетическая организация','Существующее описание','Europe/Moscow'])
  await db.query('INSERT INTO organization_locations VALUES($1,$2,$3,$4,$5,$6)',[point,id,'Основная точка','Город','Существующий адрес','Asia/Yekaterinburg'])
  await db.query(await readFile('prisma/migrations/20261111190000_organization_profiles/migration.sql','utf8'))
  const org=(await db.query('SELECT * FROM organizations')).rows[0],location=(await db.query('SELECT * FROM organization_locations')).rows[0]
  assert.equal(org.description,'Существующее описание');assert.equal(org.industry,null);assert.equal(org.profile_revision,1);assert.equal(org.creation_key,null)
  assert.equal(location.address,'Существующий адрес');assert.equal(location.timezone,'Asia/Yekaterinburg');assert.equal(location.kind,'PHYSICAL');assert.equal(location.opening_hours,null);assert.equal(location.inherits_timezone,false);assert.equal(location.phone,null)
  await db.query('SAVEPOINT invalid');await assert.rejects(db.query("UPDATE organization_locations SET opening_hours='{}'::jsonb"),{code:'23514'});await db.query('ROLLBACK TO SAVEPOINT invalid')
 }finally{await db.query('ROLLBACK');db.release()}
})
