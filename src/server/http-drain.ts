import type { Server } from 'node:http'

/** Start closing the listener synchronously; admitted responses can finish. */
export function drainHttpServer(server: Server) {
  const closed = new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeIdleConnections()
  })
  return closed
}
