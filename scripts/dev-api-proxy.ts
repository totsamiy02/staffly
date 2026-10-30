import { request as httpRequest } from 'node:http'
import type { Plugin } from 'vite'

// Development only. A restart returns a retryable JSON response; mutation
// requests are never buffered or replayed by the proxy.
export function devApiProxy(port = 3001): Plugin {
  return { name: 'staffly-dev-api', configureServer(server) {
    server.middlewares.use('/api', (request, response) => {
      const upstream = httpRequest({ hostname: '127.0.0.1', port, path: '/api' + request.url, method: request.method, headers: request.headers }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers)
        result.on('error', () => response.destroy())
        result.pipe(response)
      })
      response.on('close', () => upstream.destroy())
      upstream.on('error', (error: NodeJS.ErrnoException) => {
        if (response.headersSent) { response.destroy(); return }
        if (!['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code ?? '')) server.config.logger.error(`API proxy: ${error.code ?? error.message}`)
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '1' })
        response.end(JSON.stringify({ code: 'API_UNAVAILABLE', message: 'Сервис временно недоступен. Подождите немного и повторите действие.' }))
      })
      request.pipe(upstream)
    })
  } }
}
