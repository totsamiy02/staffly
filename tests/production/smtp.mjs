import { createServer } from 'node:tls'
import { readFileSync } from 'node:fs'

// Private TLS-only test sink: accept mail, discard its contents and log no secrets.
const server = createServer({ key: readFileSync('/run/audit/key.pem'), cert: readFileSync('/run/audit/cert.pem') }, socket => {
  socket.setEncoding('utf8'); socket.setTimeout(15000, () => socket.destroy())
  let pending = '', data = false, auth = 0
  socket.write('220 smtp audit ESMTP\r\n')
  socket.on('error', () => {})
  socket.on('data', chunk => {
    pending += chunk
    if (pending.length > 2 * 1024 * 1024) { socket.destroy(); return }
    let end
    while ((end = pending.indexOf('\r\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 2)
      if (data) { if (line === '.') { data = false; socket.write('250 queued\r\n'); console.log('audit-mail-accepted') }; continue }
      if (auth) { auth--; socket.write(auth ? '334 UGFzc3dvcmQ6\r\n' : '235 authenticated\r\n'); continue }
      if (/^EHLO|^HELO/.test(line)) socket.write('250-smtp\r\n250 AUTH PLAIN LOGIN\r\n')
      else if (/^AUTH LOGIN/.test(line)) { auth = 2; socket.write('334 VXNlcm5hbWU6\r\n') }
      else if (/^AUTH PLAIN/.test(line)) socket.write('235 authenticated\r\n')
      else if (line === 'DATA') { data = true; socket.write('354 continue\r\n') }
      else if (line === 'QUIT') socket.end('221 bye\r\n')
      else socket.write('250 ok\r\n')
    }
  })
})
server.on('tlsClientError', () => {})
server.listen(465, '0.0.0.0', () => console.log('audit-smtp-ready'))
process.once('SIGTERM', () => { server.close(); setTimeout(() => process.exit(), 1000).unref() })
