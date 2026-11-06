import { readFile, readdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'

// Test-only Linux fault injection. Pause the actual renderer, then release it
// after the worker has delivered SIGTERM, so shutdown is exercised mid-export.
assert.ok(process.platform === 'linux' && existsSync('/.dockerenv'), 'Fault injection must run inside the disposable Linux container')
await writeFile('/tmp/audit-renderer-ready','ready')
let renderer
try {
  const deadline = Date.now()+20000
  while (!renderer && Date.now()<deadline) {
    for (const id of await readdir('/proc')) {
      if (!/^\d+$/.test(id)) continue
      const command = await readFile('/proc/'+id+'/cmdline','utf8').catch(()=>'')
      if (command.includes('/schedule/reports/export-child.ts')) { renderer=Number(id); break }
    }
    if (!renderer) await delay(10)
  }
  if (!renderer) throw new Error('Renderer did not start')
  process.kill(renderer,'SIGSTOP')
  await writeFile('/tmp/audit-renderer-paused',String(renderer))
  const deadlineTerm = Date.now()+10000
  while (Date.now()<deadlineTerm) {
    const status = await readFile('/proc/'+renderer+'/status','utf8')
    const signals = [...status.matchAll(/^(?:SigPnd|ShdPnd):\s*([a-f0-9]+)/gm)]
    if (signals.some(match => (BigInt('0x'+match[1]) & (1n<<14n)) !== 0n)) break
    await delay(10)
  }
} finally {
  if (renderer) { try { process.kill(renderer,'SIGCONT') } catch { /* Container/process already stopped. */ } }
}
