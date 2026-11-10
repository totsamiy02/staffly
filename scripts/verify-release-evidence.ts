export type ReleaseEvidence = { repository:string; runId:number; runAttempt:number }
const mandatoryNames=['Build and lint','Empty database and server tests','CI gate','Personnel / light','Personnel / dark',...['monitoring','management','operations','workflow','polish','review-fixes','service'].flatMap(s=>['light','dark'].map(t=>`Admin ${s} / ${t}`)),...['chrome','firefox','webkit'].map(b=>'Admin layout / '+b)]
export async function verifyReleaseEvidence(evidence: ReleaseEvidence, appVersion:string, { token=process.env.GITHUB_TOKEN, request=fetch }: {token?:string;request?:typeof fetch}={}) {
 if(!/^[\w.-]+\/[\w.-]+$/.test(evidence.repository)||!Number.isSafeInteger(evidence.runId)||evidence.runId<1||!Number.isSafeInteger(evidence.runAttempt)||evidence.runAttempt<1||!/^[a-f0-9]{40}$/.test(appVersion))throw new Error('Invalid CI evidence')
 const base='https://api.github.com/repos/'+evidence.repository+'/actions/runs/'+evidence.runId
 const json=async(url:string)=>{const response=await request(url,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(token?{Authorization:'Bearer '+token}:{})},signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Cannot verify GitHub CI evidence ('+response.status+')');return response.json()}
 const latest=await json(base)
 if(latest.run_attempt!==evidence.runAttempt||latest.head_sha!==appVersion||latest.name!=='CI'||latest.path!=='.github/workflows/ci.yml'||!['push','workflow_dispatch'].includes(latest.event)||latest.status!=='completed'||latest.conclusion!=='success')throw new Error('CI evidence does not match a completed successful release run')
 const jobs:Array<{name:string;status:string;conclusion:string}>=[]
 for(let page=1;page<=10;page++){
  const data=await json(base+'/attempts/'+evidence.runAttempt+'/jobs?per_page=100&page='+page)
  if(!Array.isArray(data.jobs)||!Number.isInteger(data.total_count))throw new Error('Invalid CI jobs response')
  jobs.push(...data.jobs)
  if(jobs.length>=data.total_count)break
  if(page===10)throw new Error('CI jobs response exceeds verification budget')
 }
 for(const name of mandatoryNames)if(!jobs.some(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success'))throw new Error('Mandatory CI job did not succeed: '+name)
 for(const name of ['Production containers','Secrets and dependencies'])if(!jobs.some(j=>(j.name===name||j.name.endsWith(' / '+name))&&j.status==='completed'&&j.conclusion==='success'))throw new Error('Mandatory CI job did not succeed: '+name)
 const current=await json(base)
 if(current.run_attempt!==evidence.runAttempt||current.head_sha!==appVersion||current.status!=='completed'||current.conclusion!=='success')throw new Error('CI attempt changed during verification')
 return {repository:evidence.repository,runId:evidence.runId,runAttempt:evidence.runAttempt,headSha:latest.head_sha,verifiedAt:new Date().toISOString()}
}
