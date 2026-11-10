import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseChecksPassed, requiredReleaseChecks } from '../../src/shared/release-check.ts'
import { readFileSync } from 'node:fs'
test('release fails closed for omitted, skipped, failed or cancelled mandatory checks',()=>{
 const complete=Object.fromEntries(requiredReleaseChecks.map(k=>[k,true]))
 assert(releaseChecksPassed(complete))
 for(const key of requiredReleaseChecks)for(const state of [undefined,false,'skipped','cancelled','failure'])assert.equal(releaseChecksPassed({...complete,[key]:state}),false)
 assert.equal(releaseChecksPassed(null),false)
})
test('CI gate requires personnel and reusable containers before producing the release artifact',()=>{
 const ci=readFileSync('.github/workflows/ci.yml','utf8'),smoke=readFileSync('.github/workflows/production.yml','utf8')
 assert.match(ci,/needs: \[quality, server, browser, layout, security, personnel, production\]/)
 for(const name of ['PERSONNEL','PRODUCTION'])assert(ci.indexOf('test "$'+name+'" = success')<ci.indexOf('Prepare release verification report'))
 assert.match(smoke,/workflow_call:/);assert.doesNotMatch(smoke,/paths:/)
 assert.match(ci,/personnelTests:true,containerTests:true/)
})

import { verifyReleaseEvidence } from '../../scripts/verify-release-evidence.ts'
import { verifiedReleaseChecks } from '../../src/shared/release-check.ts'
const sha='a'.repeat(40),evidence={repository:'example/staffly',runId:123,runAttempt:2}
const successfulJobs=['Build and lint','Empty database and server tests','CI gate','Personnel / light','Personnel / dark','Production smoke / Production containers','Security / Secrets and dependencies',...['chrome','firefox','webkit'].map(b=>'Admin layout / '+b),...['monitoring','management','operations','workflow','polish','review-fixes','service'].flatMap(s=>['light','dark'].map(t=>`Admin ${s} / ${t}`))].map(name=>({name,status:'completed',conclusion:'success'}))
test('operator verifies actual workflow attempt, SHA and every required job before registration',async()=>{
 const run={run_attempt:2,head_sha:sha,name:'CI',path:'.github/workflows/ci.yml',event:'push',status:'completed',conclusion:'success'}
 const request=(overrides:Record<string,unknown>={},jobs=successfulJobs):typeof fetch=>async input=>new Response(JSON.stringify(String(input).includes('/jobs?')?{jobs,total_count:jobs.length}:{...run,...overrides}),{status:200})
 assert.equal((await verifyReleaseEvidence(evidence,sha,{request:request()})).headSha,sha)
 for(const name of ['Personnel / light','Production smoke / Production containers','Empty database and server tests']){
  await assert.rejects(verifyReleaseEvidence(evidence,sha,{request:request({},successfulJobs.filter(j=>j.name!==name))}),/Mandatory/)
  for(const conclusion of ['skipped','failure','cancelled'])await assert.rejects(verifyReleaseEvidence(evidence,sha,{request:request({},successfulJobs.map(j=>j.name===name?{...j,conclusion}:j))}),/Mandatory/)
 }
 for(const overrides of [{run_attempt:3},{head_sha:'b'.repeat(40)},{event:'pull_request'},{conclusion:'failure'},{status:'in_progress'}])await assert.rejects(verifyReleaseEvidence(evidence,sha,{request:request(overrides)}),/does not match/)
 await assert.rejects(verifyReleaseEvidence(evidence,sha,{request:async()=>new Response('',{status:503})}),/Cannot verify/)
 let reads=0
 const racing:typeof fetch=async input=>new Response(JSON.stringify(String(input).includes('/jobs?')?{jobs:successfulJobs,total_count:successfulJobs.length}:{...run,run_attempt:++reads===1?2:3}),{status:200})
 await assert.rejects(verifyReleaseEvidence(evidence,sha,{request:racing}),/changed during verification/)
})
test('legacy database rows and evidence for another commit cannot make the release green',()=>{
 const checks=Object.fromEntries(requiredReleaseChecks.map(k=>[k,true]))
 assert.equal(verifiedReleaseChecks(checks,sha),false)
 const ci={...evidence,headSha:sha,verifiedAt:new Date().toISOString()}
 assert(verifiedReleaseChecks({...checks,ci},sha))
 assert.equal(verifiedReleaseChecks({...checks,ci},'b'.repeat(40)),false)
 assert.equal(verifiedReleaseChecks({...checks,containerTests:false,ci},sha),false)
})
