import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {databasePool,prisma} from '../../src/server/db.ts'
after(()=>prisma.$disconnect())
test('actual period migration preserves unknown history, records returns atomically and rejects duplicate open periods',async()=>{
 const name='period_rehearsal_'+randomUUID().replaceAll('-',''),id=randomUUID(),organization=randomUUID()
 await databasePool.query('CREATE SCHEMA '+name)
 try{
  await databasePool.query(`CREATE TABLE ${name}.organization_members(id uuid PRIMARY KEY,organization_id uuid NOT NULL,joined_at timestamptz(3) NOT NULL,left_at timestamptz(3),UNIQUE(organization_id,id))`)
  await databasePool.query(`INSERT INTO ${name}.organization_members VALUES($1,$2,'2020-01-01',now()-interval '1 day')`,[id,organization])
  const sql=await readFile('prisma/migrations/20261110190000_member_employment_periods/migration.sql','utf8')
  await databasePool.query(sql.replaceAll('public.',name+'.'))
  const legacy=(await databasePool.query(`SELECT * FROM ${name}.member_employment_periods`)).rows[0]
  assert.equal(legacy.started_at,null);assert.equal(legacy.source,'LEGACY');assert(legacy.ended_at)
  await databasePool.query(`UPDATE ${name}.organization_members SET left_at=NULL WHERE id=$1`,[id])
  let periods=(await databasePool.query(`SELECT * FROM ${name}.member_employment_periods ORDER BY started_at NULLS FIRST`)).rows
  assert.equal(periods.length,2);assert.equal(periods[1].source,'RECORDED');assert(periods[1].started_at)
  const db=await databasePool.connect()
  try{await db.query('BEGIN');await db.query(`UPDATE ${name}.organization_members SET left_at=clock_timestamp() WHERE id=$1`,[id]);await db.query('ROLLBACK')}finally{db.release()}
  assert.equal((await databasePool.query(`SELECT count(*)::int n FROM ${name}.member_employment_periods WHERE ended_at IS NULL`)).rows[0].n,1)
  await databasePool.query(`UPDATE ${name}.organization_members SET left_at=clock_timestamp() WHERE id=$1`,[id])
  assert.equal((await databasePool.query(`SELECT count(*)::int n FROM ${name}.member_employment_periods WHERE ended_at IS NULL`)).rows[0].n,0)
  await databasePool.query(`UPDATE ${name}.organization_members SET left_at=NULL WHERE id=$1`,[id])
  await assert.rejects(databasePool.query(`INSERT INTO ${name}.member_employment_periods(organization_id,member_id,started_at,source) VALUES($1,$2,now(),'RECORDED')`,[organization,id]),{code:'23505'})
 }finally{await databasePool.query('DROP SCHEMA '+name+' CASCADE')}
})
