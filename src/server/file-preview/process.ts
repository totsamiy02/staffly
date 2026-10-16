import { spawn } from 'node:child_process'
import { ApiError } from '../api-error.ts'

export async function runProcess(command: string, args: string[], cwd: string, timeout = 60_000) {
  return new Promise<void>((resolveRun, reject) => {
    // No shell, API credentials, database URL, cookies or tokens are passed to parsers.
    const child = spawn(command, args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', HOME: cwd, TMPDIR: cwd } })
    let stderr = '', timedOut = false
    child.stderr.on('data', (part: Buffer) => { if (stderr.length < 2000) stderr += part.toString().slice(0, 2000 - stderr.length) })
    const timer = setTimeout(() => {
      timedOut = true
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { child.kill('SIGKILL') }
    }, timeout)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); if (timedOut) reject(new ApiError(504, 'PREVIEW_TIMEOUT', 'Подготовка просмотра заняла слишком много времени. Попробуйте файл меньшего размера.')); else if (code !== 0) reject(new Error(stderr || 'Не удалось преобразовать файл.')); else resolveRun() })
  })
}
