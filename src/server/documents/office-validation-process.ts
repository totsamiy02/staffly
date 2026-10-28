import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ApiError } from '../api-error.ts'

let active = 0
export function validateOfficeIsolated(contents: Buffer, extension: string) {
  if (active >= 2) return Promise.reject(new ApiError(503, 'FILE_VALIDATION_BUSY', 'Сервис проверки файлов занят. Повторите загрузку позже.'))
  active++
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=192', '--import', 'tsx', fileURLToPath(new URL('./office-validation-child.ts', import.meta.url)), extension], {
      stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: process.env.PATH, LANG: 'C' },
    })
    let timedOut = false, spawnError: Error | undefined
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 8000)
    child.once('error', error => { spawnError = error })
    child.stdin.on('error', () => { /* The bounded parser can exit before consuming invalid bytes. */ })
    child.once('close', code => {
      clearTimeout(timer); active--
      if (spawnError) reject(spawnError)
      else if (timedOut) reject(new ApiError(422, 'FILE_VALIDATION_TIMEOUT', 'Проверка файла заняла слишком много времени. Уменьшите размер файла.'))
      else if (code !== 0) reject(new ApiError(415, 'INVALID_DOCUMENT_FILE', 'Недопустимое содержимое Office-файла.'))
      else resolve()
    })
    child.stdin.end(contents)
  })
}
