import { spawn } from 'node:child_process'
import { existsSync, readFileSync, watch } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const watched = ['src/server', 'src/shared', 'src/app/access', 'src/app/requests', 'src/app/schedule', 'src/app/notifications', 'src/app/file-preview', 'src/app/subscriptions']
let child, timer, childShutdownMs = 30000, restarting = false, dirty = false, stopping = false
const watchers = []

function launch() {
  const configured = process.env.HTTP_SHUTDOWN_TIMEOUT_MS ?? parseEnv(readFileSync(path.join(root, 'src/server/.env'), 'utf8')).HTTP_SHUTDOWN_TIMEOUT_MS
  const timeout = configured === undefined || configured === '' ? 30000 : Number(configured)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('HTTP_SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 120000')
  childShutdownMs = timeout
  child = spawn(process.execPath, ['--env-file=src/server/.env', '--import', 'tsx', 'src/server/index.ts'], { cwd: root, env: { ...process.env, NODE_ENV: 'development', HTTP_SHUTDOWN_TIMEOUT_MS: String(timeout) }, stdio: 'inherit' })
  child.on('error', error => { console.error('Не удалось запустить API:', error.message) })
  child.on('exit', () => { child = undefined })
}
async function stopChild() {
  const active = child
  if (!active || active.exitCode !== null || active.signalCode !== null) return
  await new Promise(resolve => {
    const force = setTimeout(() => active.kill('SIGKILL'), childShutdownMs + 5000)
    active.once('exit', () => { clearTimeout(force); resolve() })
    active.kill('SIGTERM')
  })
}
async function restart() {
  if (stopping || restarting) return
  restarting = true; dirty = false
  console.log('API: обновляем сервер после изменений…')
  await stopChild()
  if (!stopping) launch()
  restarting = false
  if (dirty) schedule()
}
function schedule() {
  if (stopping) return
  dirty = true; clearTimeout(timer)
  timer = setTimeout(() => { void restart() }, 700)
}
for (const directory of watched.filter(directory => existsSync(path.join(root, directory)))) watchers.push(watch(path.join(root, directory), { recursive: true }, (_event, name) => {
  const file = String(name ?? '')
  if (!file.endsWith('.ts') || /(?:^|\/)(?:generated|node_modules)\//.test(file)) return
  schedule()
}))
watchers.push(watch(path.join(root, 'src/server/.env'), schedule))
async function stop() {
  if (stopping) return
  stopping = true; clearTimeout(timer); watchers.forEach(watcher => watcher.close())
  await stopChild()
}
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
launch()
