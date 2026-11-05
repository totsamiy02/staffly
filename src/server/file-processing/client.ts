import { request } from 'node:http'
import { ApiError } from '../api-error.ts'
import { MAX_PROCESSING_OUTPUT, runFileProcessor, type FileOperation } from './runner.ts'

export async function processFile(operation: FileOperation, kind: string, bytes: Buffer): Promise<Buffer> {
  const socketPath = process.env.FILE_PROCESSOR_SOCKET
  if (!socketPath) {
    if (process.env.NODE_ENV === 'production') throw new ApiError(503, 'FILE_PROCESSOR_UNAVAILABLE', 'Обработка файлов временно недоступна.')
    return runFileProcessor(operation, kind, bytes)
  }
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/${operation}/${kind}`, method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }, signal: AbortSignal.timeout(35_000) }, res => {
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_PROCESSING_OUTPUT) res.destroy(new Error('Output limit')); else chunks.push(chunk) })
      res.once('error', () => reject(new ApiError(503, 'FILE_PROCESSOR_UNAVAILABLE', 'Обработка файлов временно недоступна.')))
      res.once('end', () => {
        if (res.statusCode === 200) resolve(Buffer.concat(chunks))
        else if (res.statusCode === 503) reject(new ApiError(503, 'FILE_VALIDATION_BUSY', 'Сервис обработки файлов занят. Повторите попытку позже.'))
        else if (res.statusCode === 422) reject(new ApiError(422, 'FILE_VALIDATION_TIMEOUT', 'Обработка файла заняла слишком много времени.'))
        else if (res.statusCode === 413) reject(new ApiError(413, 'FILE_PROCESSING_TOO_LARGE', 'Файл превышает допустимый размер.'))
        else if (res.statusCode === 415) reject(new ApiError(415, 'INVALID_DOCUMENT_FILE', 'Файл повреждён или содержит неподдерживаемые элементы.'))
        else reject(new ApiError(503, 'FILE_PROCESSOR_UNAVAILABLE', 'Обработка файлов временно недоступна.'))
      })
    })
    req.once('error', () => reject(new ApiError(503, 'FILE_PROCESSOR_UNAVAILABLE', 'Обработка файлов временно недоступна.')))
    req.end(bytes)
  })
}
