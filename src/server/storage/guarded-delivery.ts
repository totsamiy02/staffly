import { Readable } from 'node:stream'
import { requestReads } from '../request-read-context.ts'
import { locationContext } from '../organizations/location-context.ts'

// Preserve the selected tenant/point, but never the request's earlier role snapshot.
export function freshFileAccess<T>(work: () => Promise<T>): Promise<T> {
  const context = locationContext.getStore()
  return requestReads.run(new Map(), () => context ? locationContext.run({ ...context, memberships: new Map() }, work) : work())
}

export function guardFileStream(source: Readable, authorize: () => Promise<unknown>) {
  // Storage may fail while an authorization query is still pending. The async
  // iterator will propagate the stored stream error when consumption starts.
  source.on('error', () => {})
  const guarded = Readable.from((async function* () {
    let checkedAt = 0, sinceCheck = 0
    try {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk)
        // Recheck after storage I/O and while streaming, with bounded DB overhead.
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          if (!checkedAt || Date.now() - checkedAt >= 250 || sinceCheck >= 1024 * 1024) {
            await freshFileAccess(authorize); checkedAt = Date.now(); sinceCheck = 0
          }
          const part = bytes.subarray(offset, offset + 64 * 1024)
          sinceCheck += part.length
          yield part
        }
      }
    } finally { source.destroy() }
  })(), { objectMode: false, highWaterMark: 64 * 1024 })
  guarded.once('close', () => source.destroy())
  return guarded
}
