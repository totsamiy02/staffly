import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// A fresh, disposable storage root per run: tests must never write user storage.
const storageRoot = await mkdtemp(path.join(tmpdir(), 'staffly-tests-'))
try {
  const files = (await readdir('tests', { recursive: true })).filter(file => file.endsWith('.test.ts')).map(file => path.join('tests', file))
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', LOCAL_STORAGE_ROOT: storageRoot } })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))) })
  process.exitCode = code
} finally {
  await rm(storageRoot, { recursive: true, force: true })
}
