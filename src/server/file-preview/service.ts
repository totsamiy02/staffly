import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import { ApiError } from '../api-error.ts'
import { fileExtension } from '../../app/file-preview/formats.ts'
import { LEGACY_PREVIEW_MIME, SHEET_PREVIEW_MIME } from '../../app/file-preview/types.ts'
import { MAX_DOCUMENT_BYTES } from '../documents/file-validation.ts'
import { runProcess } from './process.ts'

export type PreparedPreview = { bytes: Buffer; mime: string }
const CACHE_BYTES = 64 * 1024 * 1024, MAX_RESULT = 40 * 1024 * 1024, TTL = 10 * 60_000
// Include the parser revision so prepared output never crosses incompatible rendering changes.
const PREVIEW_REVISION = 'ooxml-namespaces-1'
const cache = new Map<string, PreparedPreview & { expires: number }>()
const pending = new Map<string, Promise<PreparedPreview>>()
let cacheSize = 0, running = 0
const waiting: Array<() => void> = []
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= 2) {
    if (waiting.length >= 8) throw new ApiError(503, 'PREVIEW_BUSY', 'Сервис просмотра занят. Повторите попытку немного позже.')
    await new Promise<void>(resolve => waiting.push(resolve))
  } else running++
  try { return await run() } finally { const next = waiting.shift(); if (next) next(); else running-- }
}
export async function readPreviewSource(stream: Readable, maximum = MAX_DOCUMENT_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  try { for await (const chunk of stream) { const data = Buffer.from(chunk); size += data.length; if (size > maximum) throw new ApiError(413, 'PREVIEW_TOO_LARGE', 'Файл слишком велик для просмотра.'); chunks.push(data) } } finally { stream.destroy() }
  return Buffer.concat(chunks)
}
export function needsPreparedPreview(name: string) { return ['doc', 'xls', 'xlsx', 'ppt', 'csv'].includes(fileExtension(name)) }
/** Auth belongs to the caller: authorize BEFORE this function and recheck AFTER await, including cache hits. */
export async function preparePreview(bytes: Buffer, name: string, organizationId: string): Promise<PreparedPreview> {
  const extension = fileExtension(name)
  const key = createHash('sha256').update(PREVIEW_REVISION).update(organizationId).update(extension).update(bytes).digest('hex')
  for (const [id, entry] of cache) if (entry.expires < Date.now()) { cacheSize -= entry.bytes.length; cache.delete(id) }
  const found = cache.get(key)
  if (found) { cache.delete(key); cache.set(key, found); return found }
  const active = pending.get(key); if (active) return active
  const promise = slot(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'staffly-preview-'))
    try {
      await writeFile(join(directory, `source.${extension}`), bytes, { mode: 0o600 })
      const table = ['xls', 'xlsx', 'csv'].includes(extension)
      const output = join(directory, 'preview.json')
      const mime = table ? SHEET_PREVIEW_MIME : LEGACY_PREVIEW_MIME
      await runProcess(process.execPath, ['--max-old-space-size=384', '--import', fileURLToPath(import.meta.resolve('tsx')), fileURLToPath(new URL('./workbook-worker.ts', import.meta.url)), join(directory, `source.${extension}`), output, extension], directory, 30_000)
      if ((await stat(output)).size > MAX_RESULT) throw new ApiError(413, 'PREVIEW_TOO_LARGE', 'Результат слишком велик для предпросмотра. Скачайте оригинал.')
      const result = { bytes: await readFile(output), mime }
      while (cacheSize + result.bytes.length > CACHE_BYTES && cache.size) { const id = cache.keys().next().value!; cacheSize -= cache.get(id)!.bytes.length; cache.delete(id) }
      cache.set(key, { ...result, expires: Date.now() + TTL }); cacheSize += result.bytes.length
      return result
    } catch (error) {
      if (error instanceof ApiError) throw error
      // Do not expose filesystem paths or converter diagnostics to clients.
      const message = error instanceof Error && error.message.startsWith('Таблица слишком велика') ? error.message : 'Не удалось подготовить просмотр. Файл может быть повреждён, защищён паролем или содержать неподдерживаемые элементы.'
      throw new ApiError(422, 'PREVIEW_FAILED', message)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  pending.set(key, promise)
  try { return await promise } finally { pending.delete(key) }
}
