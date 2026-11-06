import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('../',import.meta.url))
const directory=path.join(root,'artifacts/ci/security')
await mkdir(directory,{recursive:true})
const child=spawn(process.platform==='win32'?'npm.cmd':'npm',['audit','--package-lock-only','--ignore-scripts','--audit-level=high','--json'],{cwd:root,stdio:['ignore','pipe','pipe']})
let output=''
child.stdout.on('data',chunk=>{output+=chunk}); child.stderr.resume()
const code=await new Promise((resolve,reject)=>{child.on('error',reject); child.on('close',resolve)})
let report
try {report=JSON.parse(output)} catch {throw new Error('npm audit returned no valid JSON; dependency verification did not complete')}
await writeFile(path.join(directory,'dependencies.json'),JSON.stringify(report,null,2)+'\n')
if (report.error || !report.metadata?.vulnerabilities) throw new Error('Dependency audit service is unavailable; check the saved report and rerun')
console.log('Dependency audit:',JSON.stringify(report.metadata.vulnerabilities))
process.exitCode=code===0?0:1
