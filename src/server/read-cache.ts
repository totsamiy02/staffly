type Entry = { organizationId: string; expires: number; bytes: number; promise: Promise<unknown> }
// Cache source data only: authorization and user-specific redaction stay outside.
export class ReadCache {
  private entries = new Map<string, Entry>()
  private bytes = 0
  private maximum: number
  constructor(maximum = 32 * 1024 * 1024) { this.maximum = maximum }
  invalidate(organizationId?: string) {
    for (const [key, entry] of this.entries) if (!organizationId || entry.organizationId === organizationId) this.remove(key, entry)
  }
  invalidateForHint(hint: { topic: string; organizationId?: string }) {
    // Only calendar source data is cached. Request approval changes shifts or
    // absences in the same transaction and emits its own schedule hint. Personal
    // notifications and export completion must not evict every calendar.
    if (['requests', 'requests-mine', 'requests-review', 'notifications', 'exports', 'documents', 'events'].includes(hint.topic)) return
    this.invalidate(hint.organizationId)
  }
  private remove(key: string, entry: Entry) { if (this.entries.delete(key)) this.bytes -= entry.bytes }
  async read<T>(organizationId: string, key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key)
    if (cached && cached.expires > Date.now()) return cached.promise as Promise<T>
    if (cached) this.remove(key, cached)
    while (this.entries.size >= 500 || this.bytes >= this.maximum) {
      const first = this.entries.entries().next().value
      if (!first) break
      this.remove(...first)
    }
    const entry: Entry = { organizationId, expires: Date.now() + 2000, bytes: 0, promise: Promise.resolve() }
    this.entries.set(key, entry)
    entry.promise = load().then(value => {
      if (this.entries.get(key) === entry) {
        // Date-heavy calendar rows are expensive to JSON.stringify only for
        // accounting. Native serialization keeps dates binary; use a conservative
        // multiplier for the in-memory object graph, without changing the value.
        const bytes = Math.max(64, serialize(value).byteLength * 2)
        if (bytes > this.maximum || this.bytes + bytes > this.maximum) this.remove(key, entry)
        else { entry.bytes = bytes; this.bytes += bytes }
      }
      return value
    }, error => { if (this.entries.get(key) === entry) this.remove(key, entry); throw error })
    return entry.promise as Promise<T>
  }
}
export const readCache = new ReadCache()
let connected = false
export function setReadCacheLive(value: boolean) { connected = value; if (!value) readCache.invalidate() }
export function cachedRead<T>(organizationId: string, key: string, load: () => Promise<T>) {
  return connected ? readCache.read(organizationId, key, load) : load()
}
import { serialize } from 'node:v8'

