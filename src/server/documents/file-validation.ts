/* oxlint-disable eslint/no-control-regex -- File validation deliberately rejects control bytes. */
import { validateOfficeIsolated } from './office-validation-process.ts'
import sharp from 'sharp'
import { ApiError } from '../api-error.ts'

const configuredLimit = Number(process.env.DOCUMENT_MAX_BYTES ?? 25 * 1024 * 1024)
if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 100 * 1024 * 1024) throw new Error('DOCUMENT_MAX_BYTES must be between 1 and 104857600')
export const MAX_DOCUMENT_BYTES = configuredLimit
export { documentMimeTypes } from '../../app/file-preview/formats.ts'
import { documentMimeTypes } from '../../app/file-preview/formats.ts'
function invalid(): never { throw new ApiError(415, 'INVALID_DOCUMENT_FILE', 'Формат, расширение и содержимое файла должны совпадать. Исполняемые файлы, архивы и активные форматы запрещены.') }

export async function validateDocumentFile(input: unknown, mime: string, encodedName: string | undefined) {
  if (!Buffer.isBuffer(input) || !input.length) throw new ApiError(400, 'EMPTY_DOCUMENT', 'Выберите файл.')
  if (input.length > MAX_DOCUMENT_BYTES) throw new ApiError(413, 'DOCUMENT_TOO_LARGE', `Файл должен весить не больше ${Math.ceil(MAX_DOCUMENT_BYTES / 1024 / 1024)} МБ.`)
  let name: string
  try { name = decodeURIComponent(encodedName ?? '') } catch { invalid() }
  if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name) || name.startsWith('.')) invalid()
  const ext = name.split('.').at(-1)?.toLowerCase() as keyof typeof documentMimeTypes
  const canonical = documentMimeTypes[ext]
  if (!canonical || mime !== canonical && !(ext === 'md' && ['text/plain', 'text/x-markdown'].includes(mime))) invalid()
  const contents = input
  if (ext === 'pdf') { if (!contents.subarray(0, 5).equals(Buffer.from('%PDF-')) || !contents.subarray(-2048).includes(Buffer.from('%%EOF'))) invalid() }
  else if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    try { const image = sharp(contents, { failOn: 'error', limitInputPixels: 25_000_000 }); const metadata = await image.metadata(); if (metadata.format !== (ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext) || (metadata.pages ?? 1) > 1) invalid(); await image.raw().toBuffer() } catch { invalid() }
  } else if (['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(ext)) await validateOfficeIsolated(contents, ext)
  else {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents) } catch { invalid() }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /^\s*(?:<!doctype\s+html|<html|<svg|<script|#!)/i.test(text)) invalid()
  }
  return { contents, fileName: name.trim(), extension: ext === 'jpeg' ? 'jpg' : ext, mimeType: canonical }
}
export function supportsPreview(mime: string, size: number) { return size > 0 && size <= MAX_DOCUMENT_BYTES && (Object.values(documentMimeTypes) as string[]).includes(mime) }
