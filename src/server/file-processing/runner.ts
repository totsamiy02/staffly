import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ApiError } from '../api-error.ts'

export const MAX_PROCESSING_INPUT = 100 * 1024 * 1024
export const MAX_PROCESSING_OUTPUT = 32 * 1024 * 1024
export type FileOperation = 'office' | 'image' | 'avatar' | 'preview'
const kinds = { office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'], image: ['jpeg', 'png', 'webp'], avatar: ['auto'], preview: ['doc', 'xls', 'xlsx', 'ppt', 'csv'] }
export function validOperation(operation: string, kind: string): operation is FileOperation {
  return Object.hasOwn(kinds, operation) && kinds[operation as FileOperation].includes(kind)
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
export function parserArguments(entry: string, args: string[] = [], addons = false) {
  const readable = ['node_modules', 'package.json', 'src/server/file-processing', 'src/server/file-preview', 'src/server/documents/office-validation.ts', 'src/server/api-error.ts', 'src/app/file-preview']
  return ['--permission', '--disable-proto=throw', '--max-old-space-size=384', ...readable.map(item => `--allow-fs-read=${path.join(root, item)}`),
    ...(addons ? ['--allow-addons'] : []), entry, ...args]
}
let active = 0
export function runFileProcessor(operation: FileOperation, kind: string, bytes: Buffer): Promise<Buffer> {
  if (!validOperation(operation, kind) || !bytes.length || bytes.length > MAX_PROCESSING_INPUT) return Promise.reject(new ApiError(415, 'INVALID_DOCUMENT_FILE', 'Недопустимый файл.'))
  if (active >= 2) return Promise.reject(new ApiError(503, 'FILE_VALIDATION_BUSY', 'Сервис обработки файлов занят. Повторите попытку позже.'))
  active++
  return new Promise((resolve, reject) => {
    // Native TS stripping needs no loader, worker permission or subprocess access.
    // In production this runs inside a separate container with no network/secrets.
    const child = spawn(process.execPath, parserArguments(fileURLToPath(new URL('./child.ts', import.meta.url)), [operation, kind], operation === 'image' || operation === 'avatar'), {
      cwd: root, env: { LANG: 'C', UV_THREADPOOL_SIZE: '2', VIPS_CONCURRENCY: '1' }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []; let size = 0, timedOut = false, oversized = false, failure: Error | undefined
    const kill = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { child.kill('SIGKILL') } }
    const timer = setTimeout(() => { timedOut = true; kill() }, operation === 'preview' ? 30_000 : 8000)
    child.once('error', error => { failure = error })
    child.stdin.on('error', () => { /* Invalid input may be rejected before EOF. */ })
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_PROCESSING_OUTPUT) { oversized = true; kill() } else chunks.push(chunk) })
    child.once('close', code => {
      clearTimeout(timer); active--
      if (failure) reject(new ApiError(503, 'FILE_PROCESSOR_UNAVAILABLE', 'Обработка файлов временно недоступна.'))
      else if (timedOut) reject(new ApiError(422, 'FILE_VALIDATION_TIMEOUT', 'Обработка файла заняла слишком много времени.'))
      else if (oversized || code !== 0) reject(new ApiError(415, 'INVALID_DOCUMENT_FILE', 'Файл повреждён или содержит неподдерживаемые элементы.'))
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(bytes)
  })
}
