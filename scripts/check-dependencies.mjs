import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDependencyPatches } from './apply-dependency-patches.mjs'
import { version as patchedVersion } from './patches/picomatch-4.0.7.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const advisoryUrl = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf'

async function coversPatchedPicomatch(report) {
  const { metadata, vulnerabilities } = report
  if (!vulnerabilities || metadata.vulnerabilities.critical !== 0) return false
  const direct = vulnerabilities.picomatch
  if (direct?.severity !== 'high' || direct.via?.length !== 1 || !direct.nodes?.length) return false
  const [advisory] = direct.via
  if (advisory?.name !== 'picomatch' || advisory.url !== advisoryUrl || advisory.range !== '<=4.0.7') return false

  // npm reports parent packages independently. Every blocking entry must
  // resolve solely to the one advisory covered by the installed patch.
  function comesFromPatchedPicomatch(name, visited = new Set()) {
    if (name === 'picomatch') return true
    const causes = vulnerabilities[name]?.via
    if (visited.has(name) || !Array.isArray(causes) || causes.length === 0) return false
    const path = new Set(visited).add(name)
    return causes.every(cause => typeof cause === 'string' && comesFromPatchedPicomatch(cause, path))
  }

  const blocking = Object.keys(vulnerabilities).filter(name => ['high', 'critical'].includes(vulnerabilities[name].severity))
  if (blocking.length !== metadata.vulnerabilities.high || !blocking.every(name => comesFromPatchedPicomatch(name))) return false

  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const installedPaths = Object.keys(lock.packages).filter(key => /(?:^|\/)node_modules\/picomatch$/.test(key))
  if (direct.nodes.some(key => !installedPaths.includes(key) || lock.packages[key].version !== patchedVersion)) return false
  return await applyDependencyPatches(root, { check: true, requireAll: true }) === installedPaths.length
}

const directory = path.join(root, 'artifacts/ci/security')
await mkdir(directory, { recursive: true })
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['audit', '--package-lock-only', '--ignore-scripts', '--audit-level=high', '--json'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', chunk => { output += chunk })
child.stderr.resume()
const code = await new Promise((resolve, reject) => {
  child.on('error', reject)
  child.on('close', resolve)
})
let report
try { report = JSON.parse(output) } catch { throw new Error('npm audit returned no valid JSON; dependency verification did not complete') }
await writeFile(path.join(directory, 'dependencies.json'), JSON.stringify(report, null, 2) + '\n')
if (report.error || !report.metadata?.vulnerabilities) throw new Error('Dependency audit service is unavailable; check the saved report and rerun')
console.log('Dependency audit:', JSON.stringify(report.metadata.vulnerabilities))
if (code === 1 && await coversPatchedPicomatch(report)) {
  console.log(`Verified the installed patch for ${advisoryUrl}. The unmodified npm audit report is available in the security artifact.`)
} else {
  process.exitCode = code === 0 ? 0 : 1
}
