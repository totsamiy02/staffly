import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function checkMigrationHistory(root, base = 'HEAD') {
  const directory = path.join(root,'prisma/migrations')
  const names = (await readdir(directory,{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort()
  assert.ok(names.length,'Migration history must not be empty')
  const timestamps = new Set()
  for (const name of names) {
    assert.match(name,/^\d{14}_[a-z0-9_]+$/,'Use a timestamped migration directory')
    assert.ok(!timestamps.has(name.slice(0,14)),'Migration timestamps must be unique')
    timestamps.add(name.slice(0,14))
    assert.ok((await readFile(path.join(directory,name,'migration.sql'),'utf8')).trim(),'Migration SQL must not be empty')
  }
  if (/^0{40}$/.test(base)) return {migrations:names.length,baseline:'initial push'}
  assert.ok(base==='HEAD' || /^[a-f0-9]{40}$/.test(base),'Migration baseline must be HEAD or a full commit SHA')
  const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  git(['cat-file','-e',base+'^{commit}'])
  const rewritten = git(['diff','--no-renames','--name-only','--diff-filter=MD',base,'--','prisma/migrations'])
  assert.equal(rewritten,'','Existing migration files must not be edited or deleted; add a new migration instead:\n'+rewritten)
  const previous = git(['ls-tree','-r','--name-only',base,'--','prisma/migrations']).split('\n').filter(name=>name.endsWith('/migration.sql'))
  const last = previous.map(name=>name.split('/')[2]).sort().at(-1)
  if (last) for (const name of names) if (!previous.includes('prisma/migrations/'+name+'/migration.sql')) assert.ok(name>last,'New migrations must sort after the baseline migrations')
  return {migrations:names.length,baseline:base}
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const root=fileURLToPath(new URL('../',import.meta.url))
  const result=await checkMigrationHistory(root,process.env.MIGRATION_BASE || 'HEAD')
  // Validation must not load a developer .env or connect to an existing DB.
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','validate','--config','prisma7.config.ts'],{cwd:root,stdio:'inherit',env:{...process.env,PRISMA_ENV_FILE:'/dev/null',DATABASE_URL:'postgresql://unused@127.0.0.1:1/unused'}})
  console.log(JSON.stringify(result))
}
