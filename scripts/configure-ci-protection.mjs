import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Explicit operator command. No repository token is stored in files or logs.
const root=fileURLToPath(new URL('../',import.meta.url))
assert.ok(process.argv.slice(2).every(arg=>arg==='--apply'),'Only --apply is supported; no argument is a read-only preview')
const remote=execFileSync('git',['remote','get-url','origin'],{cwd:root,encoding:'utf8'}).trim()
const match=/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)
assert.ok(match,'Expected a github.com origin remote')
const repo=match[1], name='Staffly required CI'
let token=process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if(!token) {
  try {token=execFileSync('gh',['auth','token'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()} catch { /* Use the normal Git credential helper below. */ }
}
if(!token) {
  try {
    const output=execFileSync('git',['-c','credential.interactive=never','credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',stdio:['pipe','pipe','ignore'],env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})
    token=output.split('\n').find(line=>line.startsWith('password='))?.slice('password='.length)
  } catch { /* Fail without exposing helper output. */ }
}
assert.ok(token,'Authenticate with gh auth login using an account with repository administration access')
async function api(endpoint,method='GET',body) {
  const response=await fetch('https://api.github.com/'+endpoint,{method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})
  if(!response.ok) throw new Error(`GitHub ${method} failed (${response.status}); administration access is required`)
  return response.json()
}
const repository=await api('repos/'+repo)
assert.equal(repository.permissions?.admin,true,'Repository administration access is required')
const current=(await api('repos/'+repo+'/rulesets')).find(rule=>rule.name===name)
const before=current?await api('repos/'+repo+'/rulesets/'+current.id):null
const rule={name,target:'branch',enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['~DEFAULT_BRANCH'],exclude:[]}},rules:[
  {type:'deletion'}, {type:'non_fast_forward'},
  {type:'pull_request',parameters:{required_approving_review_count:0,dismiss_stale_reviews_on_push:false,require_code_owner_review:false,require_last_push_approval:false,required_review_thread_resolution:true,allowed_merge_methods:['merge','squash','rebase']}},
  {type:'required_status_checks',parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:'CI gate',integration_id:15368}]}}
]}
console.log(JSON.stringify({repository:repo,branch:repository.default_branch,requiredCheck:'CI gate',source:'GitHub Actions',current:before?.enforcement??'not configured',apply:process.argv.includes('--apply')}))
if(process.argv.includes('--apply')) {
  assert.match(await readFile(path.join(root,'.github/workflows/ci.yml'),'utf8'),/name: CI gate/,'Prepare the matching workflow before enabling protection')
  await mkdir(path.join(root,'artifacts/ci'),{recursive:true})
  await writeFile(path.join(root,'artifacts/ci/protection-before.json'),JSON.stringify(before,null,2)+'\n')
  const saved=await api('repos/'+repo+'/rulesets'+(current?'/'+current.id:''),current?'PUT':'POST',rule)
  const verified=await api('repos/'+repo+'/rulesets/'+saved.id)
  assert.equal(verified.enforcement,'active')
  assert.ok(verified.rules.some(item=>item.type==='required_status_checks' && item.parameters.required_status_checks.some(check=>check.context==='CI gate' && check.integration_id===15368)))
  await writeFile(path.join(root,'artifacts/ci/protection.json'),JSON.stringify(verified,null,2)+'\n')
  console.log('Required CI protection enabled and verified: '+(verified._links?.html?.href ?? `https://github.com/${repo}/settings/rules/${verified.id}`))
}
