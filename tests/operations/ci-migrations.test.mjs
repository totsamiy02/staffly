import assert from 'node:assert/strict'
import { it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkMigrationHistory } from '../../scripts/check-migrations.mjs'

async function repository(run) {
  const root=await mkdtemp(path.join(tmpdir(),'staffly-migration-policy-'))
  const old=path.join(root,'prisma/migrations/20260101000000_initial/migration.sql')
  const git=args=>execFileSync('git',args,{cwd:root,stdio:'ignore'})
  try {
    await mkdir(path.dirname(old),{recursive:true});await writeFile(old,'SELECT 1;\n')
    git(['init','--quiet']);git(['add','.']);git(['-c','user.name=CI test','-c','user.email=ci@example.test','commit','--quiet','-m','Initial migration'])
    await run(root,old)
  } finally {await rm(root,{recursive:true,force:true})}
}
it('accepts a new migration after the existing history',()=>repository(async root=>{
  const sql=path.join(root,'prisma/migrations/20260102000000_next/migration.sql')
  await mkdir(path.dirname(sql));await writeFile(sql,'SELECT 2;')
  assert.equal((await checkMigrationHistory(root)).migrations,2)
}))
it('rejects rewriting an existing migration even before it is committed',()=>repository(async(root,old)=>{
  await writeFile(old,'SELECT 999;')
  await assert.rejects(checkMigrationHistory(root),/Existing migration files/)
}))
it('rejects a new migration inserted before the baseline',()=>repository(async root=>{
  const sql=path.join(root,'prisma/migrations/20250101000000_older/migration.sql')
  await mkdir(path.dirname(sql));await writeFile(sql,'SELECT 2;')
  await assert.rejects(checkMigrationHistory(root),/sort after/)
}))
it('rejects empty SQL and invalid baseline arguments',()=>repository(async root=>{
  const sql=path.join(root,'prisma/migrations/20260102000000_next/migration.sql')
  await mkdir(path.dirname(sql));await writeFile(sql,'\n')
  await assert.rejects(checkMigrationHistory(root),/must not be empty/)
  await writeFile(sql,'SELECT 2;')
  await assert.rejects(checkMigrationHistory(root,'--help'),/baseline/)
}))
