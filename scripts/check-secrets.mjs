import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project=fileURLToPath(new URL('../',import.meta.url))
export async function scanSecrets(root, directory) {
  root=await realpath(root)
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024})
  assert.equal(git(['rev-parse','--is-shallow-repository']).trim(),'false','Secret scanning needs the full Git history (fetch-depth: 0)')
  await mkdir(directory,{recursive:true})
  const snapshot=await mkdtemp(path.join(tmpdir(),'staffly-secret-scan-'))
  try {
    // Scan exactly versioned/non-ignored project files, including local new files.
    // Never copy a developer's ignored .env/storage or follow symlinks outside it.
    const files=new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))
    for (const file of files) {
      const source=path.resolve(root,file), destination=path.resolve(snapshot,file)
      assert.ok(source.startsWith(root+path.sep) && destination.startsWith(snapshot+path.sep))
      const info=await lstat(source).catch(error=>{if(error.code==='ENOENT')return null;throw error})
      if (!info) continue
      await mkdir(path.dirname(destination),{recursive:true})
      if(info.isSymbolicLink()) await writeFile(destination,await readlink(source))
      else if(info.isFile()) {assert.ok((await realpath(source)).startsWith(root+path.sep),'Project files must not resolve outside the repository'); await copyFile(source,destination)}
    }
    const results=[]
    for (const [mode,source] of [['git',root],['dir',snapshot]]) {
      const reportPath=path.join(directory,mode==='git'?'history.json':'source.json')
      await rm(reportPath,{force:true})
      const child=spawn('gitleaks',[mode,'--no-banner','--redact=100','--ignore-gitleaks-allow','--config',path.join(root,'.gitleaks.toml'),'--report-format=json','--report-path',reportPath,...(mode==='git'?['--log-opts=--all']:[]),source],{cwd:root,stdio:['ignore','ignore','pipe']})
      let diagnostic=''; child.stderr.on('data',chunk=>{diagnostic+=chunk})
      const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
      await writeFile(path.join(directory,mode+'.log'),diagnostic)
      if (code!==0 && code!==1) throw new Error('Gitleaks failed to complete; inspect its redacted diagnostic report')
      const findings=JSON.parse(await readFile(reportPath,'utf8')) ?? []
      results.push({mode,code,findings:findings.length})
    }
    return {clean:results.every(item=>item.code===0 && item.findings===0),results}
  } finally {await rm(snapshot,{recursive:true,force:true})}
}

async function selfTest() {
  const root=await mkdtemp(path.join(tmpdir(),'staffly-secret-probe-'))
  const reports=await mkdtemp(path.join(tmpdir(),'staffly-secret-reports-'))
  try {
    const git=args=>execFileSync('git',args,{cwd:root,stdio:'ignore'})
    git(['init','--quiet']); await copyFile(path.join(project,'.gitleaks.toml'),path.join(root,'.gitleaks.toml'))
    const chars='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const canary='ghp_'+Array.from({length:36},()=>chars[randomInt(chars.length)]).join('')
    await writeFile(path.join(root,'probe.txt'),'token='+canary+'\n')
    git(['add','.']); git(['-c','user.name=CI probe','-c','user.email=probe@example.test','commit','--quiet','-m','Synthetic detector probe'])
    const result=await scanSecrets(root,reports)
    assert.equal(result.clean,false,'A synthetic token must fail scanning')
    for(const file of ['history.json','source.json','git.log','dir.log']) assert.equal((await readFile(path.join(reports,file),'utf8')).includes(canary),false,'Reports must redact the synthetic token')
    console.log('Secret detector rejects a synthetic token and redacts reports.')
  } finally {await rm(root,{recursive:true,force:true});await rm(reports,{recursive:true,force:true})}
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.includes('--self-test')) await selfTest()
  else {const result=await scanSecrets(project,path.join(project,'artifacts/ci/security'));console.log(JSON.stringify(result));process.exitCode=result.clean?0:1}
}
