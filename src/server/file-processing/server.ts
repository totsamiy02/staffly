import { createServer } from 'node:http'
import { chmod, unlink } from 'node:fs/promises'
import { MAX_PROCESSING_INPUT, runFileProcessor, validOperation } from './runner.ts'
import { ApiError } from '../api-error.ts'

const socket = process.env.FILE_PROCESSOR_SOCKET || '/run/file-processor/processor.sock'
await unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error })
let receiving = 0
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return }
  const [, operation, kind] = /^\/([a-z]+)\/([a-z]+)$/.exec(req.url ?? '') ?? []
  if (req.method !== 'POST' || !validOperation(operation, kind)) { res.writeHead(404).end(); return }
  if (receiving >= 2) { res.writeHead(503).end(); return }
  receiving++
  try {
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_PROCESSING_INPUT) { res.writeHead(413).end(); req.destroy(); return }
      chunks.push(chunk)
    }
    const output = await runFileProcessor(operation, kind, Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': output.length }).end(output)
  } catch (error) { if (!res.destroyed) res.writeHead(error instanceof ApiError ? error.status : 500).end() }
  finally { receiving-- }
})
server.requestTimeout = 40_000
server.headersTimeout = 5000
server.listen(socket, async () => { await chmod(socket, 0o600) })
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(); server.closeAllConnections(); setTimeout(() => process.exit(), 35_000).unref() })
